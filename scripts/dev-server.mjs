import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(fileURLToPath(new URL("..", import.meta.url)));
const webRoot = resolve(workspace, "apps/web");
const publicRoot = resolve(webRoot, "public");
const port = Number.parseInt(process.env.PORT ?? "4173", 10);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const candidates = [resolve(webRoot, `.${relative}`), resolve(publicRoot, `.${relative}`)];
    const path = await firstFile(candidates);
    if (!path) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const content = await readFile(path);
    response.writeHead(200, {
      "content-type": mime[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(content);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(String(error));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Orchetrace web UI: http://127.0.0.1:${port}`);
});

async function firstFile(candidates) {
  for (const candidate of candidates) {
    if (!candidate.startsWith(webRoot + sep)) continue;
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next root.
    }
  }
  return null;
}
