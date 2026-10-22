import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

function toneWav(seconds = 2, freq = 440, rate = 44100) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 16000), 44 + i * 2);
  return buf;
}

const TONE = toneWav();

function mediaPage(params) {
  const autoplay = params.has("autoplay") ? '<audio id="auto" src="/tone.wav" autoplay></audio>' : "";
  const iframe = params.get("iframe") ? `<iframe id="frame" src="${params.get("iframe")}" allow="autoplay"></iframe>` : "";
  const dsd = params.has("dsd")
    ? `<div id="host"><template shadowrootmode="open"><audio id="dsd" src="/tone.wav" autoplay></audio></template></div>
<script>{ const a = document.getElementById("host").shadowRoot.querySelector("audio"); a.addEventListener("playing", () => { window.__dsdNative = window.__native(a); }); }</script>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>media</title></head><body>${autoplay}${iframe}${dsd}</body></html>`;
}

export function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/tone.wav") {
      res.writeHead(200, { "content-type": "audio/wav", "content-length": TONE.length, "accept-ranges": "none" });
      return res.end(TONE);
    }
    if (url.pathname === "/media.html") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(mediaPage(url.searchParams));
    }
    try {
      const body = await readFile(path.join(DIR, path.normalize(url.pathname)));
      res.writeHead(200, { "content-type": url.pathname.endsWith(".html") ? "text/html" : "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ port, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
