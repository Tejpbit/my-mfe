// Dependency-free PNG icon generator: renders the flag logo at the sizes
// the manifest and iOS home screen need.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw.writeUInt32BE(((r << 24) | (g << 16) | (b << 8) | a) >>> 0, row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const inTriangle = (px, py, [ax, ay], [bx, by], [cx, cy]) => {
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
};

function pixel(x, y, size) {
  const u = x / size, v = y / size;
  // background gradient
  let r = 13 + 9 * v, g = 17 + 10 * v, b = 23 + 18 * v;
  // subtle grid
  if ((x % Math.round(size / 8) === 0 || y % Math.round(size / 8) === 0) && size >= 128) {
    r += 6; g += 7; b += 9;
  }
  // pole
  if (u >= 0.365 && u <= 0.405 && v >= 0.20 && v <= 0.82) {
    return [230, 237, 243, 255];
  }
  // pennant (red, slight swallowtail)
  if (inTriangle(u, v, [0.405, 0.20], [0.78, 0.325], [0.405, 0.45]) &&
      !inTriangle(u, v, [0.78, 0.325], [0.66, 0.325], [0.78, 0.325])) {
    const shade = 1 - (u - 0.405) * 0.5;
    return [Math.round(255 * shade), Math.round(84 * shade), Math.round(112 * shade), 255];
  }
  // ground shadow
  const dx = u - 0.385, dy = (v - 0.84) * 3.2;
  if (dx * dx + dy * dy < 0.02) { r *= 0.8; g *= 0.8; b *= 0.8; }
  return [Math.round(r), Math.round(g), Math.round(b), 255];
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(new URL(`../icons/${name}`, import.meta.url), png(size, pixel));
  console.log(`icons/${name} (${size}x${size})`);
}
