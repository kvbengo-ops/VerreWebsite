import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const client = resolve(dist, "client");
const server = resolve(dist, "server");

/**
 * Copy by writing content, never by fs.cp.
 *
 * fs.cp unlinks the destination before writing it, and unlink is the one
 * operation that fails here: `wrangler dev` holds dist/ open on Windows, so a
 * rebuild during a live session dies with EPERM and leaves a half-updated
 * build. That failure is quiet in the worst way — wrangler keeps serving the
 * previous Worker, so the code looks deployed and behaves as if nothing
 * changed. writeFile truncates in place instead, which locked files allow.
 */
async function copyFile(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, await readFile(from));
}

async function copyTree(from, to, skip = () => false) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    if (skip(source)) continue;
    if (entry.isDirectory()) await copyTree(source, join(to, entry.name), skip);
    else await copyFile(source, join(to, entry.name));
  }
}

// Best-effort: a stale module left behind by an older build. If it cannot be
// removed the build is still correct, so never fail on it.
await rm(resolve(server, "catalog.js"), { force: true }).catch(() => {});

await mkdir(resolve(client, "assets"), { recursive: true });
await mkdir(server, { recursive: true });

await copyFile(resolve(root, "index.html"), resolve(client, "index.html"));
await copyFile(resolve(root, "support.js"), resolve(client, "support.js"));
await copyTree(resolve(root, "assets"), resolve(client, "assets"));
await copyTree(resolve(root, "admin"), resolve(client, "admin"));
await copyTree(resolve(root, "pos"), resolve(client, "pos"));
// Public by design — it is the page you reach *because* you are not signed in.
// Deliberately absent from run_worker_first in wrangler.toml.
await copyTree(resolve(root, "login"), resolve(client, "login"));

// The Worker lives in src/. Copy the whole tree rather than naming each module —
// a per-file list silently drops every new import until the deploy fails.
// Tests stay behind; worker.js becomes index.js because that is the entrypoint
// both wrangler.toml and .openai/hosting.json expect.
await copyTree(
  resolve(root, "src"),
  server,
  (path) => path.endsWith(".test.mjs") || path.endsWith("worker.js")
);
await copyFile(resolve(root, "src", "worker.js"), resolve(server, "index.js"));

// Cheap tripwire for the failure this file exists to prevent: if the entrypoint
// on disk does not mention the login route, the copy silently did not happen
// and wrangler would keep serving the previous Worker.
const built = await readFile(resolve(server, "index.js"), "utf8");
if (!built.includes("/login")) {
  console.error("build: dist/server/index.js is stale — the copy did not apply.");
  process.exit(1);
}

console.log("build: ok");
