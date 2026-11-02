#!/usr/bin/env node
'use strict';

/**
 * Generates the app icons (PNG + ICO) without any image libraries:
 * a blue rounded square with a white diamond (matches public/favicon.svg).
 *   node scripts/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.resolve(__dirname, '..', 'desktop', 'assets');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed-distance helpers with 1px anti-aliasing.
const clamp01 = (v) => Math.max(0, Math.min(1, v));
function roundedRectCoverage(x, y, s, r) {
  const hx = s / 2;
  const dx = Math.abs(x - hx) - (hx - r);
  const dy = Math.abs(y - hx) - (hx - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
  return clamp01(0.5 - outside);
}
function diamondCoverage(x, y, cx, cy, radius) {
  const d = (Math.abs(x - cx) + Math.abs(y - cy) - radius) / Math.SQRT2;
  return clamp01(0.5 - d);
}

function pixel(x, y, s) {
  const bg = roundedRectCoverage(x, y, s, s * 0.22);
  if (bg <= 0) return [0, 0, 0, 0];
  const c = s / 2;
  const outer = diamondCoverage(x, y, c, c, s * 0.30);
  const outerInner = diamondCoverage(x, y, c, c, s * 0.30 - Math.max(1.6, s * 0.085));
  const ring = clamp01(outer - outerInner);
  const core = diamondCoverage(x, y, c, c, s * 0.11);
  const white = clamp01(ring + core);
  const blue = [12, 102, 228];
  const mix = (a, b, t) => Math.round(a + (b - a) * t);
  return [mix(blue[0], 255, white), mix(blue[1], 255, white), mix(blue[2], 255, white), Math.round(255 * bg)];
}

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

fs.mkdirSync(OUT, { recursive: true });
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, data: png(size, pixel) }));
for (const { size, data } of images) {
  if ([16, 32, 64, 256].includes(size)) fs.writeFileSync(path.join(OUT, `icon-${size}.png`), data);
}
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(images));
console.log(`Icons written to ${OUT}`);
