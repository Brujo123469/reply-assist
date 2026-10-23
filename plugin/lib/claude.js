// Claude API calls: streamed reply suggestions, the instant reply bank and
// the phrasebook. They go either through your Reply Assist server (which
// holds the API key) or, in developer mode, straight to api.anthropic.com
// with a key stored in the plugin.

import { createReplyParser, parseBank } from './reply-parser.js';
import { parsePhrasebook } from './phrasebook.js';

export const DEFAULT_MODEL = 'claude-haiku-5-5'; // fastest current model; latency matters more than depth here

// Haiku 5.5 thinks before answering unless told not to. These are short,
// formatted answers where speed matters, and hidden thinking can use up the
// whole max_tokens budget before any reply text is written.
const NO_THINKING = Object.freeze({ type: 'disabled' });
const API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Where to send a request. conn is { server, token } for your server, or
 * { apiKey } for direct calls.
 */
export function claudeEndpoint(conn = {}) {
  if (conn.server) {
    if (!conn.token) throw Object.assign(new Error('Add your app token in Settings'), { code: 'NO_APP_TOKEN' });
    return {
      url: `${conn.server.replace(/\/+$/, '')}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${conn.token}`,
        'anthropic-version': '2023-06-01',
      },
    };
  }
  if (!conn.apiKey) throw Object.assign(new Error('Add a Claude API key in Settings'), { code: 'NO_CLAUDE_KEY' });
  return {
    url: API_URL,
    headers: {
      'content-type': 'application/json',
      'x-api-key': conn.apiKey,
      'anthropic-version': '2023-06-01',
      // Required for calls made from a browser. The key lives only in this
      // plugin's private storage on your phone.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  };
}

async function post(conn, body, { signal, fetchImpl }) {
  const { url, headers } = claudeEndpoint(conn);
  const response = await fetchImpl(url, { method: 'POST', headers, signal, body: JSON.stringify(body) });
  if (!response.ok) throw await failFromResponse(response);
  return response;
}

// Languages written in a non-Latin script: replies come in that script, with a
// pronunciation in plain ASCII letters (the glasses font may lack macrons).
const ascii = (what) => `${what} in plain ASCII letters, no accents or tone marks`;
// Arabic script leaves most vowels out, so a letter-by-letter transliteration
// is still hard to say. Spell it the way it sounds, for the wearer's language.
const respell = (examples) => (reader) => `a phonetic respelling someone who reads ${reader} can say out loud without knowing the script: plain ASCII letters, syllables joined by hyphens, the stressed syllable in CAPITALS, "kh" for the rasping h, "gh" for the gargled r, an apostrophe for a catch in the throat (e.g. ${examples})`;
const SCRIPTS = {
  ja: { script: 'normal Japanese writing (kanji and kana, as a native speaker writes it; never romaji)', reading: 'Hepburn romaji in plain ASCII, long vowels as ou/uu, no macrons' },
  zh: { script: 'Simplified Chinese characters', reading: 'Hanyu Pinyin in plain ASCII with tone numbers (ni3 hao3)' },
  'zh-TW': { script: 'Traditional Chinese characters', reading: 'Hanyu Pinyin in plain ASCII with tone numbers (ni3 hao3)' },
  'zh-HK': { script: 'Traditional Chinese characters, written Cantonese', reading: 'Jyutping with tone numbers (nei5 hou2)' },
  ko: { script: 'Hangul', reading: ascii('Revised Romanization') },
  ru: { script: 'Cyrillic', reading: ascii('Latin transliteration') },
  uk: { script: 'Cyrillic', reading: ascii('Latin transliteration') },
  bg: { script: 'Cyrillic', reading: ascii('Latin transliteration') },
  el: { script: 'Greek', reading: ascii('Latin transliteration') },
  ar: { script: 'Arabic script', reading: respell('SHOOK-ran, keef HAA-lak, ma-as-sa-LAA-ma') },
  fa: { script: 'Persian (Arabic script)', reading: respell('mer-SEE, KHOO-bee, mam-NOON') },
  ur: { script: 'Urdu (Arabic script)', reading: respell('shuk-REE-ya, aap KAI-se hain') },
  he: { script: 'Hebrew', reading: ascii('simple Latin transliteration') },
  hi: { script: 'Devanagari', reading: ascii('Latin transliteration') },
  mr: { script: 'Devanagari', reading: ascii('Latin transliteration') },
  bn: { script: 'Bengali script', reading: ascii('Latin transliteration') },
  ta: { script: 'Tamil script', reading: ascii('Latin transliteration') },
  te: { script: 'Telugu script', reading: ascii('Latin transliteration') },
  kn: { script: 'Kannada script', reading: ascii('Latin transliteration') },
  gu: { script: 'Gujarati script', reading: ascii('Latin transliteration') },
  pa: { script: 'Gurmukhi', reading: ascii('Latin transliteration') },
  th: { script: 'Thai', reading: ascii('Royal Thai romanization') },
  ka: { script: 'Georgian', reading: ascii('Latin transliteration') },
  hy: { script: 'Armenian', reading: ascii('Latin transliteration') },
};
/**
 * Script and pronunciation rules for a language code ("ar-EG" falls back to
 * "ar"). reader: the language the wearer reads, for spelled-out pronunciations.
 */
export function scriptFor(code, reader = 'English') {
  const s = SCRIPTS[code] ?? SCRIPTS[String(code ?? '').split('-')[0]] ?? null;
  return s && { script: s.script, reading: typeof s.reading === 'function' ? s.reading(reader) : s.reading };
}

/** Format of one reply line, with a pronunciation part when needed. */
function replyFormat(theirLanguage, myLanguage, script) {
  return script
    ? `<reply in ${theirLanguage}, in ${script.script}> | <its pronunciation: ${script.reading}> | <its meaning in ${myLanguage}>`
    : `<reply in ${theirLanguage}> | <its meaning in ${myLanguage}>`;
}

export function suggestionSystemPrompt({ theirLanguage, myLanguage, situation, script = null }) {
  return [
    `You help someone wearing display glasses hold a spoken conversation in ${theirLanguage}.`,
    `The wearer reads ${myLanguage}. They will say one of your replies out loud, so replies must be easy to pronounce for a learner.`,
    situation ? `Situation: ${situation}` : '',
    '',
    'Output exactly five lines and nothing else:',
    `T: <the other person's latest words, translated into ${myLanguage}>`,
    `1: ${replyFormat(theirLanguage, myLanguage, script)}`,
    `2: ${replyFormat(theirLanguage, myLanguage, script)}`,
    `3: ${replyFormat(theirLanguage, myLanguage, script)}`,
    'R: <yes if these three replies would suit anyone saying those exact words in any conversation; no if they depend on this conversation>',
    '',
    'Rules for replies:',
    '- At most 8 words each. Natural spoken register, not textbook.',
    '- The three must differ in intent, not wording: e.g. accept or answer, decline or "not yet", and ask a question back. Never three ways of saying the same thing.',
    '- Stay consistent with what the wearer already said earlier in the conversation.',
    '- If the latest words are unclear or cut off, make one reply a polite request to repeat.',
  ].filter((line, i, all) => line || all[i - 1]).join('\n');
}

/**
 * Q&A assist: same language, the wearer answering questions (presenting,
 * interviews) with their own notes as the source. The notes go last in the
 * system prompt with a cache marker, so repeat calls reuse them cheaply.
 */
export function assistSystemPrompt({ language, notes, situation, general = false }) {
  const source = general
    ? [
      'Use their notes below first. When the notes do not cover something, you may answer from your own general knowledge:',
      'start every such point with "~ " and phrase it as the wearer\'s best understanding, e.g. "~ I believe it\'s around..., worth verifying".',
      'Never present your own knowledge as coming from the notes, and never invent specifics about the wearer\'s own company or product that the notes do not state.',
    ]
    : ['Base answers on their notes below. If the notes do not cover it, one point should say so honestly and offer to follow up; never invent facts, numbers or names.'];
  const rules = [
    `You help someone wearing display glasses answer questions out loud, in ${language}, while they present or are interviewed.`,
    situation ? `Setting: ${situation}` : '',
    ...source,
    '',
    'Output exactly five lines and nothing else:',
    'T: <the question, restated in at most 8 words>',
    '1: <first answer point, a phrase they can say, at most 14 words>',
    '2: <a second, different point or angle, at most 14 words>',
    '3: <a third: a supporting detail, example, or a bridge back to their topic, at most 14 words>',
    'R: <yes if these points would suit anyone asking those exact words at any point in the talk; no if they depend on this exchange>',
    '',
    'The three points must not repeat each other. Stay consistent with what the wearer already said.',
  ].filter((line, i, all) => line || all[i - 1]).join('\n');
  const blocks = [{ type: 'text', text: rules }];
  if (notes?.trim()) {
    blocks.push({ type: 'text', text: `The wearer's notes:\n<notes>\n${notes.trim()}\n</notes>`, cache_control: { type: 'ephemeral' } });
  }
  return blocks;
}

export const PREP_SIZE = 40;

export function prepPrompt({ language, situation, general = false, count = PREP_SIZE }) {
  return [
    `From the notes above, list the ${count} questions an audience is most likely to ask${situation ? ` (setting: ${situation})` : ''}, in ${language}.`,
    'Include easy, probing and skeptical questions. For each:',
    '- "q": the question as someone would say it out loud;',
    '- "alts": two other common ways people would ask the same thing;',
    '- "t": the question restated in at most 8 words;',
    '- "replies": three different answer points from the notes, each a phrase they can say, at most 14 words.',
    general
      ? 'If the notes do not answer a likely question, answer from general knowledge with points starting "~ " (best understanding, worth verifying).'
      : 'If the notes do not answer a likely question, make one point an honest "not covered, I can follow up".',
    '',
    'Output only a JSON array, no commentary:',
    '[{"q": "...", "alts": ["...", "..."], "t": "...", "replies": [{"text": "..."}, {"text": "..."}, {"text": "..."}]}]',
  ].join('\n');
}

/** One Claude call: likely questions with answer points, from the wearer's notes. */
export async function fetchPrep({ conn, model = DEFAULT_MODEL, language, notes, situation, general = false, signal, fetchImpl = fetch }) {
  const response = await post(conn, {
    model,
    max_tokens: 12000,
    thinking: NO_THINKING,
    system: assistSystemPrompt({ language, notes, situation, general }),
    messages: [{ role: 'user', content: prepPrompt({ language, situation, general }) }],
  }, { signal, fetchImpl });
  return parsePhrasebook(responseText(await response.json()), 'prep');
}

/**
 * The "decision" step: does what was said mean the same as one of these
 * saved questions? A tiny request (a number back), run alongside the normal
 * reply request so it costs no waiting. Returns the option index, or -1.
 */
export async function pickParaphrase({ conn, model = DEFAULT_MODEL, said, options, signal, fetchImpl = fetch }) {
  if (!options?.length) return -1;
  const response = await post(conn, {
    model,
    max_tokens: 8,
    thinking: NO_THINKING,
    system: 'You match what someone said to a list of saved questions. Answer with one number only.',
    messages: [{
      role: 'user',
      content: [
        `Someone said: "${said}"`,
        '',
        'Which saved question asks the same thing, so its saved answers would fully answer what was said?',
        'Small wording differences are fine. Answer 0 if what was said adds or changes a detail the saved question does not cover: a specific use, situation, person, group, item, number, place or time (for example "for doctors" or "in Japan").',
        ...options.map((q, i) => `${i + 1}. ${q}`),
        '',
        'Answer with the number, or 0 if none of them.',
      ].join('\n'),
    }],
  }, { signal, fetchImpl });
  const n = Number.parseInt(responseText(await response.json()).match(/\d+/)?.[0] ?? '0', 10);
  return n >= 1 && n <= options.length ? n - 1 : -1;
}

/** "Say it in English": what the wearer said, in the other person's language. */
export function ownWordsPrompt({ theirLanguage, myLanguage, script = null }) {
  return [
    `The wearer of display glasses is in a spoken conversation in ${theirLanguage}. They said what they want to say in ${myLanguage}; give it in ${theirLanguage} so they can read it out loud.`,
    'Natural spoken register that fits the conversation, short and easy to pronounce for a learner. Keep their meaning; do not add to it or answer it.',
    '',
    'Output exactly one line and nothing else:',
    script ? `<it in ${theirLanguage}, in ${script.script}> | <its pronunciation: ${script.reading}>` : `<it in ${theirLanguage}>`,
  ].join('\n');
}

/**
 * None of the replies fit, so the wearer said what they want in their own
 * language. Returns it in the other person's language as a reply to read
 * out: { text, reading?, gloss } (gloss is what they said).
 */
export async function translateOwn({ conn, model = DEFAULT_MODEL, text, theirLanguage, myLanguage, script = null, history = [], signal, fetchImpl = fetch }) {
  const lines = history.slice(-6).map((turn) => `${turn.who === 'them' ? 'Them' : 'Wearer'}: ${turn.text}`);
  const response = await post(conn, {
    model,
    max_tokens: 300,
    thinking: NO_THINKING,
    system: ownWordsPrompt({ theirLanguage, myLanguage, script }),
    messages: [{
      role: 'user',
      content: [...(lines.length ? ['Conversation so far:', ...lines, ''] : []), `What the wearer wants to say: ${text}`].join('\n'),
    }],
  }, { signal, fetchImpl });
  const line = responseText(await response.json()).normalize('NFKC').split('\n')
    .map((l) => l.replace(/\*\*/g, '').replace(/^\s*(?:1[:.]\s*)?["“]?|["”]?\s*$/g, '')).find(Boolean) ?? '';
  const [said, reading] = line.split('|').map((s) => s.trim());
  if (!said) throw Object.assign(new Error('Claude didn\'t return a translation'), { code: 'BAD_FORMAT' });
  return { text: said, ...(script && reading ? { reading } : {}), gloss: text };
}

/** Turn the running conversation into one user message. */
export function conversationMessage(history, latest) {
  const lines = history.slice(-10).map((turn) =>
    turn.who === 'them' ? `Them: ${turn.text}` : `Wearer: ${turn.text}`);
  return [
    lines.length ? `Conversation so far:\n${lines.join('\n')}` : 'This is the start of the conversation.',
    '',
    `Their latest words: ${latest}`,
  ].join('\n');
}

/**
 * Read an Anthropic SSE stream, calling onText for each text delta. Returns
 * what's needed to explain an empty answer: the stop reason and event types.
 */
export async function readSse(response, onText) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stopReason = null;
  const types = new Map();
  const handle = (event) => {
    const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data) return;
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }
    types.set(parsed.type, (types.get(parsed.type) ?? 0) + 1);
    if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') onText(parsed.delta.text);
    if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
    if (parsed.type === 'error') throw Object.assign(new Error(parsed.error?.message ?? 'Claude stream error'), { code: parsed.error?.type });
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      handle(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  if (buffer.trim()) handle(buffer);
  return { stopReason, events: [...types].map(([t, n]) => `${t} ${n}`).join(', ') || 'none' };
}

