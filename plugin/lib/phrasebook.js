// Phrasebook: things people are likely to say, each with a translation (or,
// in Q&A assist, a short gist) and three ready replies. A close match answers
// instantly with no API call; Claude is only asked about what the phrasebook
// doesn't cover, and its reusable answers are added back so the next time is
// free.
//
// Entry: { q, t, replies: [{ text, gloss?, reading? }] x3, alts: [string],
//          source, pack, uses }
//   q / alts: what they say (alts: other wordings of the same question)
//   source:  starter (shipped), built ("Build phrasebook"), prep (from your
//            notes, Q&A assist), learned (from conversations)
//   pack:    the group it's stored and boosted with, e.g. "built:hotel"
//
// Lookup doesn't scan every entry: an index from character pairs to entries
// narrows it to the few that share most with what was said, and only those
// are scored. That keeps a 20,000-entry phrasebook at a few milliseconds.

import { prepare, closenessPrepared, normalize } from './matcher.js';
import { splitReply } from './reply-parser.js';

export const MODES = Object.freeze({
  PHRASEBOOK: 'phrasebook', // never call Claude
  HYBRID: 'hybrid',         // phrasebook first, Claude for the rest
  CLAUDE: 'claude',         // Claude every time
});
export const DEFAULT_MODE = MODES.HYBRID;

// A phrasebook answer is shown without checking with Claude, so a wrong
// match costs more than a missed one: keep this strict. At 0.8, "¿Quiere
// algo de beber?" vs "...de comer?" (0.75) correctly misses.
export const MATCH_THRESHOLD = 0.8;
// Below the threshold but this close: worth asking Claude whether it's the
// same question in other words (see pickParaphrase in claude.js).
export const NEAR_THRESHOLD = 0.35;
const SAME_QUESTION = 0.9;   // adding a near-duplicate updates the old entry
export const MAX_ENTRIES = 20000;
const MAX_ALTS = 8;
const PACK_BOOST = 0.03;      // recently used topics rank slightly higher
const SHORTLIST = 40;         // entries scored exactly per lookup
const SOURCES = ['starter', 'built', 'prep', 'learned'];

export const phrasebookKey = (theirLang, myLang) => `phrasebook:${theirLang}:${myLang}`;
export const packKey = (theirLang, myLang, pack) => `${phrasebookKey(theirLang, myLang)}:pack:${pack}`;

function cleanReplies(replies) {
  return (Array.isArray(replies) ? replies : [])
    .map((r) => {
      let text = String(r?.text ?? '').trim();
      // "~ " or verify: from Claude's general knowledge, not the wearer's notes.
      const verify = Boolean(r?.verify) || /^[~〜]\s*/.test(text);
      text = text.replace(/^[~〜]\s*/, '');
      const reply = { text, gloss: String(r?.gloss ?? '').trim() };
      const reading = String(r?.reading ?? '').trim();
      if (reading) reply.reading = reading; // pronunciation, for languages in another script
      if (verify) reply.verify = true;
      return reply;
    })
    .filter((r) => r.text)
    .slice(0, 3);
}

/** Normalize one entry; null if it isn't usable. */
export function cleanEntry(raw, source = 'learned', pack) {
  const q = String(raw?.q ?? '').trim();
  const t = String(raw?.t ?? '').trim();
  const replies = cleanReplies(raw?.replies);
  if (!q || !t || replies.length < 3 || !normalize(q)) return null;
  const src = SOURCES.includes(raw?.source) ? raw.source : source;
  const alts = [...new Set((Array.isArray(raw?.alts) ? raw.alts : []).map((a) => String(a).trim()).filter((a) => normalize(a)))]
    .filter((a) => normalize(a) !== normalize(q))
    .slice(0, MAX_ALTS);
  return {
    q, t, replies, alts,
    source: src,
    pack: String(raw?.pack ?? pack ?? src),
    uses: Number.isFinite(raw?.uses) ? raw.uses : 0,
  };
}

