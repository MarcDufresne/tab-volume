import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extension/icons");
const COLOR = [59, 130, 246];
const WAVE_HALF_ANGLE = (50 * Math.PI) / 180;

function inside(x, y) {
  const dy = Math.abs(y - 0.5);
  if (x >= 0.1 && x <= 0.3 && dy <= 0.13) return true;
  if (x >= 0.3 && x <= 0.52 && dy <= 0.13 + ((x - 0.3) / 0.22) * 0.24) return true;
  const r = Math.hypot(x - 0.52, y - 0.5);
  const inWedge = x > 0.52 && Math.atan2(dy, x - 0.52) <= WAVE_HALF_ANGLE;
  return inWedge && ((r >= 0.16 && r <= 0.23) || (r >= 0.31 && r <= 0.38));
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const SS = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) if (inside((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)) hits++;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = COLOR[0]; raw[o + 1] = COLOR[1]; raw[o + 2] = COLOR[2];
      raw[o + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

for (const size of [16, 32, 48, 128]) writeFileSync(path.join(OUT, `icon-${size}.png`), png(size));
