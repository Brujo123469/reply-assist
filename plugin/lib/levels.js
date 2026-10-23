// Loudness bookkeeping on the same clock speech-to-text uses: seconds of audio
// sent since the stream opened. Speech-to-text reports word start/end times on
// that clock, so we can ask "how loud was the audio while these words were
// spoken?" and use it to tell the wearer's voice from someone else's.

export function rmsDb(pcm) {
  if (!pcm.length) return -Infinity;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const s = pcm[i] / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / pcm.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

export function createLevelTimeline({ maxSeconds = 120 } = {}) {
  const entries = []; // { t0, t1, db }
  let clock = 0;
  return {
    get clock() { return clock; },
    /** Record one block of PCM (16 kHz mono) and advance the clock. */
    push(pcm, sampleRate = 16000) {
      const dur = pcm.length / sampleRate;
      entries.push({ t0: clock, t1: clock + dur, db: rmsDb(pcm) });
      clock += dur;
      while (entries.length && entries[0].t1 < clock - maxSeconds) entries.shift();
    },
    /**
     * Speech level over [start, end]: the mean of the loudest 50% of blocks,
     * so the pauses between words don't drag the number down.
     */
    levelBetween(start, end) {
      const dbs = entries
        .filter((e) => e.t1 > start && e.t0 < end && Number.isFinite(e.db))
        .map((e) => e.db)
        .sort((a, b) => b - a);
      if (!dbs.length) return null;
      const top = dbs.slice(0, Math.max(1, Math.ceil(dbs.length / 2)));
      return top.reduce((a, b) => a + b, 0) / top.length;
    },
    reset() { entries.length = 0; clock = 0; },
  };
}
