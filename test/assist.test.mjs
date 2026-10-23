import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhrasebook, parsePhrasebook, builtPack, MODES } from '../plugin/lib/phrasebook.js';
import { createSession } from '../plugin/lib/session.js';
import { assistSystemPrompt, pickParaphrase, prepPrompt } from '../plugin/lib/claude.js';

const R = (...texts) => texts.map((text) => ({ text, gloss: '' }));
const pricing = {
  q: 'How much does it cost?', t: 'Price?', alts: ['What is the price?'],
  replies: R('Nine dollars a month per seat', 'Annual plans are two months free', 'Volume discounts above fifty seats'),
};
const security = {
  q: 'Is our data encrypted?', t: 'Encryption?',
  replies: R('Yes, at rest and in transit', 'We use per-customer keys', 'SOC 2 report available on request'),
};

test('other wordings ("alts") match like the main question', () => {
  const book = createPhrasebook();
  book.add([pricing, security], 'prep', 'prep');
  assert.equal(book.lookup('what is the price').entry?.q, pricing.q);
  // A different detail isn't the same question: no direct match, only a
  // candidate for the rewording check (where Claude can say "no").
  assert.equal(book.lookup('What is the price of shipping?').entry, null);
  assert.equal(book.candidates('What is the price of shipping?')[0].entry.q, pricing.q);
});

test('near misses are offered as candidates, and a confirmed wording is remembered', () => {
  const book = createPhrasebook();
  book.add([pricing, security], 'prep', 'prep');
  const said = 'how much will this cost us';
  assert.equal(book.lookup(said).entry, null);
  const [first] = book.candidates(said);
  assert.equal(first.entry.q, pricing.q);
  book.use(first.entry, said);
  assert.equal(book.lookup(said).entry?.q, pricing.q, 'matches directly next time');
});

test('packs: entries are grouped, changes are tracked per pack, a source can be replaced', () => {
  const book = createPhrasebook();
  book.add([pricing], 'built', builtPack('Product demo for investors'));
  book.add([security], 'prep', 'prep');
  assert.deepEqual(book.packs().sort(), ['built:product-demo-for-investors', 'prep']);
  assert.deepEqual(book.takeDirty().sort(), ['built:product-demo-for-investors', 'prep']);
  assert.deepEqual(book.takeDirty(), []);
  book.removeSource('prep');
  assert.deepEqual(book.takeDirty(), ['prep']);
  assert.equal(book.toJSON('prep').length, 0);
  // Saved and loaded back, entries keep their pack and wordings.
  const again = createPhrasebook(book.toJSON());
  assert.equal(again.toJSON()[0].pack, 'built:product-demo-for-investors');
});

test('a large phrasebook stays fast and accurate', () => {
  const syl = ['ba', 'ce', 'di', 'fo', 'gu', 'la', 'me', 'ni', 'po', 'ru', 'sa', 'te', 'vi', 'zo', 'que', 'tra'];
  const word = (i) => syl[i % 16] + syl[(i >> 4) % 16] + syl[(i >> 8) % 16];
  const filler = Array.from({ length: 5000 }, (_, i) => ({
    q: `How ${word(i)} the ${word(i * 7 + 3)} ${word(i * 13 + 5)}?`, t: `t${i}`, replies: R('a', 'b', 'c'),
  }));
  const book = createPhrasebook();
  const t0 = performance.now();
  book.add([...filler, pricing], 'built', 'built:big');
  const built = performance.now() - t0;
  const t1 = performance.now();
  for (let i = 0; i < 20; i += 1) assert.equal(book.lookup('How much does it cost?').entry?.q, pricing.q);
  const perLookup = (performance.now() - t1) / 20;
  assert.ok(built < 5000, `building 5,000 entries took ${built.toFixed(0)} ms`);
  assert.ok(perLookup < 25, `lookup took ${perLookup.toFixed(1)} ms`);
});

// ---- the rewording check inside a session

function hud() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return { calls, status: rec('status'), theirTurn: rec('theirTurn'), translation: rec('translation'), reply: rec('reply'), picked: rec('picked'), mine: rec('mine') };
}

function slowClaude() {
  const calls = [];
  return {
    calls,
    suggest: ({ latest, signal, onItem }) => new Promise((resolve, reject) => {
      calls.push(latest);
      const timer = setTimeout(() => { onItem({ type: 'translation', text: 'from Claude' }); resolve(); }, 50);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    }),
  };
}

