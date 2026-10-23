// Fuzzy matching between what was heard and the replies on screen.
// Character bigrams work for any script (Latin, CJK, Cyrillic) and tolerate
// the small spelling slips speech-to-text makes ("vienes" for "viernes").

export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')            // drop accents: "días" -> "dias"
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')   // punctuation and symbols -> space
    .trim()
    .replace(/\s+/g, ' ');
}

function bigrams(text) {
  const s = text.replace(/ /g, '');
  const counts = new Map();
  if (s.length === 1) counts.set(s, 1);
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
}

function overlap(a, b) {
  let shared = 0;
  for (const [g, n] of a) shared += Math.min(n, b.get(g) ?? 0);
  return shared;
}

function total(m) {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}

/**
 * Plain bigram overlap 0..1, with no credit for one text containing the
 * other. For "is this the same question?", where extra words change meaning.
 */
export function closeness(a, b) {
  return closenessPrepared(prepare(a), prepare(b));
}

/** Precompute what closeness() needs, for texts compared many times. */
export function prepare(text) {
  const norm = normalize(text);
  const grams = bigrams(norm);
  return { norm, grams, total: total(grams) };
}

export function closenessPrepared(x, y) {
  if (!x.norm || !y.norm) return 0;
  if (x.norm === y.norm) return 1;
  return (2 * overlap(x.grams, y.grams)) / (x.total + y.total);
}

const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/**
 * How far into a reply someone is, from what they've said so far (an interim
 * transcript). Compares what was said with each prefix of the reply: at word
 * ends for spaced languages, at every character for Japanese and similar.
 * Returns the best prefix score, how many characters of the original reply
 * that covers, and whether it's the whole reply.
 */
export function spokenProgress(spoken, reply) {
  const s = normalize(spoken);
  const { text: r, ends } = normalizeMapped(reply);
  if (!s || !r) return { score: 0, chars: 0, done: false };
  const cuts = [];
  if (NO_SPACES.test(r)) {
    for (let i = 1; i <= r.length; i += 1) cuts.push(i);
  } else {
    for (let i = 1; i < r.length; i += 1) if (r[i] === ' ') cuts.push(i);
    cuts.push(r.length);
  }
  let best = { score: 0, cut: 0 };
  for (const cut of cuts) {
    const score = closeness(s, r.slice(0, cut));
    // Ties go to the longer prefix: "hasta el" is further along than "hasta".
    if (score > best.score || (score > 0 && score === best.score)) best = { score, cut };
  }
  return {
    score: best.score,
    chars: best.cut ? ends[best.cut - 1] : 0,
    done: best.cut > 0 && best.cut >= r.length,
  };
}

/**
 * normalize(), plus where each normalized character ends in the original
 * string, so a position in one maps exactly to the other.
 */
function normalizeMapped(text) {
  let out = '';
  const ends = [];
  let pos = 0;
  for (const ch of String(text ?? '')) {
    pos += ch.length;
    const n = ch.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
    for (const c of n) {
      if (c === ' ' && (!out || out.endsWith(' '))) continue;
      out += c;
      ends.push(pos);
    }
  }
  while (out.endsWith(' ')) { out = out.slice(0, -1); ends.pop(); }
  return { text: out, ends };
}

/** Similarity 0..1 between an utterance and one candidate reply. */
export function similarity(utterance, candidate) {
  const u = normalize(utterance);
  const c = normalize(candidate);
  if (!u || !c) return 0;
  if (u === c) return 1;
  const ub = bigrams(u);
  const cb = bigrams(c);
  const shared = overlap(ub, cb);
  const ut = total(ub);
  const ct = total(cb);
  const dice = (2 * shared) / (ut + ct);
  // The wearer often says the reply and then keeps talking ("Hasta el viernes,
  // ¿y usted?"). Credit full coverage of the candidate, but only when the
  // utterance is not wildly longer than it.
  const coverage = shared / ct;
  const containment = ct >= 3 && ut <= ct * 3 ? coverage * 0.9 : 0;
  return Math.max(dice, containment);
}

/**
 * Best match among candidate replies.
 * @param {string} utterance
 * @param {{text: string}[]} candidates
 * @returns {{index: number, score: number}}  index -1 when nothing is close
 */
export function bestMatch(utterance, candidates, threshold = 0.72) {
  let index = -1;
  let score = 0;
  candidates.forEach((candidate, i) => {
    const s = similarity(utterance, candidate.text);
    if (s > score) { score = s; index = i; }
  });
  return score >= threshold ? { index, score } : { index: -1, score };
}
