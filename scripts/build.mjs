import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const client = resolve(dist, "client");
const server = resolve(dist, "server");

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(client, "assets"), { recursive: true });
await mkdir(server, { recursive: true });

const page = await readFile(resolve(root, "index.html"), "utf8");
await writeFile(resolve(client, "index.html"), page);
await cp(resolve(root, "support.js"), resolve(client, "support.js"));
await cp(
  resolve(root, "assets", "verre-photo-atlas.png"),
  resolve(client, "assets", "verre-photo-atlas.png")
);

// The Worker lives in src/ now. Copy it plus its imports; wrangler bundles them.
await cp(resolve(root, "src", "worker.js"), resolve(server, "index.js"));
await cp(resolve(root, "src", "catalog.js"), resolve(server, "catalog.js"));