function setup(pickAnswer) {
  const h = hud();
  const claude = slowClaude();
  const book = createPhrasebook();
  book.add([pricing, security], 'prep', 'prep');
  const picks = [];
  let learned = 0;
  const session = createSession({
    hud: h, suggest: claude.suggest, phrasebook: book, onLearned: () => { learned += 1; },
    pick: async ({ said, options }) => { picks.push({ said, options }); return pickAnswer(options); },
    getSettings: () => ({ replyMode: MODES.HYBRID, selfDb: -20, marginDb: 8 }),
  });
  return { h, claude, book, picks, session, learned: () => learned };
}

test('a reworded question is answered from the phrasebook and the reply request is cancelled', async () => {
  const s = setup((options) => options.indexOf(pricing.q));
  s.session.onUtterance({ text: 'how much will this cost us', startSec: 0, endSec: 1, levelDb: -50 });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(s.picks.length, 1);
  const turns = s.h.calls.filter((c) => c[0] === 'theirTurn');
  assert.equal(turns.at(-1)[1], pricing.t, 'the saved answer is shown');
  assert.equal(s.h.calls.some((c) => c[0] === 'translation' && c[1] === 'from Claude'), false, 'Claude reply was cancelled');
});

test('when the rewording check finds nothing, Claude answers as usual', async () => {
  const s = setup(() => -1);
  s.session.onUtterance({ text: 'how much will this cost us', startSec: 0, endSec: 1, levelDb: -50 });
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(s.h.calls.some((c) => c[0] === 'translation' && c[1] === 'from Claude'));
});

test('nothing close in the phrasebook: no rewording check at all', async () => {
  const s = setup(() => 0);
  s.session.onUtterance({ text: 'zzz qqq xxx', startSec: 0, endSec: 1, levelDb: -50 });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(s.picks.length, 0);
});

// ---- Claude prompts for Q&A assist

test('Q&A assist puts the notes last with a cache marker', () => {
  const blocks = assistSystemPrompt({ language: 'English', notes: 'Price: $9/seat.', situation: 'Investor demo' });
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].text, /never invent facts/);
  assert.match(blocks[1].text, /\$9\/seat/);
  assert.deepEqual(blocks[1].cache_control, { type: 'ephemeral' });
  assert.equal(assistSystemPrompt({ language: 'English', notes: '' }).length, 1, 'no notes, no notes block');
  assert.match(prepPrompt({ language: 'English' }), /"alts"/);
});

test('prepared questions parse with their wordings', () => {
  const [entry] = parsePhrasebook(JSON.stringify([{ ...pricing, alts: ['Price?', 'What does it run?'] }]), 'prep');
  assert.equal(entry.source, 'prep');
  assert.deepEqual(entry.alts, ['Price?', 'What does it run?']);
});

test('the rewording check reads a number and ignores anything else', async () => {
  const reply = (text) => async () => new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { headers: { 'content-type': 'application/json' } });
  const ask = (text) => pickParaphrase({ conn: { apiKey: 'test-key' }, said: 'x', options: ['a', 'b', 'c'], fetchImpl: reply(text) });
  assert.equal(await ask('2'), 1);
  assert.equal(await ask('0'), -1);
  assert.equal(await ask('7'), -1, 'out of range');
  assert.equal(await ask('none of them'), -1);
});

test('a late rewording match does not replace an answer Claude is already showing', async () => {
  const h = hud();
  const book = createPhrasebook();
  book.add([pricing], 'prep', 'prep');
  const session = createSession({
    hud: h, phrasebook: book,
    suggest: async ({ onItem }) => { onItem({ type: 'translation', text: 'tailored' }); await new Promise((r) => setTimeout(r, 40)); },
    pick: () => new Promise((r) => setTimeout(() => r(0), 20)),
    getSettings: () => ({ replyMode: MODES.HYBRID, selfDb: -20, marginDb: 8 }),
  });
  session.onUtterance({ text: 'how much will this cost us', startSec: 0, endSec: 1, levelDb: -50 });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(h.calls.filter((c) => c[0] === 'theirTurn').at(-1)[1], '...', 'still the Claude turn');
  assert.ok(h.calls.some((c) => c[0] === 'translation' && c[1] === 'tailored'));
});

test('a rewording is only remembered after the wearer uses one of its answers', async () => {
  const s = setup((options) => options.indexOf(pricing.q));
  s.session.onUtterance({ text: 'how much will this cost us', startSec: 0, endSec: 1, levelDb: -50 });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(s.book.lookup('how much will this cost us').entry, null, 'not learned yet');
  assert.equal(s.session.onUtterance({ text: 'Nine dollars a month per seat', startSec: 3, endSec: 4, levelDb: -20 }).kind, 'picked');
  assert.equal(s.book.lookup('how much will this cost us').entry?.q, pricing.q, 'learned once confirmed');
  assert.equal(s.learned(), 1);
});
