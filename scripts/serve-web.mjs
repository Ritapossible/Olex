/**
 * Minimal static file server for the audit, so the suite does not depend on
 * python being installed. Serves web/ with cleanUrls semantics matching
 * vercel.json, so /docs resolves the same way it does in production.
 *
 * Exports startServer() for the audit to use in-process; running this file
 * directly serves on PORT (default 8080) for manual browsing.
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../web/", import.meta.url));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export function createStaticServer() {
  return http.createServer(async (req, res) => {
    // Collapse leading slashes first: "//docs.html" parses as protocol-relative,
    // which resolves to host "docs.html" and path "/", so the line below would
    // hand back index.html with a 200 and hide the real request.
    const target = req.url.replace(/^\/{2,}/, "/");
    let path = decodeURIComponent(new URL(target, "http://x").pathname);
    if (path.endsWith("/")) path += "index.html";
    // cleanUrls: /docs -> docs.html, matching vercel.json
    if (!extname(path)) path += ".html";

    const rel = normalize(path).replace(/^([/\\]|\.\.[/\\])+/, "");
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
}

/** Listen on an ephemeral port and resolve the base URL. */
export function startServer(port = 0) {
  const server = createStaticServer();
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

// Direct invocation: serve on a fixed port for manual browsing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { base } = await startServer(Number(process.env.PORT ?? 8080));
  console.log(`serving web/ on ${base}`);
}
