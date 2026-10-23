import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhrasebook, parsePhrasebook, MODES } from '../plugin/lib/phrasebook.js';
import { createSession } from '../plugin/lib/session.js';
import { parseLine } from '../plugin/lib/reply-parser.js';

const R = (...pairs) => pairs.map(([text, gloss]) => ({ text, gloss }));

const drinks = {
  q: '¿Quiere algo de beber?', t: 'Would you like something to drink?',
  replies: R(['Un agua, por favor', 'a water, please'], ['No, gracias', 'no, thanks'], ['¿Qué tiene?', 'what do you have?']),
};
const nights = {
  q: '¿Cuántas noches se queda?', t: 'How many nights are you staying?',
  replies: R(['Tres noches', 'three nights'], ['Solo una', 'just one'], ['¿Hay descuento?', 'is there a discount?']),
};

test('matches the same question despite accents, punctuation and small rewording', () => {
  const book = createPhrasebook([drinks, nights]);
  assert.equal(book.lookup('cuantas noches se queda').entry?.t, nights.t);
  assert.equal(book.lookup('¿Cuántas noches se va a quedar?').entry?.t, nights.t);
});

test('a question that differs in one key word does not match', () => {
  const book = createPhrasebook([drinks]);
  const { entry, score } = book.lookup('¿Quiere algo de comer?');
  assert.equal(entry, null, `"comer" must not reuse the "beber" answer (score ${score.toFixed(2)})`);
});

test('unrelated speech does not match', () => {
  const book = createPhrasebook([drinks, nights]);
  assert.equal(book.lookup('¿Dónde está la estación de tren?').entry, null);
});

test('learning the same question again updates it instead of adding a copy', () => {
  const book = createPhrasebook([nights]);
  book.add([{ ...nights, q: 'cuantas noches se queda', t: 'How many nights will you stay?' }]);
  assert.equal(book.size, 1);
  assert.equal(book.lookup('¿Cuántas noches se queda?').entry.t, 'How many nights will you stay?');
  // A merely similar question is kept separately rather than overwriting.
  book.add([{ ...nights, q: '¿Cuántas noches se queda usted?' }]);
  assert.equal(book.size, 2);
});

test('incomplete entries are rejected and the book survives a save/load round trip', () => {
  const book = createPhrasebook();
  assert.equal(book.add([{ q: 'Hola', t: 'Hi', replies: R(['Hola', 'hi']) }]), 0, 'needs three replies');
  book.add([drinks], 'starter');
  const reloaded = createPhrasebook(JSON.parse(JSON.stringify(book.toJSON())));
  assert.equal(reloaded.size, 1);
  assert.equal(reloaded.learnedCount, 0);
});

test('parses Claude phrasebook JSON, even inside a code fence', () => {
  const text = 'Here you go:\n```json\n' + JSON.stringify([drinks, { q: 'bad' }]) + '\n```';
  const entries = parsePhrasebook(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, 'built');
  assert.deepEqual(parsePhrasebook('not json'), []);
});

test('parses the reusable flag from streamed replies', () => {
  assert.deepEqual(parseLine('R: yes'), { type: 'reusable', value: true });
  assert.deepEqual(parseLine('R: no, depends on the booking'), { type: 'reusable', value: false });
});

// ---- session integration

function fakeHud() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return { calls, status: rec('status'), theirTurn: rec('theirTurn'), translation: rec('translation'), reply: rec('reply'), picked: rec('picked'), mine: rec('mine') };
}

function fakeClaude(lines) {
  const calls = [];
  return {
    calls,
    suggest: async ({ latest, onItem }) => { calls.push(latest); for (const item of lines) onItem(item); },
  };
}

const claudeAnswer = (reusable) => [
  { type: 'translation', text: 'Do you have a reservation?' },
  { type: 'reply', index: 0, text: 'Sí, a nombre de Khai', gloss: 'yes, under Khai' },
  { type: 'reply', index: 1, text: 'No, no tengo', gloss: 'no, I don\'t' },
  { type: 'reply', index: 2, text: '¿Hay habitaciones libres?', gloss: 'any rooms free?' },
  { type: 'reusable', value: reusable },
];