async function failFromResponse(response) {
  let message = `Claude API error ${response.status}`;
  try {
    const body = await response.json();
    if (body?.error?.message) message = body.error.message;
  } catch { /* not JSON */ }
  // 401 from your server means the app token; from Anthropic, the API key.
  const code = response.status === 401 ? (/token/i.test(message) ? 'BAD_APP_TOKEN' : 'BAD_CLAUDE_KEY')
    : response.status === 429 ? 'LIMIT' : `HTTP_${response.status}`;
  return Object.assign(new Error(message), { code });
}

const responseText = (body) => (body.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

/**
 * Stream a translation plus three replies. onItem fires per completed line:
 *   { type: 'translation', text }, { type: 'reply', index, text, gloss },
 *   or { type: 'reusable', value } (whether the replies fit any conversation)
 */
export const SUGGEST_TIMEOUT_MS = 20000;

export async function streamSuggestions({ conn, model = DEFAULT_MODEL, settings, history, latest, signal, onItem, fetchImpl = fetch, timeoutMs = SUGGEST_TIMEOUT_MS }) {
  // A stuck request should end in a visible error, not a screen of "...".
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  signal?.addEventListener('abort', () => timeout.abort(), { once: true });
  try {
    await streamSuggestionsOnce({ conn, model, settings, history, latest, signal: timeout.signal, onItem, fetchImpl });
  } catch (error) {
    if (timeout.signal.aborted && !signal?.aborted) {
      throw Object.assign(new Error(`Claude didn't answer within ${timeoutMs / 1000} s`), { code: 'TIMEOUT' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function streamSuggestionsOnce({ conn, model, settings, history, latest, signal, onItem, fetchImpl }) {
  const response = await post(conn, {
    model,
    max_tokens: settings.assist ? 260 : settings.script ? 320 : 230,
    thinking: NO_THINKING,
    stream: true,
    system: settings.assist ? assistSystemPrompt(settings) : suggestionSystemPrompt(settings),
    messages: [{ role: 'user', content: conversationMessage(history, latest) }],
  }, { signal, fetchImpl });
  let items = 0;
  let raw = '';
  const parser = createReplyParser((item) => { items += 1; onItem(item); });
  const { stopReason, events } = await readSse(response, (text) => { raw += text; parser.push(text); });
  parser.end();
  if (!items && !signal?.aborted) {
    // Don't fail silently: show what came back so the problem can be found.
    const start = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
    throw Object.assign(new Error(start
      ? `Unreadable reply from Claude: "${start}"`
      : `Claude sent an empty reply (stop reason: ${stopReason ?? 'none'}; events: ${events}; content-type: ${response.headers.get('content-type')})`), { code: 'BAD_FORMAT' });
  }
}

/** One-time list of universal replies for a language, shown instantly. */
export async function fetchReplyBank({ conn, model = DEFAULT_MODEL, theirLanguage, myLanguage, script = null, signal, fetchImpl = fetch }) {
  const response = await post(conn, {
    model,
    max_tokens: 400,
    thinking: NO_THINKING,
    system: 'Output only the requested lines. No numbering, no commentary.',
    messages: [{
      role: 'user',
      content: `Give 10 short, universal spoken replies in ${theirLanguage} that a traveler can use in almost any conversation, in this order: yes; no; I don't understand; could you repeat that; more slowly please; one moment; thank you; sorry; I don't know; okay, sounds good.\n` +
        `One per line, formatted exactly as: ${replyFormat(theirLanguage, myLanguage, script)}`,
    }],
  }, { signal, fetchImpl });
  return parseBank(responseText(await response.json()));
}

export const PHRASEBOOK_SIZE = 40;  // per build; build again for more situations

export function phrasebookPrompt({ theirLanguage, myLanguage, situation, script = null, count = PHRASEBOOK_SIZE }) {
  return [
    `List the ${count} things someone is most likely to say to a visitor ${situation ? `in this situation: ${situation}` : 'while traveling (greetings, hotels, restaurants, shops, directions, transport, small talk)'}.`,
    `Write each as they would say it out loud in ${theirLanguage}, with its meaning in ${myLanguage}, and three short spoken replies in ${theirLanguage} with their meanings in ${myLanguage}.`,
    'The three replies must differ in intent (e.g. answer or accept, decline or "not yet", ask a question back). At most 8 words each, easy to pronounce for a learner.',
    'Only include things whose replies make sense without knowing the rest of the conversation.',
    'In "alts", give two other common ways people say the same thing, so it is recognized however it is phrased.',
    ...(script ? [`Write "q", "alts" and every reply in ${script.script}. Give each reply's pronunciation in "reading" (${script.reading}).`] : []),
    '',
    'Output only a JSON array, no commentary:',
    script
      ? '[{"q": "<what they say>", "alts": ["<another way>", "<another way>"], "t": "<meaning>", "replies": [{"text": "<reply>", "reading": "<pronunciation>", "gloss": "<meaning>"}, {...}, {...}]}]'
      : '[{"q": "<what they say>", "alts": ["<another way>", "<another way>"], "t": "<meaning>", "replies": [{"text": "<reply>", "gloss": "<meaning>"}, {...}, {...}]}]',
  ].join('\n');
}

/** One Claude call that drafts a starter phrasebook for a situation. */
export async function fetchPhrasebook({ conn, model = DEFAULT_MODEL, theirLanguage, myLanguage, situation, script = null, signal, fetchImpl = fetch }) {
  const response = await post(conn, {
    model,
    max_tokens: 12000,
    thinking: NO_THINKING,
    system: 'You write phrasebooks as JSON. Output only valid JSON.',
    messages: [{ role: 'user', content: phrasebookPrompt({ theirLanguage, myLanguage, situation, script }) }],
  }, { signal, fetchImpl });
  return parsePhrasebook(responseText(await response.json()));
}
