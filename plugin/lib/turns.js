import { bestMatch } from './matcher.js';

// Decides who said a finished utterance, without speaker diarization.
//
// Two signals:
//  1. Text: does it match a reply that is on screen (or in the instant bank)?
//  2. Loudness: the wearer's voice reaches a head-worn mic much louder than
//     someone across a table. Only used once the wearer has calibrated.
//
// Plus one timing rule: speech-to-text sometimes splits one sentence into two
// segments. A segment that starts right after the wearer's own segment ended
// is the wearer still talking, not the other person.

export const DEFAULTS = Object.freeze({
  matchThreshold: 0.72,
  marginDb: 8,          // how far below the calibrated self level still counts as "self"
  continuationGapSec: 0.6,
});

export function voiceOf(levelDb, selfDb, marginDb = DEFAULTS.marginDb) {
  if (selfDb == null || levelDb == null || !Number.isFinite(levelDb)) return 'unknown';
  return levelDb >= selfDb - marginDb ? 'self' : 'other';
}

/**
 * @param {{text: string, levelDb: number|null, startSec: number, endSec: number}} utt
 * @param {{
 *   candidates: {text: string, gloss?: string, source?: string}[],
 *   selfDb: number|null,
 *   marginDb?: number,
 *   lastMineEndSec?: number|null,
 * }} state
 * @returns {{kind: 'picked'|'mine'|'theirs'|'ignore', index?: number, score?: number, voice: string}}
 */
export function classify(utt, state, opts = DEFAULTS) {
  const text = (utt.text ?? '').trim();
  const voice = voiceOf(utt.levelDb, state.selfDb, state.marginDb ?? opts.marginDb);
  if (!text) return { kind: 'ignore', voice };

  const match = bestMatch(text, state.candidates ?? [], opts.matchThreshold);

  if (match.index >= 0) {
    // Same words, but clearly not the wearer's voice: the other person is
    // echoing ("¿Hasta el viernes?"). Treat it as their turn.
    if (voice === 'other') return { kind: 'theirs', voice, score: match.score };
    return { kind: 'picked', index: match.index, score: match.score, voice };
  }

  if (voice === 'self') return { kind: 'mine', voice, score: match.score };

  const gap = state.lastMineEndSec == null ? Infinity : utt.startSec - state.lastMineEndSec;
  if (voice === 'unknown' && gap >= 0 && gap < opts.continuationGapSec) {
    return { kind: 'mine', voice, score: match.score };
  }

  return { kind: 'theirs', voice, score: match.score };
}
