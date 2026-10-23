import test from 'node:test';
import assert from 'node:assert/strict';
import { toGray4, crop, changedRegions, lz4Compress, toBase64, MAX_DECODED } from '../plugin/lib/gray4.js';

// Reference raw-LZ4-block decoder, written from the format description.
function lz4Decompress(src, size) {
  const out = new Uint8Array(size);
  let ip = 0;
  let op = 0;
  const readLength = (base) => {
    let len = base;
    if (base === 15) { let b; do { b = src[ip++]; len += b; } while (b === 255); }
    return len;
  };
  while (ip < src.length) {
    const token = src[ip++];
    const lit = readLength(token >> 4);
    out.set(src.subarray(ip, ip + lit), op);
    ip += lit;
    op += lit;
    if (ip >= src.length) break;
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    const len = readLength(token & 15) + 4;
    for (let i = 0; i < len; i += 1) { out[op] = out[op - offset]; op += 1; }
  }
  assert.equal(op, size, 'decoded size');
  return out;
}

test('packs two pixels per byte, even pixel in the high nibble', () => {
  // 3x1 image: white, black, mid grey.
  const rgba = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255, 136, 136, 136, 255]);
  assert.deepEqual([...toGray4(rgba, 3, 1)], [0xf0, 0x80]);
});

test('LZ4 round-trips text-like, random and tiny inputs', () => {
  const screen = new Uint8Array(300 * 120);
  for (let i = 0; i < 4000; i += 1) screen[(i * 37) % screen.length] = (i % 15) + 1; // sparse "glyphs"
  const random = new Uint8Array(5000).map(() => Math.random() * 256 | 0);
  for (const input of [screen, random, new Uint8Array(0), new Uint8Array([1, 2, 3]), new Uint8Array(13).fill(7)]) {
    const packed = lz4Compress(input);
    assert.deepEqual(lz4Decompress(packed, input.length), input);
  }
  assert.ok(lz4Compress(new Uint8Array(105000)).length < 600, 'a black screen is tiny');
});

test('crop copies a region out of a packed frame', () => {
  const frame = new Uint8Array(300 * 4).map((_, i) => i % 251);
  const region = crop(frame, 600, 10, 1, 4, 2);
  assert.deepEqual([...region], [frame[300 + 5], frame[300 + 6], frame[600 + 5], frame[600 + 6]]);
});

test('only changed parts of the screen are resent, in payload-sized regions', () => {
  const a = new Uint8Array(300 * 350);
  const b = a.slice();
  b[300 * 120 + 50] = 0xff; // one byte in band 4 (rows 100-124), x = 100..101
  b[300 * 130 + 60] = 0xff; // band 5, x = 120..121
  const regions = changedRegions(a, b);
  assert.deepEqual(regions, [{ x: 100, y: 100, width: 22, height: 50 }], 'adjacent bands merge, x is the bounding range');
  assert.deepEqual(changedRegions(a, a.slice()), []);
  // First frame: everything, split so each region fits one payload.
  const full = changedRegions(null, a);
  assert.equal(full.reduce((n, r) => n + r.height, 0), 350);
  for (const r of full) assert.ok(r.width / 2 * r.height <= MAX_DECODED);
});

test('base64 encodes binary bytes', () => {
  assert.equal(toBase64(new Uint8Array([0, 255, 16])), 'AP8Q');
});
