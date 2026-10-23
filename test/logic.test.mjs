import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, similarity, bestMatch } from '../plugin/lib/matcher.js';
import { classify, voiceOf } from '../plugin/lib/turns.js';
import { createReplyParser, parseLine, parseBank } from '../plugin/lib/reply-parser.js';

const replies = [
  { text: 'Solo unos días' },
  { text: 'Hasta el viernes' },
  { text: 'Todavía no lo sé' },
];

test('normalize strips accents, case and punctuation', () => {
  assert.equal(normalize('¿Todavía NO lo sé?'), 'todavia no lo se');
  assert.equal(normalize('  Hasta   el\tviernes. '), 'hasta el viernes');
});

test('exact and near-exact speech matches the right reply', () => {
  assert.equal(bestMatch('hasta el viernes', replies).index, 1);
  assert.equal(bestMatch('Todavia no lo se.', replies).index, 2);
  // speech-to-text slip
  assert.equal(bestMatch('hasta el vienes', replies).index, 1);
});

test('saying the reply plus a bit more still counts as picking it', () => {
  const m = bestMatch('Hasta el viernes, ¿y usted?', replies);
  assert.equal(m.index, 1);
});

test('unrelated speech matches nothing', () => {
  assert.equal(bestMatch('¿Dónde está la estación de tren?', replies).index, -1);
  assert.equal(bestMatch('', replies).index, -1);
});

test('a long sentence that merely contains a short reply does not count', () => {
  const short = [{ text: 'Sí' }];
  assert.equal(bestMatch('sí claro pero primero necesito ver su pasaporte por favor', short).index, -1);
});

test('works for non-Latin scripts', () => {
  const ja = [{ text: '金曜日まで' }, { text: 'まだわかりません' }];
  assert.equal(bestMatch('金曜日まで', ja).index, 0);
  assert.ok(similarity('まだわかりません', 'まだ分かりません') > 0.5);
});

test('voiceOf uses calibration only when present', () => {
  assert.equal(voiceOf(-20, null), 'unknown');
  assert.equal(voiceOf(-20, -18), 'self');
  assert.equal(voiceOf(-40, -18), 'other');
});

test('classify: matched reply in own (or unknown) voice is a pick', () => {
  const r = classify({ text: 'hasta el viernes', levelDb: -40, startSec: 5, endSec: 6 },
    { candidates: replies, selfDb: null });
  assert.equal(r.kind, 'picked');
  assert.equal(r.index, 1);
});

test('classify: other person echoing a reply is their turn', () => {
  const r = classify({ text: '¿Hasta el viernes?', levelDb: -42, startSec: 5, endSec: 6 },
    { candidates: replies, selfDb: -20 });
  assert.equal(r.kind, 'theirs');
});

test('classify: unmatched loud speech is the wearer improvising', () => {
  const r = classify({ text: 'Me quedo con mi hermana', levelDb: -19, startSec: 5, endSec: 6 },
    { candidates: replies, selfDb: -20 });
  assert.equal(r.kind, 'mine');
});

test('classify: unmatched speech right after the wearer spoke is a continuation', () => {
  const r = classify({ text: 'y luego me voy', levelDb: null, startSec: 6.3, endSec: 7 },
    { candidates: replies, selfDb: null, lastMineEndSec: 6.0 });
  assert.equal(r.kind, 'mine');
});

test('classify: unmatched speech after a pause, uncalibrated, is theirs', () => {
  const r = classify({ text: '¿Y dónde se queda?', levelDb: null, startSec: 9, endSec: 10 },
    { candidates: replies, selfDb: null, lastMineEndSec: 6.0 });
  assert.equal(r.kind, 'theirs');
});

test('reply parser emits lines as they complete, across arbitrary chunking', () => {
  const items = [];
  const p = createReplyParser((i) => items.push(i));
  const text = 'T: Are you staying long?\n1: Solo unos días | just a few days\n2: Hasta el viernes | until Friday\n3: Todavía no lo sé | I don\'t know yet';
  for (let i = 0; i < text.length; i += 7) p.push(text.slice(i, i + 7));
  assert.equal(items.length, 3, 'last line waits for end()');
  p.end();
  assert.deepEqual(items[0], { type: 'translation', text: 'Are you staying long?' });
  assert.deepEqual(items[2], { type: 'reply', index: 1, text: 'Hasta el viernes', gloss: 'until Friday' });
  assert.equal(items[3].gloss, "I don't know yet");
});

test('reply parser ignores chatter and tolerates format drift', () => {
  assert.equal(parseLine('Sure, here are some options:'), null);
  assert.deepEqual(parseLine('2) Hasta el viernes'), { type: 'reply', index: 1, text: 'Hasta el viernes', gloss: '' });
});

test('bank parser', () => {
  const bank = parseBank('- Sí | yes\n2. ¿Puede repetir? | can you repeat?\n\n');
  assert.equal(bank.length, 2);
  assert.equal(bank[1].text, '¿Puede repetir?');
  assert.equal(bank[1].source, 'bank');
});

test('spoken progress follows the wearer through a reply', async () => {
  const { spokenProgress } = await import('../plugin/lib/matcher.js');
  const at = (s, r) => { const p = spokenProgress(s, r); return [r.slice(0, p.chars), p.done, Number(p.score.toFixed(2))]; };
  assert.deepEqual(at('hasta', 'Hasta el viernes'), ['Hasta', false, 1]);
  assert.deepEqual(at('hasta el', 'Hasta el viernes'), ['Hasta el', false, 1]);
  assert.deepEqual(at('hasta el viernes', 'Hasta el viernes'), ['Hasta el viernes', true, 1]);
  assert.deepEqual(at('un agua por', 'Un agua, por favor'), ['Un agua, por', false, 1]);
  assert.deepEqual(at('駅まで行', '駅まで行きます。'), ['駅まで行', false, 1]);
  assert.deepEqual(at('solo unos', 'Hasta el viernes'), ['', false, 0], 'no match, no progress');
});

test('solo practice (no voice level): your own speech counts as theirs, a reply on screen is still a pick', () => {
  const candidates = [{ text: 'Sí, claro' }, { text: 'No, gracias' }];
  const state = { candidates, selfDb: null, marginDb: 8, lastMineEndSec: null };
  assert.equal(classify({ text: 'لماذا أنت هنا؟', levelDb: -30, startSec: 5, endSec: 6 }, state).kind, 'theirs', 'loud, but no calibration to compare with');
  assert.equal(classify({ text: 'No, gracias', levelDb: -30, startSec: 8, endSec: 9 }, state).kind, 'picked');
  // With calibration, the same loud line is the wearer.
  assert.equal(classify({ text: 'لماذا أنت هنا؟', levelDb: -30, startSec: 5, endSec: 6 }, { ...state, selfDb: -30 }).kind, 'mine');
});
