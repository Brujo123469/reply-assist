// Glasses HUD layout (600 x 350, monochrome green).
//
//   ┌──────────────────────────────────────────┐
//   │ Are you staying in the city long?        │  id 1: what they said (translated)
//   ├──────────────────────────────────────────┤
//   │ Solo unos días                           │  id 2
//   │ just a few days                          │
//   ├──────────────────────────────────────────┤
//   │ Hasta el viernes                         │  id 3
//   │ until Friday                             │
//   ├──────────────────────────────────────────┤
//   │ Todavía no lo sé                         │  id 4
//   │ I don't know yet                         │
//   └──────────────────────────────────────────┘
//
// No source-language line: you just heard it. That space goes to text size.
//
// Side by side: their words in a column on the left, replies on the right.
// (The glasses show one image to both eyes, so "left lens / right lens" isn't
// possible; this is the same idea on the shared screen.)
//
//   ┌─────────────┬────────────────────────┐
//   │ Are you     │ Solo unos días         │
//   │ staying in  ├────────────────────────┤
//   │ the city    │ Hasta el viernes       │
//   │ long?       ├────────────────────────┤
//   │             │ Todavía no lo sé       │
//   └─────────────┴────────────────────────┘

export const LAYOUTS = Object.freeze({
  stacked: Object.freeze({
    header: { id: 1, x: 4, y: 2, width: 592, height: 84, border: 0, radius: 0 },
    replies: [0, 1, 2].map((i) => ({ id: 2 + i, x: 4, y: 92 + i * 86, width: 592, height: 80, border: 1, radius: 8 })),
    // While the wearer is saying one reply, it takes all three slots.
    focus: { id: 2, x: 4, y: 92, width: 592, height: 252, border: 1, radius: 8 },
  }),
  side: Object.freeze({
    header: { id: 1, x: 4, y: 4, width: 228, height: 342, border: 0, radius: 0 },
    replies: [0, 1, 2].map((i) => ({ id: 2 + i, x: 238, y: 4 + i * 116, width: 358, height: 110, border: 1, radius: 8 })),
    focus: { id: 2, x: 238, y: 4, width: 358, height: 342, border: 1, radius: 8 },
  }),
});
export const LAYOUT = LAYOUTS.stacked;
export const layoutOf = (name) => LAYOUTS[name] ?? LAYOUTS.stacked;

// Plain ASCII for UI chrome: the firmware font is unknown, so don't depend on
// symbols like an ellipsis or check mark existing in it.
export const PLACEHOLDER = '...';
const SEPARATOR = ' - ';

export const VERIFY_PREFIX = '(verify) ';
/** Header for the wearer's own words, translated, when there's no turn on screen. */
export const SAY_HEADER = 'Say this:';

/**
 * One reply box. A reply in another script always shows how to say it: the
 * reply, then "pronunciation - meaning" on a second line. Otherwise
 * "reply - meaning", or with learning mode the meaning on its own line. A
 * box shows two lines in Desktop Studio (no font size control), so it's
 * never more than two.
 */
export function replyText(reply, { learning = false } = {}) {
  if (!reply?.text) return PLACEHOLDER;
  // From Claude's general knowledge, not the wearer's notes.
  const text = reply.verify ? `${VERIFY_PREFIX}${reply.text}` : reply.text;
  if (learning || reply.reading) {
    const second = [reply.reading, reply.gloss].filter(Boolean).join(SEPARATOR);
    return second ? `${text}\n${second}` : text;
  }
  return reply.gloss ? `${text}${SEPARATOR}${reply.gloss}` : text;
}

