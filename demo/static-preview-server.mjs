import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { parseArgs } from "./hop-demo-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const rootDir = path.resolve(args.root || process.cwd());
const port = Number(args.port || 43110);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

const server = http.createServer((req, res) => {
  const requestPath = req.url === "/" ? "/index.html" : String(req.url || "/index.html").split("?")[0];
  const fullPath = path.resolve(path.join(rootDir, `.${requestPath}`));
  if (!fullPath.startsWith(rootDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(fullPath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  fs.createReadStream(fullPath).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`listening ${port}\n`);
});