export function createPhrasebook(saved = []) {
  let entries = [];
  // Index: character pair -> entries with a phrasing containing it.
  const index = new Map();
  // Prepared phrasings per entry: [{ text, prep }], computed once, plus the
  // smallest phrasing's pair count (for the shortlist estimate).
  const phrasings = new Map();
  const minPairs = new Map();
  // Exact normalized question -> entry, for fast duplicate checks.
  const byQuestion = new Map();
  const recentPacks = [];
  const dirty = new Set();

  function indexEntry(entry) {
    const list = [entry.q, ...entry.alts].map((text) => ({ text, prep: prepare(text) }));
    phrasings.set(entry, list);
    minPairs.set(entry, Math.min(...list.map((x) => x.prep.grams.size)));
    byQuestion.set(list[0].prep.norm, entry);
    for (const { prep } of list) {
      for (const gram of prep.grams.keys()) {
        let set = index.get(gram);
        if (!set) { set = new Set(); index.set(gram, set); }
        set.add(entry);
      }
    }
  }

  function unindexEntry(entry) {
    for (const { prep } of phrasings.get(entry) ?? []) {
      for (const gram of prep.grams.keys()) index.get(gram)?.delete(entry);
    }
    phrasings.delete(entry);
    minPairs.delete(entry);
    if (byQuestion.get(normalize(entry.q)) === entry) byQuestion.delete(normalize(entry.q));
  }

  /** Entries scored against `text`, best first. */
  function ranked(text, limit = SHORTLIST) {
    const said = prepare(text);
    if (!said.norm) return [];
    // Count shared pairs per entry, then score only the top of that list.
    const shared = new Map();
    // Pairs found in a large share of entries say little about which one
    // matches; skipping them keeps lookups fast in big phrasebooks.
    const common = Math.max(300, entries.length * 0.12);
    const grams = [...said.grams.keys()].map((g) => index.get(g)).filter(Boolean);
    const useful = grams.filter((set) => set.size <= common);
    for (const set of useful.length ? useful : grams) {
      for (const entry of set) shared.set(entry, (shared.get(entry) ?? 0) + 1);
    }
    // Estimate overlap relative to size (like the real score), so long
    // entries that share many common pairs don't crowd out a short exact match.
    const saidPairs = said.grams.size;
    const estimate = ([entry, n]) => (2 * n) / (saidPairs + minPairs.get(entry));
    const shortlist = [...shared]
      .map((pair) => [pair[0], estimate(pair)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([entry]) => entry);
    return shortlist
      .map((entry) => {
        let score = 0;
        for (const { prep } of phrasings.get(entry)) score = Math.max(score, closenessPrepared(said, prep));
        const boost = recentPacks.includes(entry.pack) && score > 0 ? PACK_BOOST : 0;
        return { entry, score: Math.min(1, score + boost), raw: score };
      })
      .sort((a, b) => b.score - a.score);
  }

  function noteUsed(entry) {
    entry.uses += 1;
    const i = recentPacks.indexOf(entry.pack);
    if (i >= 0) recentPacks.splice(i, 1);
    recentPacks.unshift(entry.pack);
    recentPacks.length = Math.min(recentPacks.length, 3);
  }

  /**
   * Bulk adds (starter, built, prep) only merge exact duplicates; single
   * additions (learning) also merge near-duplicates, which needs a search.
   */
  function insert(entry, nearCheck) {
    let existing = byQuestion.get(normalize(entry.q));
    if (!existing && nearCheck) {
      const [best] = ranked(entry.q, 10);
      if (best && best.raw >= SAME_QUESTION) existing = best.entry;
    }
    if (existing) {
      unindexEntry(existing);
      Object.assign(existing, { t: entry.t, replies: entry.replies });
      existing.alts = [...new Set([...existing.alts, ...entry.alts])].slice(0, MAX_ALTS);
      indexEntry(existing);
      dirty.add(existing.pack);
      return;
    }
    entries.push(entry);
    indexEntry(entry);
    dirty.add(entry.pack);
  }

  function prune() {
    if (entries.length <= MAX_ENTRIES) return;
    // Starter, built and prep entries stay; drop the least-used learned ones.
    const learned = entries.filter((e) => e.source === 'learned').sort((a, b) => a.uses - b.uses);
    const drop = new Set(learned.slice(0, entries.length - MAX_ENTRIES));
    for (const e of drop) { unindexEntry(e); dirty.add(e.pack); }
    entries = entries.filter((e) => !drop.has(e));
  }

  for (const raw of Array.isArray(saved) ? saved : []) {
    const entry = cleanEntry(raw);
    if (entry) { entries.push(entry); indexEntry(entry); }
  }

  return {
    get size() { return entries.length; },
    get learnedCount() { return entries.filter((e) => e.source === 'learned').length; },
    count(source) { return entries.filter((e) => e.source === source).length; },

    /** Best entry for what was said, or null below the threshold. */
    lookup(text, threshold = MATCH_THRESHOLD) {
      const [best] = ranked(text);
      if (!best || best.score < threshold) return { entry: null, score: best?.score ?? 0 };
      noteUsed(best.entry);
      return { entry: best.entry, score: best.score };
    },

    /** Closest entries, for asking Claude whether one means the same thing. */
    candidates(text, limit = 12, min = NEAR_THRESHOLD) {
      return ranked(text).filter((c) => c.score >= min).slice(0, limit);
    },

    /** Use an entry chosen some other way (Claude's paraphrase pick). */
    use(entry, newWording) {
      noteUsed(entry);
      if (newWording) this.addWording(entry, newWording);
    },

    /** Remember another way of saying an entry's question. */
    addWording(entry, wording) {
      const w = String(wording ?? '').trim();
      const n = normalize(w);
      if (!n || normalize(entry.q) === n || entry.alts.some((a) => normalize(a) === n)) return false;
      unindexEntry(entry);
      entry.alts = [w, ...entry.alts].slice(0, MAX_ALTS);
      indexEntry(entry);
      dirty.add(entry.pack);
      return true;
    },

    /** Add or update entries. Returns how many were stored. */
    add(items, source = 'learned', pack) {
      let stored = 0;
      const nearCheck = items.length <= 5;
      for (const raw of items) {
        const entry = cleanEntry({ ...raw, source }, source, pack ?? raw?.pack);
        if (!entry) continue;
        insert(entry, nearCheck);
        stored += 1;
      }
      prune();
      return stored;
    },

    /** Remove every entry of a source (e.g. old prep before preparing again). */
    removeSource(source) {
      for (const e of entries.filter((x) => x.source === source)) { unindexEntry(e); dirty.add(e.pack); }
      entries = entries.filter((e) => e.source !== source);
    },

    clear() {
      for (const e of entries) dirty.add(e.pack);
      entries = [];
      index.clear();
      phrasings.clear();
      minPairs.clear();
      byQuestion.clear();
    },

    packs() { return [...new Set(entries.map((e) => e.pack))]; },
    /** Packs changed since the last call, for saving only what changed. */
    takeDirty() { const out = [...dirty]; dirty.clear(); return out; },
    toJSON(pack) {
      return entries
        .filter((e) => pack == null || e.pack === pack)
        .map((e) => ({ ...e, alts: [...e.alts], replies: e.replies.map((r) => ({ ...r })) }));
    },
  };
}

/** Parse Claude's phrasebook JSON (tolerates code fences and stray text). */
export function parsePhrasebook(text, source = 'built') {
  const s = String(text ?? '');
  const start = s.indexOf('[');
  if (start < 0) return [];
  let data = null;
  const end = s.lastIndexOf(']');
  if (end > start) { try { data = JSON.parse(s.slice(start, end + 1)); } catch { /* maybe cut off */ } }
  if (!Array.isArray(data)) {
    // A long answer can be cut off mid-entry: keep every complete entry.
    for (let cut = s.lastIndexOf('}'); cut > start && !Array.isArray(data); cut = s.lastIndexOf('}', cut - 1)) {
      try { data = JSON.parse(`${s.slice(start, cut + 1)}]`); } catch { /* try an earlier entry end */ }
    }
  }
  if (!Array.isArray(data)) return [];
  return data.map((item) => cleanEntry({
    q: item?.q ?? item?.question,
    t: item?.t ?? item?.translation ?? item?.gist,
    alts: item?.alts ?? item?.alternatives,
    replies: (item?.replies ?? item?.answers ?? []).map((r) => (typeof r === 'string' ? splitReply(r) : r)),
  }, source)).filter(Boolean);
}

/**
 * A saved phrasebook with its starter phrases swapped for the current
 * built-in version, so starter fixes reach existing installs. Everything else
 * is kept and wins over a starter for the same question.
 */
export function refreshStarters(saved, starterPhrases = []) {
  const book = createPhrasebook();
  book.add(starterPhrases, 'starter');
  const entries = Array.isArray(saved) ? saved : [];
  for (const source of ['built', 'prep', 'learned']) {
    for (const e of entries.filter((x) => (x?.source ?? 'learned') === source)) book.add([e], source, e.pack);
  }
  book.takeDirty();
  return book;
}

/** Pack name for phrases built for a situation, e.g. "built:hotel-in-madrid". */
export const builtPack = (situation) => `built:${(normalize(situation) || 'travel').replace(/ /g, '-').slice(0, 40)}`;
