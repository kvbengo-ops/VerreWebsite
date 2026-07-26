import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const client = resolve(dist, "client");
const server = resolve(dist, "server");

// Keep an active local `wrangler dev` session from locking the output
// directory on Windows. Every owned output is overwritten below.
await rm(resolve(server, "catalog.js"), { force: true });
await mkdir(resolve(client, "assets"), { recursive: true });
await mkdir(server, { recursive: true });

const page = await readFile(resolve(root, "index.html"), "utf8");
await writeFile(resolve(client, "index.html"), page);
await cp(resolve(root, "support.js"), resolve(client, "support.js"));
await cp(
  resolve(root, "assets", "verre-photo-atlas.png"),
  resolve(client, "assets", "verre-photo-atlas.png")
);
await cp(resolve(root, "admin"), resolve(client, "admin"), { recursive: true });
await cp(resolve(root, "pos"), resolve(client, "pos"), { recursive: true });

// The Worker lives in src/. Copy the whole tree rather than naming each module —
// a per-file list silently drops every new import until the deploy fails.
// Tests stay behind; worker.js becomes index.js because that is the entrypoint
// both wrangler.toml and .openai/hosting.json expect.
await cp(resolve(root, "src"), server, {
  recursive: true,
  filter: (path) => !path.endsWith(".test.mjs") && !path.endsWith("worker.js")
});
await cp(resolve(root, "src", "worker.js"), resolve(server, "index.js"));
