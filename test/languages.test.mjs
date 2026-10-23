import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, SPOKEN_LANGUAGES, AUTO, AUTO_DETECT_LANGS, nameOf, detectedCode, isRtl } from '../plugin/lib/languages.js';
import { createSegmenter } from '../plugin/lib/stt.js';
import { scriptFor, assistSystemPrompt, prepPrompt } from '../plugin/lib/claude.js';
import { parseLine } from '../plugin/lib/reply-parser.js';
import { createPhrasebook } from '../plugin/lib/phrasebook.js';
import { replyText } from '../plugin/lib/hud.js';

test('Arabic, Chinese and others are offered; auto-detect first', () => {
  const codes = LANGUAGES.map(([c]) => c);
  for (const c of ['ar', 'ar-EG', 'zh', 'zh-TW', 'zh-HK', 'ko', 'he', 'fa', 'ur', 'tr', 'vi', 'th']) assert.ok(codes.includes(c), c);
  assert.equal(SPOKEN_LANGUAGES[0][0], AUTO);
  assert.equal(new Set(codes).size, codes.length, 'no duplicate codes');
  assert.equal(AUTO_DETECT_LANGS.length, 10);
});

test('names and detected tags map to listed languages', () => {
  assert.equal(nameOf('ar-EG'), 'Arabic (Egypt)');
  assert.equal(nameOf('es-MX'), 'Spanish', 'unlisted region falls back to the base language');
  assert.equal(detectedCode('es'), 'es');
  assert.equal(detectedCode('pt-BR'), 'pt-BR');
  assert.equal(detectedCode('de-AT'), 'de');
  assert.equal(detectedCode('xx'), null);
  assert.equal(detectedCode(''), null);
});

test('right-to-left scripts are recognized', () => {
  assert.equal(isRtl('مرحبا'), true);
  assert.equal(isRtl('שלום'), true);
  assert.equal(isRtl('Hola'), false);
  assert.equal(isRtl('こんにちは'), false);
});

test('scripts and pronunciation rules cover the new languages, regions fall back', () => {
  assert.match(scriptFor('ar-EG').script, /Arabic/);
  assert.match(scriptFor('zh').reading, /Pinyin.*tone numbers/);
  assert.match(scriptFor('zh-HK').reading, /Jyutping/);
  assert.equal(scriptFor('es'), null);
  assert.equal(scriptFor('fr-CA'), null);
});

test('auto-detect: each finished sentence carries the language spoken most', () => {
  const out = [];
  const interims = [];
  const seg = createSegmenter((u) => out.push(u), (t, timing) => interims.push(timing.language));
  const result = (text, lang, isFinal, speechFinal = false) => ({
    type: 'Results', is_final: isFinal, speech_final: speechFinal, start: 0, duration: 1,
    channel: { alternatives: [{ transcript: text, languages: [lang], words: text.split(' ').map((w, i) => ({ word: w, start: i, end: i + 0.5, language: lang })) }] },
  });
  seg.handle(result('hola qué', 'es', false));
  seg.handle(result('hola qué tal', 'es', true));
  seg.handle(result('ok', 'en', true, true));
  assert.deepEqual(interims, ['es']);
  assert.equal(out[0].language, 'es', 'three Spanish words beat one English one');
  seg.handle({ type: 'Results', is_final: true, speech_final: true, start: 0, duration: 1, channel: { alternatives: [{ transcript: 'hello', words: [] }] } });
  assert.equal(out[1].language, undefined, 'no language info: none reported');
});

test('"~ " marks a point from general knowledge, kept through the phrasebook', () => {
  assert.deepEqual(parseLine('2: ~ I believe it launched in 2024, worth verifying'), { type: 'reply', index: 1, text: 'I believe it launched in 2024, worth verifying', gloss: '', verify: true });
  assert.equal(parseLine('1: From the notes').verify, undefined);
  const book = createPhrasebook();
  book.add([{ q: 'When did it launch?', t: 'Launch date?', replies: [{ text: '~ Around 2024' }, { text: 'Not in my notes' }, { text: 'I can follow up' }] }], 'prep', 'prep');
  assert.deepEqual(book.lookup('When did it launch?').entry.replies[0], { text: 'Around 2024', gloss: '', verify: true });
  assert.equal(replyText({ text: 'Around 2024', verify: true }), '(verify) Around 2024');
});

test('general-knowledge Q&A asks for marked points; notes-only forbids them', () => {
  const general = assistSystemPrompt({ language: 'English', notes: 'x', general: true })[0].text;
  assert.match(general, /start every such point with "~ "/);
  assert.match(general, /never invent specifics about the wearer's own company/);
  assert.match(assistSystemPrompt({ language: 'English', notes: 'x' })[0].text, /never invent facts/);
  assert.match(prepPrompt({ language: 'English', general: true }), /points starting "~ "/);
});
