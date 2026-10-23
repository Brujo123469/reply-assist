import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../plugin/lib/session.js';
import { createLevelTimeline } from '../plugin/lib/levels.js';
import { createSegmenter } from '../plugin/lib/stt.js';

function fakeHud() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return { calls, status: rec('status'), theirTurn: rec('theirTurn'), translation: rec('translation'), reply: rec('reply'), picked: rec('picked'), mine: rec('mine'), focus: rec('focus'), say: rec('say'), liveTheirs: rec('liveTheirs') };
}

const bank = [
  'Sí|yes', 'No|no', 'No entiendo|I don\'t understand', '¿Puede repetir?|could you repeat?',
  'Más despacio, por favor|slower please', 'Un momento|one moment', 'Gracias|thanks',
  'Perdón|sorry', 'No sé|I don\'t know', 'Vale|okay',
].map((s) => { const [text, gloss] = s.split('|'); return { text, gloss, source: 'bank' }; });

function fakeClaude(lines, { delayMs = 0 } = {}) {
  const requests = [];
  const suggest = async ({ history, latest, signal, onItem }) => {
    requests.push({ history, latest });
    for (const item of lines) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      onItem(item);
    }
  };
  return { suggest, requests };
}

const replies = [
  { type: 'translation', text: 'Are you staying in the city long?' },
  { type: 'reply', index: 0, text: 'Solo unos días', gloss: 'just a few days' },
  { type: 'reply', index: 1, text: 'Hasta el viernes', gloss: 'until Friday' },
  { type: 'reply', index: 2, text: 'Todavía no lo sé', gloss: "I don't know yet" },
];

const settings = () => ({ selfDb: null, marginDb: 8 });

test('their question shows instant replies, then streams Claude replies', async () => {
  const hud = fakeHud();
  const claude = fakeClaude(replies);
  const s = createSession({ hud, suggest: claude.suggest, getSettings: settings });
  s.setBank(bank);
  s.onUtterance({ text: '¿Se queda mucho tiempo en la ciudad?', startSec: 1, endSec: 3 });
  await new Promise((r) => setTimeout(r, 0));
  const [first, ...rest] = hud.calls;
  assert.equal(first[0], 'theirTurn');
  assert.deepEqual(first[2].map((r) => r.text), ['¿Puede repetir?', 'Más despacio, por favor', 'Un momento']);
  assert.deepEqual(rest[0], ['translation', 'Are you staying in the city long?']);
  assert.equal(rest.filter((c) => c[0] === 'reply').length, 3);
  assert.equal(s.shown[1].text, 'Hasta el viernes');
});

test('saying a shown reply picks it and records the turn', async () => {
  const hud = fakeHud();
  const claude = fakeClaude(replies);
  const s = createSession({ hud, suggest: claude.suggest, getSettings: settings });
  s.setBank(bank);
  s.onUtterance({ text: '¿Se queda mucho tiempo?', startSec: 1, endSec: 3 });
  await new Promise((r) => setTimeout(r, 0));
  const r = s.onUtterance({ text: 'Hasta el viernes.', startSec: 4, endSec: 5 });
  assert.equal(r.kind, 'picked');
  // It stays on screen, fully said, until they talk.
  assert.deepEqual(hud.calls.at(-1), ['focus', 1, 16, true]);
  assert.deepEqual(s.history, [
    { who: 'them', text: '¿Se queda mucho tiempo?' },
    { who: 'me', text: 'Hasta el viernes' },
  ]);
});

