// Glasses microphone -> 16 kHz mono 16-bit PCM blocks.
//
// The host delivers Opus frames (20 ms each, 16 kHz mono) over a binary
// stream. We decode them locally with the bundled pure-JS decoder (the host
// forbids WASM and eval) so any speech-to-text service can take plain PCM, and
// so we can measure loudness for telling voices apart.

const SAMPLES_PER_FRAME = 320; // 20 ms at 16 kHz
let modulePromise;

async function loadDecoderModule() {
  modulePromise ??= import('../vendor/opus-decoder.esm.js')
    .then(({ default: createModule }) => createModule().ready);
  return modulePromise;
}

export async function createOpusDecoder() {
  const module = await loadDecoderModule();
  const handler = new module.OpusScriptHandler(16000, 1, 2049);
  const input = module._malloc(3828);
  // The handler writes each PCM byte into its own uint16 slot, so one int16
  // sample takes four bytes of output heap (see vendor/recording-playback.js).
  const output = module._malloc(1920 * 4);
  let destroyed = false;
  return {
    /** Decode consecutive Opus frames into one Int16Array. */
    decode(data, frameLengths) {
      if (destroyed) throw new Error('decoder destroyed');
      const pcm = new Int16Array(frameLengths.length * SAMPLES_PER_FRAME);
      let offset = 0;
      let written = 0;
      for (const length of frameLengths) {
        module.HEAPU8.set(data.subarray(offset, offset + length), input);
        offset += length;
        const samples = handler._decode(input, length, output);
        if (samples <= 0) continue; // corrupt frame: skip rather than kill the stream
        const base = output >> 1;
        for (let s = 0; s < samples; s += 1) {
          const lo = module.HEAPU16[base + s * 2] & 255;
          const hi = module.HEAPU16[base + s * 2 + 1] & 255;
          pcm[written + s] = (hi << 8 | lo) << 16 >> 16; // to signed int16
        }
        written += samples;
      }
      return written === pcm.length ? pcm : pcm.subarray(0, written);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      module.OpusScriptHandler.destroy_handler(handler);
      module._free(input);
      module._free(output);
    },
  };
}

/**
 * Open the glasses mic and call onPcm(Int16Array, chunk) for every chunk.
 * Returns { stop(), done } where done settles when the stream ends.
 */
export async function startGlassesAudio(gm, { onPcm, onDrop, pickupMode = 'frontBalanced' }) {
  const decoder = await createOpusDecoder();
  let capture;
  try {
    capture = await gm.audio.openCapture({
      profile: 'interactive',   // 40 ms chunks, drop-oldest: built for live translation
      pickupMode,               // frontBalanced = wearer + person in front
      noiseReduction: true,
    });
  } catch (error) {
    decoder.destroy();
    throw error;
  }

  const done = (async () => {
    try {
      for await (const chunk of capture.stream) {
        if (chunk.discontinuity || chunk.droppedFrameCount) onDrop?.(chunk);
        onPcm(decoder.decode(chunk.data, chunk.frameLengths), chunk);
      }
    } finally {
      decoder.destroy();
    }
  })();

  return {
    sessionId: capture.sessionId,
    done,
    async stop() {
      try { await capture.stop(); } catch { /* already stopped by host */ }
      await done.catch(() => {});
    },
  };
}
