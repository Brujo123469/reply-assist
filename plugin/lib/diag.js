// Diagnostics log: a short, shareable record of what each stage of the
// pipeline did (mic -> decode -> speech-to-text -> Claude -> glasses), so a
// "listening doesn't work" report says where it broke.
//
// Never log API keys. redact() is a second line of defense for the export.

import { rmsDb } from './levels.js';

const SAMPLES_PER_FRAME = 320; // 20 ms at 16 kHz, matches audio.js

export function createDiagLog({ max = 400, now = () => Date.now() } = {}) {
  let entries = [];
  const listeners = new Set();
  return {
    log(stage, message) {
      entries.push({ t: now(), stage, message: String(message) });
      if (entries.length > max) entries = entries.slice(-max);
      for (const fn of listeners) fn();
    },
    lines() {
      return entries.map((e) => `${formatTime(e.t)} [${e.stage}] ${e.message}`);
    },
    get size() { return entries.length; },
    clear() { entries = []; for (const fn of listeners) fn(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

export function formatTime(ms) {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Replace every occurrence of each secret (keys) with a placeholder. */
export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 8) out = out.split(s).join('<redacted>');
  }
  return out;
}

/**
 * Rolling audio counters for one reporting window. add() takes the Opus
 * chunk's frame count and the PCM it decoded to; frames that failed to decode
 * show up as the difference.
 */
export function createAudioStats() {
  let s;
  const reset = () => {
    s = { chunks: 0, frames: 0, decodedFrames: 0, sentBytes: 0, unsentBlocks: 0, dbSum: 0, dbCount: 0, dbMax: -Infinity };
  };
  reset();
  return {
    add({ frames, pcm }) {
      s.chunks += 1;
      s.frames += frames;
      s.decodedFrames += Math.round(pcm.length / SAMPLES_PER_FRAME);
      const db = rmsDb(pcm);
      if (Number.isFinite(db)) { s.dbSum += db; s.dbCount += 1; if (db > s.dbMax) s.dbMax = db; }
    },
    sent(bytes) { s.sentBytes += bytes; },
    unsent() { s.unsentBlocks += 1; },
    summary() {
      const avg = s.dbCount ? (s.dbSum / s.dbCount).toFixed(0) : 'n/a';
      const max = Number.isFinite(s.dbMax) ? s.dbMax.toFixed(0) : 'n/a';
      const failed = s.frames - s.decodedFrames;
      return `chunks ${s.chunks} · opus frames ${s.frames} · decoded ${s.decodedFrames}`
        + `${failed > 0 ? ` (FAILED ${failed})` : ''} · level avg ${avg} dB, max ${max} dB`
        + ` · sent to Deepgram ${(s.sentBytes / 1024).toFixed(0)} KiB`
        + `${s.unsentBlocks ? ` · NOT SENT ${s.unsentBlocks} blocks (socket not open)` : ''}`;
    },
    get empty() { return s.chunks === 0; },
    reset,
  };
}
