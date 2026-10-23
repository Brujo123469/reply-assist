// Languages: what Deepgram's Nova-3 model can transcribe live (codes are
// Deepgram's), which ones its auto-detect covers, and which are written
// right to left.

export const AUTO = 'multi';

// Nova-3 "multi" follows speakers switching between these ten, mid-sentence.
export const AUTO_DETECT_LANGS = ['en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl'];

/** [code, name], sorted by name. */
export const LANGUAGES = [
  ['af', 'Afrikaans'], ['ar', 'Arabic'], ['ar-EG', 'Arabic (Egypt)'], ['ar-MA', 'Arabic (Morocco)'],
  ['ar-SA', 'Arabic (Saudi Arabia)'], ['ar-AE', 'Arabic (UAE)'], ['hy', 'Armenian'], ['bn', 'Bengali'],
  ['bg', 'Bulgarian'], ['zh-HK', 'Cantonese'], ['ca', 'Catalan'], ['zh', 'Chinese (Mandarin, Simplified)'],
  ['zh-TW', 'Chinese (Mandarin, Traditional)'], ['hr', 'Croatian'], ['cs', 'Czech'], ['da', 'Danish'],
  ['nl', 'Dutch'], ['en', 'English'], ['et', 'Estonian'], ['fi', 'Finnish'], ['fr', 'French'],
  ['ka', 'Georgian'], ['de', 'German'], ['el', 'Greek'], ['gu', 'Gujarati'], ['he', 'Hebrew'],
  ['hi', 'Hindi'], ['hu', 'Hungarian'], ['id', 'Indonesian'], ['it', 'Italian'], ['ja', 'Japanese'],
  ['kn', 'Kannada'], ['ko', 'Korean'], ['lv', 'Latvian'], ['lt', 'Lithuanian'], ['ms', 'Malay'],
  ['mr', 'Marathi'], ['no', 'Norwegian'], ['fa', 'Persian'], ['pl', 'Polish'], ['pt', 'Portuguese'],
  ['pt-BR', 'Portuguese (Brazil)'], ['pa', 'Punjabi'], ['ro', 'Romanian'], ['ru', 'Russian'],
  ['sr', 'Serbian'], ['sk', 'Slovak'], ['sl', 'Slovenian'], ['es', 'Spanish'], ['es-419', 'Spanish (Latin America)'],
  ['sv', 'Swedish'], ['tl', 'Tagalog'], ['ta', 'Tamil'], ['te', 'Telugu'], ['th', 'Thai'], ['tr', 'Turkish'],
  ['uk', 'Ukrainian'], ['ur', 'Urdu'], ['vi', 'Vietnamese'],
];

/** For "They speak": auto-detect first, then every language. */
export const SPOKEN_LANGUAGES = [[AUTO, 'Auto-detect (10 major languages)'], ...LANGUAGES];

/** For "You read". */
export const READ_LANGUAGES = LANGUAGES;

export function nameOf(code) {
  if (code === AUTO) return 'Auto-detect';
  return LANGUAGES.find(([c]) => c === code)?.[1]
    ?? LANGUAGES.find(([c]) => c === String(code ?? '').split('-')[0])?.[1]
    ?? code;
}

/** Deepgram reports "es" or "es-ES"; keep the base code we list. */
export function detectedCode(tag) {
  const t = String(tag ?? '').trim();
  if (!t) return null;
  if (LANGUAGES.some(([c]) => c === t)) return t;
  const base = t.split('-')[0].toLowerCase();
  return LANGUAGES.some(([c]) => c === base) ? base : null;
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
/** Hebrew, Arabic, Persian, Urdu... are written right to left. */
export const isRtl = (text) => RTL.test(String(text ?? ''));
