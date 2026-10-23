import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagLog, createAudioStats, redact } from '../plugin/lib/diag.js';
import { connectDeepgram } from '../plugin/lib/stt.js';

test('log keeps the newest entries up to its limit', () => {
  let t = Date.UTC(2026, 9, 17, 12, 0, 0);
  const log = createDiagLog({ max: 3, now: () => (t += 1000) });
  for (const n of [1, 2, 3, 4, 5]) log.log('stt', `message ${n}`);
  const lines = log.lines();
  assert.equal(lines.length, 3);
  assert.match(lines[0], /\[stt\] message 3$/);
  assert.match(lines[2], /\[stt\] message 5$/);
  log.clear();
  assert.equal(log.size, 0);
});

test('redact removes every copy of each key and ignores empty ones', () => {
  const key = 'sk-ant-api03-abcdefghijklmnop';
  const out = redact(`a ${key} b ${key} c`, [key, '', null, 'short']);
  assert.equal(out, 'a <redacted> b <redacted> c');
  assert.equal(redact('short stays', ['short']), 'short stays', 'too-short secrets are not treated as keys');
});

test('audio stats report frames that failed to decode and audio not sent', () => {
  const stats = createAudioStats();
  assert.equal(stats.empty, true);
  const loud = new Int16Array(640).fill(8000);   // 2 frames decoded
  stats.add({ frames: 2, pcm: loud });
  stats.add({ frames: 2, pcm: new Int16Array(0) }); // both frames failed
  stats.sent(loud.byteLength);
  stats.unsent();
  const s = stats.summary();
  assert.match(s, /opus frames 4 · decoded 2 \(FAILED 2\)/);
  assert.match(s, /max -12 dB/);
  assert.match(s, /NOT SENT 1 blocks/);
  stats.reset();
  assert.equal(stats.empty, true);
});

test('healthy audio has no failure markers', () => {
  const stats = createAudioStats();
  stats.add({ frames: 2, pcm: new Int16Array(640).fill(1000) });
  stats.sent(1280);
  assert.doesNotMatch(stats.summary(), /FAILED|NOT SENT/);
});

// Minimal stand-in for the browser WebSocket.
class FakeSocket {
  static last;
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; FakeSocket.last = this; }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

test('speech-to-text reports every message and whether audio was sent', () => {
  const messages = [];
  const utterances = [];
  const stt = connectDeepgram({
    apiKey: 'test-key-123456', language: 'es', WebSocketImpl: FakeSocket,
    onUtterance: (u) => utterances.push(u), onMessage: (m) => messages.push(m.type),
  });
  const sock = FakeSocket.last;
  const pcm = new Int16Array(320);
  assert.equal(stt.send(pcm), true, 'queued while connecting');
  sock.readyState = 1;
  sock.onopen();
  assert.equal(stt.send(pcm), true);
  sock.onmessage({ data: JSON.stringify({ type: 'Metadata' }) });
  sock.onmessage({ data: 'not json' });
  sock.onmessage({ data: JSON.stringify({
    type: 'Results', is_final: true, speech_final: true, start: 0, duration: 1,
    channel: { alternatives: [{ transcript: 'hola', words: [{ start: 0.1, end: 0.5 }] }] },
  }) });
  assert.deepEqual(messages, ['Metadata', 'malformed', 'Results']);
  assert.equal(utterances[0].text, 'hola');
  sock.readyState = 3;
  assert.equal(stt.send(pcm), false, 'dropped once the socket is closed');
  stt.close();
});
