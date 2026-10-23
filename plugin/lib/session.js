// Conversation coordinator. Pure logic: hardware, network and UI come in as
// dependencies, so the whole flow can be tested with fakes.
//
// Flow per utterance:
//   their words  -> phrasebook match? show its translation + replies, no API call
//                   otherwise show instant bank replies, stream translation +
//                   3 replies from Claude, and learn them if reusable
//   you say one  -> recognized by text match, HUD shows ✓, wait for their reply
//   you improvise-> recognized by voice level / timing, HUD shows "You: ..."
//   you say it in your own language ("say it in English")
//                -> Claude translates it; it shows like a reply, you read it out

import { classify, voiceOf } from './turns.js';
import { spokenProgress, normalize } from './matcher.js';
import { MODES, DEFAULT_MODE } from './phrasebook.js';

// Bank order is fixed by the bank prompt (see claude.js):
// 0 yes, 1 no, 2 don't understand, 3 repeat, 4 slower, 5 one moment,
// 6 thanks, 7 sorry, 8 don't know, 9 okay.
const INSTANT_SLOTS = [3, 4, 5];

export function createSession({ hud, suggest, pick = null, translate = null, levels, getSettings, phrasebook = null, onLearned = () => {}, log = () => {}, now = () => Date.now() }) {
  const history = [];        // completed turns: { who: 'them'|'me', text }
  let bank = [];
  let shown = [];            // replies currently on the HUD
  let pendingTheirs = '';    // their current turn, may grow across segments
  let lastMineEndSec = null;
  let inflight = null;
  let focused = null;        // index of the reply the wearer is saying, while they say it
  let unconfirmed = null;    // { entry, wording } from a paraphrase match, until the wearer uses it
  // The reply being said, on screen until they talk: { reply, index, heard,
  // base: chars covered by finished segments, done, chars: incl. live words }
  let saying = null;

  const mode = () => getSettings().replyMode ?? DEFAULT_MODE;

  const candidates = () => [...shown.filter((r) => r?.text), ...bank];

  function abortInflight() {
    inflight?.abort();
    inflight = null;
  }

  function closeTheirTurn() {
    if (pendingTheirs) history.push({ who: 'them', text: pendingTheirs });
    pendingTheirs = '';
  }

  /** Answer from the phrasebook if it has a close match. */
  function answerFromPhrasebook(latest) {
    const { entry, score } = phrasebook.lookup(latest);
    log({ type: 'phrasebook', hit: Boolean(entry), score, q: entry?.q, text: latest });
    if (!entry) return false;
    abortInflight();
    shown = entry.replies.map((r) => ({ ...r, source: 'phrasebook' }));
    focused = null;
    hud.theirTurn(entry.t, shown, latest);
    log({ type: 'translation', text: entry.t });
    return true;
  }

  /**
   * Alongside the reply request: ask whether what was said is a saved
   * question in other words. If it is, show the saved answer, cancel the
   * reply request, and remember the new wording so it matches directly next
   * time.
   */
  function checkParaphrase(latest, near, controller, progress) {
    pick({ said: latest, options: near.map((c) => c.entry.q), signal: controller.signal })
      .then((i) => {
        if (controller.signal.aborted || inflight !== controller) return;
        if (i < 0) { log({ type: 'pick', hit: false, options: near.length }); return; }
        const { entry } = near[i];
        // Claude's own answer is already on screen: it's tailored to what was
        // said, so keep it rather than swapping to a saved one.
        if (progress.started) { log({ type: 'pick', hit: false, late: true, q: entry.q, options: near.length }); return; }
        log({ type: 'pick', hit: true, q: entry.q, text: latest, options: near.length });
        abortInflight();
        phrasebook.use(entry);
        // Remember this wording only once the wearer uses one of the answers.
        unconfirmed = { entry, wording: latest };
        shown = entry.replies.map((r) => ({ ...r, source: 'phrasebook' }));
        focused = null;
        hud.theirTurn(entry.t, shown, latest);
        log({ type: 'translation', text: entry.t });
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') log({ type: 'pick', hit: false, error: error.message });
      });
  }

  async function requestReplies({ useClaude = false } = {}) {
    const latest = pendingTheirs;
    unconfirmed = null;
    saying = null;
    const instant = INSTANT_SLOTS.map((i) => bank[i]).filter(Boolean);
    const m = mode();
    // Saved questions close to what was said, for the paraphrase check below.
    let near = [];

    if (!useClaude && m !== MODES.CLAUDE) {
      if (phrasebook && answerFromPhrasebook(latest)) return;
      near = phrasebook?.candidates?.(latest) ?? [];
      if (m === MODES.PHRASEBOOK) {
        // No translation without Claude: show their words as heard.
        abortInflight();
        shown = [...instant];
        focused = null;
        hud.theirTurn(latest, instant);
        return;
      }
    }

    abortInflight();
    const controller = new AbortController();
    inflight = controller;
    shown = [...instant];
    focused = null;
    hud.theirTurn('...', instant, latest);
    const progress = { started: false };
    if (near.length && pick) checkParaphrase(latest, near, controller, progress);
    const started = now();
    let first = true;
    let translation = '';
    let reusable = false;
    const replies = [];
    try {
      log({ type: 'claude-request', text: latest });
      await suggest({
        history: history.slice(),
        latest,
        signal: controller.signal,
        onItem(item) {
          if (controller.signal.aborted) return;
          if (first) { log({ type: 'latency', ms: now() - started }); first = false; progress.started = true; }
          if (item.type === 'translation') {
            translation = item.text;
            hud.translation(item.text);
            log({ type: 'translation', text: item.text });
          } else if (item.type === 'reply') {
            const reply = { text: item.text, gloss: item.gloss, ...(item.reading ? { reading: item.reading } : {}), ...(item.verify ? { verify: true } : {}) };
            shown[item.index] = { ...reply, source: 'claude' };
            replies[item.index] = reply;
            hud.reply(item.index, shown[item.index]);
          } else if (item.type === 'reusable') {
            reusable = item.value;
          }
        },
      });
      if (!controller.signal.aborted) {
        log({ type: 'replies', replies: shown.slice() });
        const complete = translation && [0, 1, 2].every((i) => replies[i]?.text);
        if (phrasebook && reusable && complete && phrasebook.add([{ q: latest, t: translation, replies }]) > 0) {
          log({ type: 'learned', q: latest });
          onLearned();
        }
      }
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      log({ type: 'error', where: 'claude', message: error.message, code: error.code });
      hud.translation(`(${error.message})`);
    } finally {
      if (inflight === controller) inflight = null;
    }
  }

  /**
   * "Say it in English", while the wearer is still talking (or before):
   * cancel the reply request and show what they're saying so far.
   */
  function ownDraft(text) {
    abortInflight();
    saying = null;
    unconfirmed = null;
    shown = [];
    focused = 0;
    hud.say?.({ text: '...', gloss: text });
  }

  /** Record the finished segments of the reply so far. */
  function setHeard(heard) {
    const p = spokenProgress(heard, saying.reply.text);
    Object.assign(saying, { heard, base: p.chars, done: p.done });
    return p;
  }

  /**
   * Is `text` (newer speech) more of the reply being said? Only while it's
   * unfinished: after that, new words are the other person (or the wearer
   * going on), handled as usual.
   */
  function continues(text) {
    if (!saying || saying.done) return null;
    const p = spokenProgress(`${saying.heard} ${text}`, saying.reply.text);
    return p.score >= 0.6 && p.chars >= saying.base ? p : null;
  }

  function showSaying(progress) {
    saying.chars = progress.chars;
    hud.focus?.(saying.index, progress.chars, progress.done);
  }

  /**
   * The wearer picked `chosen` by starting to say it. Record it, and keep it
   * on screen (what's said dims) until the other person starts talking:
   * speech-to-text often finishes a segment at a pause mid-reply.
   */
  function startSaying(chosen, utt) {
    // Saying a saved answer confirms the paraphrase match: keep the wording.
    if (unconfirmed && unconfirmed.entry.replies.some((r) => r.text === chosen.text)) {
      if (phrasebook.addWording(unconfirmed.entry, unconfirmed.wording)) {
        log({ type: 'learned', q: unconfirmed.wording });
        onLearned();
      }
    }
    unconfirmed = null;
    abortInflight();
    closeTheirTurn();
    history.push({ who: 'me', text: chosen.text });
    lastMineEndSec = utt.endSec;
    let index = shown.findIndex((r) => r?.text === chosen.text);
    if (index < 0) {
      // A stock reply that wasn't on screen: put it there.
      hud.say?.(chosen);
      index = 0;
    }
    shown = [];
    focused = index;
    saying = { reply: chosen, index, chars: 0 };
    showSaying(setHeard(utt.text));
  }

  return {
    get history() { return history; },
    get shown() { return shown; },
    setBank(items) { bank = Array.isArray(items) ? items : []; },

    /** Handle one finished utterance from speech-to-text. */
    onUtterance(utt) {
      const settings = getSettings();
      const levelDb = utt.levelDb ?? levels?.levelBetween(utt.startSec, utt.endSec) ?? null;
      const voice = voiceOf(levelDb, settings.selfDb ?? null, settings.marginDb);
      const text = (utt.text ?? '').trim();

      // More of the reply the wearer is saying (speech-to-text split it at a pause).
      if (text && voice !== 'other' && continues(text)) {
        const p = setHeard(`${saying.heard} ${text}`);
        lastMineEndSec = utt.endSec;
        showSaying(p);
        const result = { kind: 'picked', continued: true, score: p.score, voice };
        log({ type: 'utterance', text: utt.text, levelDb, ...result });
        return result;
      }
      // A pause partway through the reply in focus: that's a pick already.
      const inFocus = !saying && focused != null ? shown[focused] : null;
      if (inFocus?.text && text && voice !== 'other') {
        const p = spokenProgress(text, inFocus.text);
        if (p.score >= (voice === 'self' ? 0.6 : 0.75)) {
          const result = { kind: 'picked', index: focused, score: p.score, voice };
          log({ type: 'utterance', text: utt.text, levelDb, ...result });
          startSaying(inFocus, utt);
          return result;
        }
      }

      const result = classify(
        { ...utt, levelDb },
        { candidates: candidates(), selfDb: settings.selfDb ?? null, marginDb: settings.marginDb, lastMineEndSec },
      );
      log({ type: 'utterance', text: utt.text, levelDb, ...result });
      if (result.kind === 'mine' || result.kind === 'theirs') saying = null;

      switch (result.kind) {
        case 'picked': {
          startSaying(candidates()[result.index], utt);
          return result;
        }
        case 'mine': {
          abortInflight();
          closeTheirTurn();
          // Merge with the wearer's previous segment when it's a continuation.
          const last = history[history.length - 1];
          if (last?.who === 'me' && lastMineEndSec != null && utt.startSec - lastMineEndSec < 0.6) last.text += ` ${utt.text}`;
          else history.push({ who: 'me', text: utt.text });
          shown = [];
          focused = null;
          lastMineEndSec = utt.endSec;
          hud.mine(utt.text);
          return result;
        }
        case 'theirs': {
          // Long turns arrive as several segments; keep extending the same turn
          // until the wearer answers, and re-ask with the fuller text.
          pendingTheirs = pendingTheirs ? `${pendingTheirs} ${utt.text}` : utt.text;
          requestReplies();
          return result;
        }
        default:
          return result;
      }
    },

    /**
     * Speech still in progress (an interim transcript). Two things can
     * happen while someone is mid-sentence:
     *  - the wearer is clearly saying one of the replies on screen: focus on
     *    it (the others make way) and track how far along they are;
     *  - otherwise it's the other person: show their words as they come.
     * The finished utterance (onUtterance) still makes the real decision.
     */
    onInterim(partial) {
      const text = (partial?.text ?? '').trim();
      if (!text) return null;
      const settings = getSettings();
      const levelDb = partial.levelDb ?? levels?.levelBetween(partial.startSec, partial.endSec) ?? null;
      const voice = voiceOf(levelDb, settings.selfDb ?? null, settings.marginDb);

      // Still saying the reply they picked: follow along.
      const more = voice !== 'other' ? continues(text) : null;
      if (more) {
        if (more.chars !== saying.chars) showSaying(more);
        return { kind: 'focus', index: saying.index, chars: more.chars, voice };
      }

      const replies = shown.map((r, index) => ({ r, index })).filter(({ r }) => r?.text);
      if (voice !== 'other' && replies.length && normalize(text).length >= 3) {
        const scored = replies
          .map(({ r, index }) => ({ index, ...spokenProgress(text, r.text) }))
          .sort((a, b) => b.score - a.score);
        const [best, next] = scored;
        // Without calibration we can't tell voices apart, so ask for more
        // certainty before deciding it's the wearer.
        const needed = voice === 'self' ? 0.6 : 0.75;
        const clear = focused === best.index || !next || best.score - next.score >= 0.15;
        if (best.score >= needed && clear) {
          focused = best.index;
          hud.focus?.(best.index, best.chars);
          return { kind: 'focus', index: best.index, chars: best.chars, voice };
        }
      }
      // The other person talking. A reply the wearer just said stays up until
      // then; a sound or two (under 4 letters) doesn't count.
      if (voice !== 'self' && (focused == null || saying) && (!saying || normalize(text).length >= 4)) {
        saying = null;
        focused = null;
        hud.liveTheirs?.(text);
        return { kind: 'theirs-live', voice };
      }
      return null;
    },

    ownDraft,

    /**
     * "Say it in English": none of the replies fit, so the wearer said what
     * they want in their own language. Show it translated, as a reply to
     * read out; saying it then counts as picking it.
     */
    async ownWords(text) {
      const said = (text ?? '').trim();
      if (!said || !translate) return;
      ownDraft(said);
      const controller = new AbortController();
      inflight = controller;
      log({ type: 'own-request', text: said });
      try {
        const reply = await translate({ text: said, history: history.slice(), signal: controller.signal });
        if (controller.signal.aborted) return;
        shown = [{ ...reply, source: 'own' }];
        focused = 0;
        hud.say?.(shown[0]);
        log({ type: 'own', text: reply.text, gloss: said });
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') return;
        log({ type: 'error', where: 'claude', message: error.message, code: error.code });
        hud.say?.({ text: '...', gloss: `Couldn't translate: ${error.message}` });
      } finally {
        if (inflight === controller) inflight = null;
      }
    },

    /**
     * Temple button: ask Claude about the current turn, even if the
     * phrasebook answered it (unless Claude is turned off).
     */
    refresh() {
      if (pendingTheirs) requestReplies({ useClaude: mode() !== MODES.PHRASEBOOK });
    },

    /**
     * Leaving "say it in English" without saying anything: show the
     * replies to their turn again. False if there's no turn to go back to.
     */
    restore() {
      abortInflight();
      focused = null;
      if (!pendingTheirs) { shown = []; return false; }
      requestReplies();
      return true;
    },

    clear() {
      abortInflight();
      saying = null;
      closeTheirTurn();
      shown = [];
      focused = null;
    },

    stop() { abortInflight(); },
  };
}
