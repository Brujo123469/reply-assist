// Pixels for the glasses: GRAY_4 packing, raw LZ4 compression, and finding
// which parts of the screen changed. Pure functions, no canvas, so they can
// be tested in Node.
//
// GRAY_4: 4 bits per pixel, brightness 0-15, two pixels per byte with the
// even pixel in the high nibble. A row is ceil(width / 2) bytes.

export const SCREEN = Object.freeze({ width: 600, height: 350 });
// One display payload holds at most 81,901 bytes once decoded.
export const MAX_DECODED = 81880; // under both the raw (81,891) and LZ4 (81,901) limits

/** RGBA pixels (canvas ImageData.data) to packed GRAY_4, by brightest channel. */
export function toGray4(rgba, width, height) {
  const stride = Math.ceil(width / 2);
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const v = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]);
      const level = (v * 15 + 127) / 255 | 0;
      const o = y * stride + (x >> 1);
      out[o] |= x & 1 ? level : level << 4;
    }
  }
  return out;
}

/** Copy a region out of a packed frame. x and width must be even. */
export function crop(frame, frameWidth, x, y, width, height) {
  const fs = frameWidth / 2;
  const rs = width / 2;
  const out = new Uint8Array(rs * height);
  for (let row = 0; row < height; row += 1) {
    const start = (y + row) * fs + x / 2;
    out.set(frame.subarray(start, start + rs), row * rs);
  }
  return out;
}

/**
 * Regions that differ between two packed frames, merged so each is one
 * display payload. Bluetooth round trips cost more than the bytes, so this
 * favors a few tall regions over many small ones.
 */
export function changedRegions(prev, next, width = SCREEN.width, height = SCREEN.height, band = 25) {
  const fs = width / 2;
  const bands = [];
  for (let y = 0; y < height; y += band) {
    const h = Math.min(band, height - y);
    let lo = fs;
    let hi = -1;
    for (let row = y; row < y + h; row += 1) {
      const base = row * fs;
      for (let b = 0; b < fs; b += 1) {
        if (!prev || prev[base + b] !== next[base + b]) {
          if (b < lo) lo = b;
          if (b > hi) hi = b;
        }
      }
    }
    if (hi >= 0) bands.push({ y, h, lo, hi });
  }
  const regions = [];
  for (const b of bands) {
    const last = regions[regions.length - 1];
    if (last && last.y + last.height === b.y) {
      const lo = Math.min(last.lo, b.lo);
      const hi = Math.max(last.hi, b.hi);
      if ((hi - lo + 1) * (last.height + b.h) <= MAX_DECODED) {
        Object.assign(last, { lo, hi, height: last.height + b.h });
        continue;
      }
    }
    regions.push({ y: b.y, height: b.h, lo: b.lo, hi: b.hi });
  }
  return regions.map((r) => ({ x: r.lo * 2, y: r.y, width: (r.hi - r.lo + 1) * 2, height: r.height }));
}

/**
 * Raw LZ4 block (no frame header), as the display expects. Greedy matcher;
 * the black background compresses to almost nothing.
 */
export function lz4Compress(src) {
  const n = src.length;
  const out = new Uint8Array(n + Math.ceil(n / 255) + 16);
  let op = 0;
  let anchor = 0;
  let ip = 0;
  const writeLength = (len) => {
    let l = len - 15;
    while (l >= 255) { out[op++] = 255; l -= 255; }
    out[op++] = l;
  };
  if (n >= 13) {
    const table = new Int32Array(1 << 16).fill(-1);
    const limit = n - 12; // LZ4: the last match starts at least 12 bytes from the end
    while (ip < limit) {
      const seq = (src[ip] | (src[ip + 1] << 8) | (src[ip + 2] << 16) | (src[ip + 3] << 24)) >>> 0;
      const h = Math.imul(seq, 2654435761) >>> 16;
      const ref = table[h];
      table[h] = ip;
      if (ref >= 0 && ip - ref <= 65535
        && src[ref] === src[ip] && src[ref + 1] === src[ip + 1]
        && src[ref + 2] === src[ip + 2] && src[ref + 3] === src[ip + 3]) {
        let len = 4;
        const maxLen = n - 5 - ip; // and the last 5 bytes are always literals
        while (len < maxLen && src[ref + len] === src[ip + len]) len += 1;
        const lit = ip - anchor;
        const token = op++;
        if (lit >= 15) writeLength(lit);
        out.set(src.subarray(anchor, ip), op);
        op += lit;
        const offset = ip - ref;
        out[op++] = offset & 255;
        out[op++] = offset >> 8;
        const ml = len - 4;
        if (ml >= 15) writeLength(ml);
        out[token] = (Math.min(lit, 15) << 4) | Math.min(ml, 15);
        ip += len;
        anchor = ip;
      } else {
        ip += 1;
      }
    }
  }
  const lit = n - anchor;
  const token = op++;
  if (lit >= 15) writeLength(lit);
  out[token] = Math.min(lit, 15) << 4;
  out.set(src.subarray(anchor), op);
  op += lit;
  return out.slice(0, op);
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
