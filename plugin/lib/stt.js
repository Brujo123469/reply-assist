// Streaming speech-to-text over Deepgram's live WebSocket API.
//
// Audio in: 16 kHz mono int16 PCM. Out: one "utterance" per spoken segment,
// with start/end times on the audio clock so loudness can be looked up.
//
// Segments end on Deepgram's endpointing (`speech_final`, ~300 ms of silence)
// which is much faster than waiting for the UtteranceEnd fallback, and fast
// replies are the whole point.

const URL_BASE = 'wss://api.deepgram.com/v1/listen';

/** wss:// listen URL on your Reply Assist server, from its https:// address. */
export function serverListenUrl(server) {
  return `${String(server).trim().replace(/\/+$/, '').replace(/^http(s?):/i, 'ws$1:')}/v1/listen`;
}

export function buildUrl({ language, model = 'nova-3', endpointingMs = 300, base = URL_BASE }) {
  const params = new URLSearchParams({
    model,
    language: language || 'multi',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    endpointing: String(endpointingMs),
    utterance_end_ms: '1000',
    smart_format: 'true',
    punctuate: 'true',
  });
  return `${base}?${params}`;
}

/**
 * Collects is_final pieces into a segment and emits it on speech_final or
 * UtteranceEnd. Exported separately so it can be tested without a socket.
 */
/** Language of a result: Deepgram's auto-detect labels results and words. */
function languageOf(alt) {
  return alt?.languages?.[0] ?? alt?.words?.find((w) => w.language)?.language ?? null;
}

export function createSegmenter(onUtterance, onInterim) {
  let parts = [];
  let start = null;
  let end = null;
  let langs = new Map(); // language -> words, across the segment's parts

  const mainLanguage = () => [...langs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const flush = (reason) => {
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    const language = mainLanguage();
    if (text) onUtterance({ text, startSec: start ?? 0, endSec: end ?? start ?? 0, reason, ...(language ? { language } : {}) });
    parts = []; start = null; end = null; langs = new Map();
  };

  return {
    handle(msg) {
      if (msg?.type === 'UtteranceEnd') { flush('utterance-end'); return; }
      if (msg?.type !== 'Results') return;
      const alt = msg.channel?.alternatives?.[0];
      const transcript = (alt?.transcript ?? '').trim();
      if (!msg.is_final) {
        if (transcript) {
          // Timing lets the caller check loudness: is this the wearer talking?
          const words = alt.words ?? [];
          const segStart = start ?? (words.length ? words[0].start : msg.start);
          const segEnd = words.length ? words[words.length - 1].end : (msg.start ?? 0) + (msg.duration ?? 0);
          const language = languageOf(alt) ?? mainLanguage();
          onInterim?.([...parts, transcript].join(' '), { startSec: segStart ?? 0, endSec: segEnd ?? segStart ?? 0, ...(language ? { language } : {}) });
        }
        return;
      }
      if (transcript) {
        const words = alt.words ?? [];
        const segStart = words.length ? words[0].start : msg.start;
        const segEnd = words.length ? words[words.length - 1].end : msg.start + msg.duration;
        if (start == null) start = segStart;
        end = segEnd;
        parts.push(transcript);
        const language = languageOf(alt);
        if (language) langs.set(language, (langs.get(language) ?? 0) + Math.max(1, words.length));
      }
      if (msg.speech_final) flush('speech-final');
    },
    flush,
  };
}

/**
 * Live transcription, either through your Reply Assist server (server +
 * token: the server holds the Deepgram key) or straight to Deepgram (apiKey).
 */
export function connectDeepgram({ apiKey, server, token, language, onUtterance, onInterim, onStatus, onMessage, WebSocketImpl = globalThis.WebSocket }) {
  const secret = server ? token : apiKey;
  if (!secret) {
    throw server
      ? Object.assign(new Error('Add your app token in Settings'), { code: 'NO_APP_TOKEN' })
      : Object.assign(new Error('Add a Deepgram API key in Settings'), { code: 'NO_STT_KEY' });
  }
  // Browsers can't set an Authorization header on a WebSocket; Deepgram (and
  // your server, which copies its scheme) take the secret as a subprotocol.
  const url = buildUrl({ language, ...(server ? { base: serverListenUrl(server) } : {}) });
  const socket = new WebSocketImpl(url, ['token', secret]);
  socket.binaryType = 'arraybuffer';
  const segmenter = createSegmenter(onUtterance, onInterim);
  const pending = [];
  let keepAlive;
  let closed = false;

  socket.onopen = () => {
    onStatus?.('open');
    for (const buf of pending.splice(0)) socket.send(buf);
    keepAlive = setInterval(() => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'KeepAlive' }));
    }, 8000);
  };
  socket.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { onMessage?.({ type: 'malformed' }); return; }
    onMessage?.(msg);
    try { segmenter.handle(msg); } catch { /* one bad message shouldn't end the stream */ }
  };
  socket.onerror = () => onStatus?.('error');
  socket.onclose = (event) => {
    clearInterval(keepAlive);
    segmenter.flush('closed');
    if (!closed) onStatus?.('closed', event.code, event.reason);
  };

  return {
    /** Returns false if the audio was dropped because the socket isn't usable. */
    send(pcm) {
      const buf = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
      if (socket.readyState === 1) { socket.send(buf); return true; }
      if (socket.readyState === 0 && pending.length < 100) { pending.push(buf); return true; }
      return false;
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      try {
        if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'CloseStream' }));
        setTimeout(() => socket.close(), 1500);
      } catch { /* already closed */ }
    },
  };
}