function setup({ mode, entries = [drinks, nights], reusable = true }) {
  const hud = fakeHud();
  const claude = fakeClaude(claudeAnswer(reusable));
  const book = createPhrasebook(entries);
  let learned = 0;
  const logs = [];
  const session = createSession({
    hud, suggest: claude.suggest, phrasebook: book, onLearned: () => { learned += 1; },
    getSettings: () => ({ replyMode: mode, selfDb: -20, marginDb: 8 }),
    log: (e) => logs.push(e),
  });
  const say = (text, t) => session.onUtterance({ text, startSec: t, endSec: t + 1, levelDb: -50 });
  return { hud, claude, book, session, say, logs, learned: () => learned };
}

test('hybrid: a phrasebook match answers with no Claude call', async () => {
  const s = setup({ mode: MODES.HYBRID });
  s.say('¿Cuántas noches se queda?', 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.claude.calls.length, 0);
  const turn = s.hud.calls.find((c) => c[0] === 'theirTurn');
  assert.equal(turn[1], nights.t);
  assert.equal(turn[2][0].text, 'Tres noches');
  assert.equal(s.session.shown[0].source, 'phrasebook');
});

test('hybrid: no match goes to Claude, and a reusable answer is learned', async () => {
  const s = setup({ mode: MODES.HYBRID });
  s.say('¿Tiene una reserva?', 0);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.claude.calls, ['¿Tiene una reserva?']);
  assert.equal(s.learned(), 1);
  assert.equal(s.book.lookup('¿Tiene una reserva?').entry?.t, 'Do you have a reservation?');
});

test('answers Claude marks as conversation-specific are not learned', async () => {
  const s = setup({ mode: MODES.HYBRID, reusable: false });
  s.say('¿Tiene una reserva?', 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.learned(), 0);
  assert.equal(s.book.size, 2);
});

test('phrasebook only: a miss never calls Claude and shows their words', async () => {
  const s = setup({ mode: MODES.PHRASEBOOK });
  s.say('¿Tiene una reserva?', 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.claude.calls.length, 0);
  assert.equal(s.hud.calls.find((c) => c[0] === 'theirTurn')[1], '¿Tiene una reserva?');
});

test('Claude every time: skips the phrasebook', async () => {
  const s = setup({ mode: MODES.CLAUDE });
  s.say('¿Cuántas noches se queda?', 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.claude.calls.length, 1);
});

test('the temple button asks Claude about a phrasebook answer', async () => {
  const s = setup({ mode: MODES.HYBRID });
  s.say('¿Cuántas noches se queda?', 0);
  s.session.refresh();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.claude.calls, ['¿Cuántas noches se queda?']);
});

test('saying a phrasebook reply counts as picking it', async () => {
  const s = setup({ mode: MODES.HYBRID });
  s.say('¿Cuántas noches se queda?', 0);
  const result = s.session.onUtterance({ text: 'Tres noches', startSec: 3, endSec: 4, levelDb: -20 });
  assert.equal(result.kind, 'picked');
});

test('loading swaps in the current starter phrases and keeps built and learned ones', async () => {
  const { refreshStarters } = await import('../plugin/lib/phrasebook.js');
  const oldStarter = { ...nights, t: 'old wording', source: 'starter' };
  const learned = { ...drinks, source: 'learned', uses: 4 };
  const built = { q: '¿Tiene una reserva?', t: 'Do you have a reservation?', replies: drinks.replies, source: 'built' };
  const book = refreshStarters([oldStarter, learned, built], [{ ...nights, t: 'new wording' }]);
  assert.equal(book.size, 3);
  assert.equal(book.lookup('¿Cuántas noches se queda?').entry.t, 'new wording');
  assert.equal(book.learnedCount, 1);
  // A starter that's gone from the plugin is gone from the book too.
  assert.equal(refreshStarters([oldStarter], []).size, 0);
});
