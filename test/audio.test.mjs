import test from 'node:test';
import assert from 'node:assert/strict';
import createModule from '../plugin/vendor/opus-decoder.esm.js';
import { createOpusDecoder } from '../plugin/lib/audio.js';
import { rmsDb } from '../plugin/lib/levels.js';

// Encode real Opus packets (16 kHz mono, 20 ms) the way the glasses do.
async function encodeSine({ amplitude, frames, hz = 300 }) {
  const module = await createModule().ready;
  const encoder = new module.OpusScriptHandler(16000, 1, 2049);
  const input = module._malloc(640 * 2);
  const output = module._malloc(3828);
  const packets = [];
  for (let frame = 0; frame < frames; frame += 1) {
    for (let s = 0; s < 320; s += 1) {
      const v = Math.round(amplitude * Math.sin(2 * Math.PI * hz * (frame * 320 + s) / 16000));
      module.HEAPU16[(input >> 1) + s * 2] = v & 255;
      module.HEAPU16[(input >> 1) + s * 2 + 1] = (v >> 8) & 255;
    }
    const len = encoder._encode(input, 640, output, 320);
    packets.push(module.HEAPU8.slice(output, output + len));
  }
  module.OpusScriptHandler.destroy_handler(encoder);
  module._free(input); module._free(output);
  const data = new Uint8Array(packets.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of packets) { data.set(p, o); o += p.length; }
  return { data, frameLengths: packets.map((p) => p.length) };
}

test('decodes a 40 ms chunk of glasses Opus into signed 16-bit PCM', async () => {
  const { data, frameLengths } = await encodeSine({ amplitude: 10000, frames: 2 });
  const dec = await createOpusDecoder();
  const pcm = dec.decode(data, frameLengths);
  dec.destroy();
  assert.equal(pcm.length, 640);
  assert.ok(pcm.some((v) => v < -1000), 'has negative samples (sign handled)');
  assert.ok(pcm.some((v) => v > 1000));
});

test('streaming decode over many chunks keeps level proportional to input', async () => {
  const loud = await encodeSine({ amplitude: 12000, frames: 50 });
  const quiet = await encodeSine({ amplitude: 1200, frames: 50 });
  const dec = await createOpusDecoder();
  const decodeAll = ({ data, frameLengths }) => {
    // feed in 2-frame chunks like the `interactive` profile
    const out = [];
    let off = 0;
    for (let i = 0; i < frameLengths.length; i += 2) {
      const lens = frameLengths.slice(i, i + 2);
      const bytes = lens.reduce((a, b) => a + b, 0);
      out.push(...dec.decode(data.subarray(off, off + bytes), lens));
      off += bytes;
    }
    return Int16Array.from(out.slice(3200)); // skip codec warm-up
  };
  const loudDb = rmsDb(decodeAll(loud));
  const quietDb = rmsDb(decodeAll(quiet));
  dec.destroy();
  // sine RMS = A/sqrt(2): 12000 -> about -11.7 dBFS; 10x quieter -> 20 dB lower
  assert.ok(Math.abs(loudDb - -11.7) < 2.5, `loud ${loudDb}`);
  assert.ok(Math.abs(loudDb - quietDb - 20) < 3, `diff ${loudDb - quietDb}`);
});

test('a corrupt frame is skipped instead of breaking the stream', async () => {
  const { data, frameLengths } = await encodeSine({ amplitude: 8000, frames: 3 });
  const dec = await createOpusDecoder();
  const bad = new Uint8Array([0xff, 0xff, 0xff]);
  const mixed = new Uint8Array(data.length + bad.length);
  mixed.set(data.subarray(0, frameLengths[0]));
  mixed.set(bad, frameLengths[0]);
  mixed.set(data.subarray(frameLengths[0]), frameLengths[0] + bad.length);
  const pcm = dec.decode(mixed, [frameLengths[0], bad.length, frameLengths[1], frameLengths[2]]);
  dec.destroy();
  assert.ok(pcm.length >= 960, `decoded ${pcm.length}`);
});
