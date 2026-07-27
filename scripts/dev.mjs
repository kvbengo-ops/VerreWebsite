#!/usr/bin/env node
/**
 * One command for local development: `npm run dev`.
 *
 * wrangler.toml points at dist/ — `main = dist/server/index.js` and
 * `[assets] directory = dist/client` — so wrangler only ever serves build
 * output. Editing index.html or src/ changes nothing on screen until the build
 * runs, which is why every change felt like it needed a manual rebuild and a
 * restart. It did.
 *
 * This watches the sources, rebuilds on change, and leaves wrangler running.
 * The rebuild rewrites dist/server/index.js, which wrangler notices and
 * reloads on its own — so no restart, just a save and a refresh.
 *
 * Pointing wrangler at the source tree instead would be simpler and is a trap:
 * [assets] serves everything under its directory, and the repo root holds
 * .dev.vars. That would publish the service role key on localhost.
 */
import { spawn } from 'node:child_process';
import { watch, existsSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Deliberately explicit. Watching the root would pick up dist/ and rebuild in
// response to its own output, forever.
const WATCHED = ['src', 'admin', 'pos', 'login', 'assets', 'index.html', 'support.js', 'scripts/build.mjs'];

const stamp = () => new Date().toLocaleTimeString('en-PH', { hour12: false });
const log = (message) => console.log(`\x1b[35m[dev ${stamp()}]\x1b[0m ${message}`);

function build() {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve(root, 'scripts', 'build.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('close', (code) => {
      // A failed build must not stop the watcher. You fix the file, save, and it
      // tries again — killing the loop on every typo would be its own annoyance.
      if (code !== 0) log('\x1b[31mbuild failed\x1b[0m\n' + error.trim());
      done(code === 0);
    });
  });
}

log('building…');
if (!(await build())) log('starting anyway — fix the error and save to retry');

const wrangler = spawn('npx', ['wrangler', 'dev'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

// Editors write in bursts — a save can fire several events. Coalesce them, or
// one keystroke triggers three builds.
let pending = null;
let building = false;
let again = false;

async function rebuild(reason) {
  if (building) { again = true; return; }
  building = true;
  log('rebuilding — ' + reason);
  const ok = await build();
  building = false;
  if (ok) log('\x1b[32mready\x1b[0m — wrangler reloads itself; refresh the page');
  if (again) { again = false; rebuild('queued changes'); }
}

for (const target of WATCHED) {
  const path = resolve(root, target);
  if (!existsSync(path)) continue;
  // Watching a single file still reports its own name, so joining it onto the
  // path gives "index.html/index.html". Only directories need joining.
  const isDir = statSync(path).isDirectory();
  try {
    watch(path, { recursive: isDir }, (_event, file) => {
      const changed = isDir && file ? relative(root, resolve(path, file)) : target;
      if (changed.includes('node_modules') || changed.startsWith('dist')) return;
      clearTimeout(pending);
      pending = setTimeout(() => rebuild(changed), 120);
    });
  } catch (error) {
    // Recursive watching is unsupported on some platforms. Say so rather than
    // silently watching nothing and looking like the rebuild is broken.
    log(`\x1b[33mcould not watch ${target}\x1b[0m (${error.code}) — rebuild manually with npm run build`);
  }
}

log('watching ' + WATCHED.join(', '));
log('\x1b[33mwrangler.toml is read once at startup\x1b[0m — restart this command if you change it');

const stop = () => { wrangler.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
wrangler.on('close', (code) => process.exit(code ?? 0));