export function clip(text, max = 120) {
  // Collapse whitespace but keep line breaks (learning mode uses them).
  const t = String(text ?? '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n') || PLACEHOLDER;
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

export const PICKED_PREFIX = 'You said: ';
export const MINE_PREFIX = 'You: ';

/**
 * Display writer that never floods Bluetooth: each element keeps only its
 * newest pending text, and one call is in flight at a time. A layout change
 * (rebuild) supersedes all pending element updates.
 */
export function createHud(gm, { onError, learning = () => false, showOriginal = () => false, layout = () => 'stacked' } = {}) {
  // Boxes for the current layout setting, read at each update.
  const LAYOUT = new Proxy({}, { get: (_, key) => layoutOf(layout())[key] });
  let pendingRebuild = null;
  const pendingText = new Map(); // id -> params
  let running = false;
  let pageReady = false;

  async function pump() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        if (!pageReady) { await gm.display.createPage(); pageReady = true; }
        if (pendingRebuild) {
          const ops = pendingRebuild;
          pendingRebuild = null;
          await gm.display.rebuildPage(ops);
          continue;
        }
        const next = pendingText.entries().next();
        if (next.done) break;
        const [id, params] = next.value;
        pendingText.delete(id);
        await gm.display.updateText(params);
      }
    } catch (error) {
      pageReady = false;
      onError?.(error);
    } finally {
      running = false;
    }
  }

  const REPLY_MAX = 160; // three short lines in learning mode
  const textOp = (box, text, max) => ({ type: 'text', ...box, text: clip(text, max) });
  const show = (r) => replyText(r, { learning: learning() });

  // Current turn, kept so the header and the focused reply can be redrawn.
  let original = '';
  let translated = '';
  let replies = [];
  let focusedIndex = null;
  const header = () => (showOriginal() && original && original !== translated
    ? `${original}\n${translated}`
    : translated);

  function rebuild(header, replies) {
    pendingText.clear();
    pendingRebuild = [textOp(LAYOUT.header, header)];
    if (replies) replies.forEach((r, i) => pendingRebuild.push(textOp(LAYOUT.replies[i], show(r), REPLY_MAX)));
    pump();
  }

  function update(box, text, max) {
    if (pendingRebuild) {
      // Fold into the queued rebuild so the update isn't lost or reordered.
      const op = pendingRebuild.find((o) => o.id === box.id);
      if (op) { op.text = clip(text, max); return; }
    }
    pendingText.set(box.id, { ...box, text: clip(text, max) });
    pump();
  }

  /**
   * The wearer is saying reply `index` and has got `chars` characters in:
   * it takes the whole reply area and what's already said drops off.
   */
  function focus(index, chars) {
    const r = replies[index];
    if (!r?.text) return;
    const rest = r.text.slice(chars).trim();
    const text = [rest ? (chars > 0 ? `...${rest}` : rest) : r.text, r.reading, r.gloss].filter(Boolean).join('\n');
    if (focusedIndex !== index) {
      focusedIndex = index;
      pendingText.clear();
      // Side by side keeps their words (and the original) in the left column.
      const top = (layout() === 'side' ? header() : translated || header()) || SAY_HEADER;
      pendingRebuild = [textOp(LAYOUT.header, top), textOp(LAYOUT.focus, text, 240)];
      pump();
    } else {
      update(LAYOUT.focus, text, 240);
    }
  }

  const reset = () => { focusedIndex = null; original = ''; translated = ''; };

  return {
    status(text) { reset(); rebuild(text); },
    /**
     * Their turn started: header + three reply slots (pre-filled from the
     * bank). original is what they said, shown above the translation for
     * languages in another script or in learning mode.
     */
    theirTurn(headerText, instant = [], originalText = '') {
      original = originalText;
      translated = headerText;
      replies = [0, 1, 2].map((i) => instant[i]);
      focusedIndex = null;
      rebuild(header(), replies);
    },
    translation(text) { translated = text; update(LAYOUT.header, header()); },
    reply(index, reply) {
      replies[index] = reply;
      if (focusedIndex == null && LAYOUT.replies[index]) update(LAYOUT.replies[index], show(reply), REPLY_MAX);
    },
    /** Their words while they're still talking. */
    liveTheirs(text) {
      // A reply the wearer was saying makes way once the other person talks.
      if (focusedIndex != null) { focusedIndex = null; replies = []; rebuild(text); return; }
      update(LAYOUT.header, text);
    },
    focus,
    /**
     * The wearer's own words, translated: shown like a reply they're about
     * to say, so saying it is followed and picked like any other.
     */
    say(reply) {
      replies = [reply];
      focusedIndex = null;
      focus(0, 0);
    },
    picked(text) { reset(); rebuild(`${PICKED_PREFIX}${text}`); },
    mine(text) { reset(); rebuild(`${MINE_PREFIX}${text}`); },
    async close() {
      pendingRebuild = null;
      pendingText.clear();
      if (pageReady) { pageReady = false; try { await gm.display.closePage(); } catch { /* disconnected */ } }
    },
  };
}