test('next question carries the conversation history to Claude', async () => {
  const hud = fakeHud();
  const claude = fakeClaude(replies);
  const s = createSession({ hud, suggest: claude.suggest, getSettings: settings });
  s.setBank(bank);
  s.onUtterance({ text: '¿Se queda mucho tiempo?', startSec: 1, endSec: 3 });
  await new Promise((r) => setTimeout(r, 0));
  s.onUtterance({ text: 'Hasta el viernes', startSec: 4, endSec: 5 });
  s.onUtterance({ text: '¿Y dónde se aloja?', startSec: 8, endSec: 9 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(claude.requests.length, 2);
  assert.equal(claude.requests[1].latest, '¿Y dónde se aloja?');
  assert.equal(claude.requests[1].history.length, 2);
});

test('bank phrases count as picks even when not on screen', async () => {
  const hud = fakeHud();
  const s = createSession({ hud, suggest: fakeClaude(replies).suggest, getSettings: settings });
  s.setBank(bank);
  const r = s.onUtterance({ text: 'gracias', startSec: 1, endSec: 2 });
  assert.equal(r.kind, 'picked');
});

test('their turn split across segments merges and re-asks; old stream is dropped', async () => {
  const hud = fakeHud();
  const claude = fakeClaude(replies, { delayMs: 5 });
  const s = createSession({ hud, suggest: claude.suggest, getSettings: settings });
  s.setBank(bank);
  s.onUtterance({ text: '¿Se queda', startSec: 1, endSec: 1.5 });
  s.onUtterance({ text: 'mucho tiempo en la ciudad?', startSec: 2.4, endSec: 3.5 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(claude.requests.length, 2);
  assert.equal(claude.requests[1].latest, '¿Se queda mucho tiempo en la ciudad?');
  // only the second request's items reached the HUD
  assert.equal(hud.calls.filter((c) => c[0] === 'translation').length, 1);
});

test('with calibration, the wearer improvising is not translated', async () => {
  const hud = fakeHud();
  const claude = fakeClaude(replies);
  const levels = createLevelTimeline();
  // 1 s quiet (them), then 1 s loud (wearer)
  levels.push(new Int16Array(16000).fill(300));
  levels.push(new Int16Array(16000).fill(6000));
  const s = createSession({ hud, suggest: claude.suggest, levels, getSettings: () => ({ selfDb: -15, marginDb: 8 }) });
  s.setBank(bank);
  assert.equal(s.onUtterance({ text: 'Me quedo con mi hermana', startSec: 1.1, endSec: 1.9 }).kind, 'mine');
  assert.equal(s.onUtterance({ text: '¿De verdad?', startSec: 0.1, endSec: 0.9 }).kind, 'theirs');
});

test('Claude failure shows the error on the HUD instead of hanging', async () => {
  const hud = fakeHud();
  const logs = [];
  const suggest = async () => { throw Object.assign(new Error('invalid x-api-key'), { code: 'BAD_CLAUDE_KEY' }); };
  const s = createSession({ hud, suggest, getSettings: settings, log: (e) => logs.push(e) });
  s.onUtterance({ text: 'Hola', startSec: 1, endSec: 2 });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(hud.calls.at(-1), ['translation', '(invalid x-api-key)']);
  assert.ok(logs.some((l) => l.type === 'error' && l.code === 'BAD_CLAUDE_KEY'));
});

test('segmenter joins final pieces and emits on speech_final with word times', () => {
  const out = [];
  const seg = createSegmenter((u) => out.push(u));
  const res = (transcript, start, end, flags) => ({
    type: 'Results', start, duration: end - start, ...flags,
    channel: { alternatives: [{ transcript, words: transcript ? [{ start, end }] : [] }] },
  });
  seg.handle(res('hasta el', 1.0, 1.4, { is_final: false }));
  seg.handle(res('hasta el', 1.0, 1.4, { is_final: true, speech_final: false }));
  seg.handle(res('viernes', 1.5, 1.9, { is_final: true, speech_final: true }));
  seg.handle({ type: 'UtteranceEnd' }); // nothing pending: no empty utterance
  assert.deepEqual(out, [{ text: 'hasta el viernes', startSec: 1.0, endSec: 1.9, reason: 'speech-final' }]);
});

test('level timeline reports speech level for a time window', () => {
  const t = createLevelTimeline();
  t.push(new Int16Array(8000).fill(1000));  // 0.0-0.5 s
  t.push(new Int16Array(8000).fill(8000));  // 0.5-1.0 s
  const loud = t.levelBetween(0.5, 1.0);
  const quiet = t.levelBetween(0, 0.5);
  assert.ok(loud > quiet + 15, `${loud} vs ${quiet}`);
});

// ---- live (interim) speech: focusing a reply, showing their words

function liveSetup({ selfDb = -20 } = {}) {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  const hud = { calls, status: rec('status'), theirTurn: rec('theirTurn'), translation: rec('translation'), reply: rec('reply'), picked: rec('picked'), mine: rec('mine'), focus: rec('focus'), liveTheirs: rec('liveTheirs') };
  const { suggest } = fakeClaude([
    { type: 'translation', text: 'How long are you staying?' },
    { type: 'reply', index: 0, text: 'Solo unos días', gloss: 'just a few days' },
    { type: 'reply', index: 1, text: 'Hasta el viernes', gloss: 'until Friday' },
    { type: 'reply', index: 2, text: '¿Por qué lo pregunta?', gloss: 'why do you ask?' },
  ]);
  const session = createSession({ hud, suggest, getSettings: () => ({ selfDb, marginDb: 8, replyMode: 'claude' }) });
  return { hud, calls, session };
}

test('saying the start of a reply focuses it and tracks progress', async () => {
  const { calls, session } = liveSetup();
  session.onUtterance({ text: '¿Se queda mucho tiempo?', startSec: 0, endSec: 1, levelDb: -50 });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(session.onInterim({ text: 'hasta', startSec: 3, endSec: 3.4, levelDb: -20 }), { kind: 'focus', index: 1, chars: 5, voice: 'self' });
  session.onInterim({ text: 'hasta el', startSec: 3, endSec: 3.7, levelDb: -20 });
  assert.deepEqual(calls.filter((c) => c[0] === 'focus'), [['focus', 1, 5], ['focus', 1, 8]]);
  // The finished sentence still decides.
  assert.equal(session.onUtterance({ text: 'hasta el viernes', startSec: 3, endSec: 4, levelDb: -20 }).kind, 'picked');
});

test('the other person talking shows their words live, never focuses a reply', async () => {
  const { calls, session } = liveSetup();
  session.onUtterance({ text: '¿Se queda mucho tiempo?', startSec: 0, endSec: 1, levelDb: -50 });
  await new Promise((r) => setTimeout(r, 10));
  // Same words as a reply, but at their (quieter) level.
  assert.equal(session.onInterim({ text: 'hasta el', startSec: 3, endSec: 3.5, levelDb: -50 }).kind, 'theirs-live');
  assert.equal(calls.filter((c) => c[0] === 'focus').length, 0);
  assert.deepEqual(calls.at(-1), ['liveTheirs', 'hasta el']);
});

test('without calibration, a short or ambiguous start does not focus', async () => {
  const { calls, session } = liveSetup({ selfDb: null });
  session.onUtterance({ text: '¿Se queda mucho tiempo?', startSec: 0, endSec: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(session.onInterim({ text: 'so', startSec: 3, endSec: 3.2 })?.kind, 'theirs-live', 'too short to tell');
  assert.equal(session.onInterim({ text: 'solo unos', startSec: 3, endSec: 3.5 })?.kind, 'focus');
  assert.equal(calls.filter((c) => c[0] === 'focus').length, 1);
});

test('a reply split by a pause stays on screen as one pick, until the other person talks', async () => {
  const { calls, session } = liveSetup({ selfDb: null });
  session.onUtterance({ text: '¿Se queda mucho tiempo?', startSec: 0, endSec: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(session.onInterim({ text: 'hasta el', startSec: 3, endSec: 3.6 })?.kind, 'focus');
  // Speech-to-text ends a segment at the pause: already a pick.
  assert.equal(session.onUtterance({ text: 'hasta el', startSec: 3, endSec: 3.8 }).kind, 'picked');
  assert.deepEqual(calls.at(-1), ['focus', 1, 8, false]);
  // The rest of it, in the next segment: same reply, further along.
  assert.equal(session.onInterim({ text: 'viernes', startSec: 4.5, endSec: 5 })?.kind, 'focus');
  assert.equal(session.onUtterance({ text: 'viernes', startSec: 4.5, endSec: 5.2 }).continued, true);
  assert.deepEqual(calls.at(-1), ['focus', 1, 16, true]);
  assert.deepEqual(session.history.map((t) => t.text), ['¿Se queda mucho tiempo?', 'Hasta el viernes']);
  // A short noise doesn't clear it; the other person's words do.
  assert.equal(session.onInterim({ text: 'eh', startSec: 7, endSec: 7.2 }), null);
  assert.ok(!calls.some((c) => c[0] === 'liveTheirs' && c[1] === 'eh'));
  assert.equal(session.onInterim({ text: '¿y cuántas personas?', startSec: 8, endSec: 9 })?.kind, 'theirs-live');
  assert.deepEqual(calls.at(-1), ['liveTheirs', '¿y cuántas personas?']);
});
