import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, parseBank, splitReply } from '../plugin/lib/reply-parser.js';
import { replyText, clip } from '../plugin/lib/hud.js';
import { suggestionSystemPrompt, phrasebookPrompt, scriptFor } from '../plugin/lib/claude.js';
import { STARTERS, starterFor } from '../plugin/lib/starter-phrasebooks.js';
import { createPhrasebook, MATCH_THRESHOLD, parsePhrasebook } from '../plugin/lib/phrasebook.js';
import { closeness } from '../plugin/lib/matcher.js';

const eki = { text: '駅はどこですか', reading: 'eki wa doko desu ka', gloss: 'where is the station?' };

test('reply lines with a pronunciation part keep all three pieces', () => {
  assert.deepEqual(parseLine('1: 駅はどこですか | eki wa doko desu ka | where is the station?'), { type: 'reply', index: 0, ...eki });
  assert.deepEqual(parseLine('2: Hasta el viernes | until Friday'), { type: 'reply', index: 1, text: 'Hasta el viernes', gloss: 'until Friday' });
  assert.deepEqual(splitReply('はい | | yes'), { text: 'はい', gloss: 'yes' }, 'an empty pronunciation is dropped');
  assert.equal(parseBank('はい | hai | yes')[0].reading, 'hai');
});

test('replies in another script always show how to say them; learning mode splits Latin ones too', () => {
  assert.equal(replyText(eki), '駅はどこですか\neki wa doko desu ka - where is the station?');
  assert.equal(replyText(eki, { learning: true }), '駅はどこですか\neki wa doko desu ka - where is the station?');
  // Latin-script languages have no pronunciation line.
  assert.equal(replyText({ text: 'Tres noches', gloss: 'three nights' }, { learning: true }), 'Tres noches\nthree nights');
  assert.equal(clip('a  b\n\n c', 160), 'a b\nc', 'line breaks survive clipping');
});

test('Claude is asked for native script plus pronunciation only for other scripts', () => {
  const ja = suggestionSystemPrompt({ theirLanguage: 'Japanese', myLanguage: 'English', script: scriptFor('ja') });
  assert.match(ja, /kanji and kana/);
  assert.match(ja, /romaji in plain ASCII/);
  const es = suggestionSystemPrompt({ theirLanguage: 'Spanish', myLanguage: 'English', script: scriptFor('es') });
  assert.doesNotMatch(es, /pronunciation/);
  assert.match(phrasebookPrompt({ theirLanguage: 'Korean', myLanguage: 'English', script: scriptFor('ko') }), /"reading"/);
});

test('phrasebook JSON from Claude keeps readings', () => {
  const [entry] = parsePhrasebook(JSON.stringify([{ q: '駅はどこですか', t: 'Where is the station?', replies: [eki, { ...eki, text: 'あそこです' }, { ...eki, text: 'わかりません' }] }]));
  assert.equal(entry.replies[0].reading, 'eki wa doko desu ka');
});

for (const [pair, starter] of Object.entries(STARTERS)) {
  test(`starter phrasebook ${pair}: complete, unambiguous, and every phrase finds itself`, () => {
    assert.equal(starter.bank.length, 10, 'bank order is fixed at 10 replies');
    assert.ok(starter.phrases.length >= 35);
    const book = createPhrasebook(starter.phrases);
    assert.equal(book.size, starter.phrases.length, 'every entry is valid');
    for (const p of starter.phrases) {
      assert.equal(book.lookup(p.q).entry?.q, p.q, `"${p.q}" should match itself`);
      for (const other of starter.phrases) {
        if (other !== p) assert.ok(closeness(p.q, other.q) < MATCH_THRESHOLD, `"${p.q}" and "${other.q}" are too close`);
      }
    }
    if (pair.startsWith('ja:')) {
      for (const r of [...starter.bank, ...starter.phrases.flatMap((p) => p.replies)]) {
        assert.ok(r.reading, `"${r.text}" needs a reading`);
        assert.match(r.reading, /^[\x20-\x7e]+$/, `"${r.reading}" must be plain ASCII for the glasses font`);
      }
    }
  });
}

test('starters are looked up by language pair', () => {
  assert.ok(starterFor('ja', 'en'));
  assert.equal(starterFor('ja', 'fr'), null);
});

test('Claude requests turn thinking off and fail visibly on unreadable or empty answers', async () => {
  const { streamSuggestions } = await import('../plugin/lib/claude.js');
  const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  let sent;
  const run = (events) => streamSuggestions({
    conn: { apiKey: 'test-key' }, settings: { theirLanguage: 'Japanese', myLanguage: 'English', script: scriptFor('ja') },
    history: [], latest: 'こんにちは', onItem: () => {},
    fetchImpl: async (url, init) => { sent = JSON.parse(init.body); return sse(events); },
  });
  // Hidden thinking used the whole budget: no text at all.
  await assert.rejects(run([
    { type: 'message_start' },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
  ]), /empty reply \(stop reason: max_tokens/);
  assert.deepEqual(sent.thinking, { type: 'disabled' });
  // Text that isn't in the expected format.
  await assert.rejects(run([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Sure! Here are some replies' } }]), /Unreadable reply/);
  // Full-width punctuation from a Japanese answer still parses.
  const items = [];
  await streamSuggestions({
    conn: { apiKey: 'test-key' }, settings: { theirLanguage: 'Japanese', myLanguage: 'English', script: scriptFor('ja') },
    history: [], latest: 'x', onItem: (i) => items.push(i),
    fetchImpl: async () => sse([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'T：Where to?\n１：駅です｜eki desu｜the station\n' } }]),
  });
  assert.deepEqual(items.map((i) => i.type), ['translation', 'reply']);
  assert.equal(items[1].reading, 'eki desu');
});

test('starter replies fit the second line of a learning-mode box', () => {
  for (const [pair, starter] of Object.entries(STARTERS)) {
    for (const r of [...starter.bank, ...starter.phrases.flatMap((p) => p.replies)]) {
      const second = [r.reading, r.gloss].filter(Boolean).join(' - ');
      assert.ok(second.length <= 57, `${pair}: "${second}" is ${second.length} chars, more than one line`);
    }
  }
});
