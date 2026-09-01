import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "apps", "web");
const output = path.join(root, "apps", "desktop", "dist");

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "data"), { recursive: true });
for (const asset of [
  "index.html",
  "app.js",
  "desktop-bridge.js",
  "run-delta.js",
  "time-travel.js",
  "timeline-index.js",
  "timeline-pages.js",
  "playback-speed.js",
  "runtime-diagnostics.js",
  "runtime-registry.js",
  "generated-runtime-registry.js",
  "styles.css",
]) {
  await cp(path.join(web, asset), path.join(output, asset), { force: true });
}
await cp(path.join(web, "public", "run-snapshot.json"), path.join(output, "run-snapshot.json"));
await cp(
  path.join(web, "public", "data", "run-catalog.json"),
  path.join(output, "data", "run-catalog.json"),
);
await cp(path.join(web, "public", "data", "runs"), path.join(output, "data", "runs"), {
  recursive: true,
});

console.log(`Prepared desktop frontend at ${output}`);
