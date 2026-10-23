// Glasses display drawn on a canvas on the phone and sent as images.
//
// Compared with the firmware's text elements this gives us: text that
// shrinks to fit its box, any script the phone can render (kanji, Hangul),
// and 16 brightness levels for highlighting words as they're spoken. Only
// the parts of the screen that changed are sent, LZ4-compressed, because
// Bluetooth round trips are the slow part.
//
// Same interface as createHud() in hud.js, so either can be used.
//
//   their turn                          while you say a reply
//   ┌────────────────────────────┐      ┌────────────────────────────┐
//   │ 今日はどちらへ行かれますか   │ dim  │ Where are you going today?  │
//   │ Where are you going today? │      ├────────────────────────────┤
//   ├────────────────────────────┤      │ 駅まで行きます。             │ said part dims,
//   │ 駅まで行きます。             │      │ eki made ikimasu.           │ the rest stays bright
//   │ eki made ikimasu. - to the…│      │ I'm going to the station.   │
//   ├────────────────────────────┤      │                            │
//   │ ...                        │      │                            │
//   └────────────────────────────┘      └────────────────────────────┘

import { SCREEN, toGray4, changedRegions, crop, lz4Compress, toBase64 } from './gray4.js';
import { PICKED_PREFIX, MINE_PREFIX, PLACEHOLDER, SAY_HEADER } from './hud.js';
import { isRtl } from './languages.js';

const W = SCREEN.width;
const H = SCREEN.height;
const FONT = 'system-ui, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Noto Sans CJK JP", sans-serif';
// Brightness 0-15. Keep fills black: dim filled areas show as green blocks
// on the optical display, so hierarchy comes from text and outline levels.
const L = { bright: 15, text: 14, soft: 10, dim: 7, said: 5, border: 6, focusBorder: 9 };
const shade = (level) => { const v = Math.round(level * 17); return `rgb(${v},${v},${v})`; };

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const WIDE_UNITS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]+\s*|\s+/gu;

/** Line-breaking units with their position in the text: words, or single characters for CJK. */
function units(text) {
  const re = WIDE.test(text) ? WIDE_UNITS : /\S+\s*|\s+/g;
  return [...text.matchAll(re)].map((m) => ({ s: m[0], start: m.index }));
}

function wrap(ctx, text, width) {
  const lines = [];
  let cur = '';
  let start = 0;
  for (const u of units(text)) {
    if (cur && ctx.measureText((cur + u.s).trimEnd()).width > width) {
      lines.push({ text: cur.trimEnd(), start });
      const lead = u.s.length - u.s.trimStart().length;
      cur = u.s.trimStart();
      start = u.start + lead;
    } else {
      if (!cur) start = u.start;
      cur += u.s;
    }
  }
  if (cur.trim()) lines.push({ text: cur.trimEnd(), start });
  return lines;
}

/** Largest size from `sizes` at which `text` fits the box; truncated at the smallest. */
function fit(ctx, text, { width, height, sizes, weight = 400, maxLines = 99, gap = 1.2 }) {
  const font = (size) => `${weight} ${size}px ${FONT}`;
  for (const size of sizes) {
    ctx.font = font(size);
    const lines = wrap(ctx, text, width);
    const lh = Math.round(size * gap);
    if (lines.length <= maxLines && lines.length * lh <= height) return { font: font(size), size, lines, lh, h: lines.length * lh, width };
  }
  const size = sizes[sizes.length - 1];
  ctx.font = font(size);
  const lh = Math.round(size * gap);
  const keep = Math.max(1, Math.min(maxLines, Math.floor(height / lh)));
  const lines = wrap(ctx, text, width).slice(0, keep);
  const last = lines[lines.length - 1];
  if (last) {
    let t = last.text;
    while (t && ctx.measureText(`${t}...`).width > width) t = t.slice(0, -1);
    last.text = `${t}...`;
  }
  return { font: font(size), size, lines, lh, h: lines.length * lh, width };
}

/** Draw fitted text; levelAt(i) gives the brightness of character i of the source text. */
function draw(ctx, f, x, y, levelAt) {
  ctx.font = f.font;
  ctx.textBaseline = 'top';
  f.lines.forEach((line, n) => {
    const ly = y + n * f.lh + Math.round((f.lh - f.size) / 2);
    if (isRtl(line.text)) {
      // Arabic, Hebrew...: the canvas shapes and orders the line itself;
      // draw it whole, right-aligned, at the level of its first character.
      ctx.save();
      ctx.direction = 'rtl';
      ctx.textAlign = 'right';
      ctx.fillStyle = shade(levelAt(line.start));
      ctx.fillText(line.text, x + (f.width ?? 0), ly);
      ctx.restore();
      return;
    }
    let cx = x;
    let run = '';
    let runLevel = null;
    let offset = 0;
    const flush = () => {
      if (!run) return;
      ctx.fillStyle = shade(runLevel);
      ctx.fillText(run, cx, ly);
      cx += ctx.measureText(run).width;
      run = '';
    };
    for (const ch of line.text) {
      const level = levelAt(line.start + offset);
      if (level !== runLevel) { flush(); runLevel = level; }
      run += ch;
      offset += ch.length;
    }
    flush();
  });
}

const flat = (level) => () => level;

function box(ctx, x, y, w, h, level, dashed = false) {
  ctx.save();
  ctx.strokeStyle = shade(level);
  ctx.lineWidth = 1;
  if (dashed) ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 8);
  ctx.stroke();
  ctx.restore();
}

// ------------------------------------------------------------- screens

function drawMessage(ctx, text) {
  const f = fit(ctx, text || PLACEHOLDER, { width: 576, height: 330, sizes: [30, 26, 22, 18] });
  draw(ctx, f, 12, 10, flat(L.text));
}

// Where things go. Stacked: their words on top, replies below. Side by side:
// their words in a left column, replies on the right (one image goes to both
// eyes, so this is the shared-screen version of "question left, answer right").
const HEADER_SIZES = [30, 28, 26, 24, 22, 20, 18];
const GEOMETRY = {
  stacked: {
    header: { x: 10, y: 6, width: 580, height: 88, sizes: HEADER_SIZES },
    reply: (i) => ({ x: 4, y: 98 + i * 84, w: 592, h: 80 }),
    // While saying a reply: a short header, the reply takes the rest.
    focusHeader: { x: 10, y: 6, width: 580, height: 50, sizes: [24, 22, 20, 18], original: false },
    focus: { x: 4, y: 62, w: 592, h: H - 66 },
  },
  side: {
    header: { x: 8, y: 8, width: 220, height: H - 16, sizes: HEADER_SIZES },
    reply: (i) => ({ x: 238, y: 4 + i * 116, w: 358, h: 110 }),
    focusHeader: null, // the left column stays as it was
    focus: { x: 238, y: 4, w: 358, h: H - 8 },
    divider: 232,
  },
};
const geometryOf = (opts) => GEOMETRY[opts.layout] ?? GEOMETRY.stacked;

function divider(ctx, g) {
  if (g.divider == null) return;
  ctx.save();
  ctx.strokeStyle = shade(L.border);
  ctx.beginPath();
  ctx.moveTo(g.divider + 0.5, 10);
  ctx.lineTo(g.divider + 0.5, H - 10);
  ctx.stroke();
  ctx.restore();
}

/** Header: their words (live, or original above the translation). */
function drawHeader(ctx, scene, opts, { x = 10, y = 6, width = 580, height = 88, sizes = HEADER_SIZES } = {}) {
  if (scene.live) {
    // Words still arriving: newest ones brightest.
    const f = fit(ctx, scene.live, { width, height, sizes: [26, 22, 20, 18, 16] });
    const fresh = scene.liveSeen ?? 0;
    draw(ctx, f, x, y, (i) => (i >= fresh ? L.bright : L.soft));
    return;
  }
  const translation = scene.translation || PLACEHOLDER;
  if (opts.showOriginal && scene.original && scene.original !== translation) {
    const o = fit(ctx, scene.original, { width, height: Math.round(height * 0.42), sizes: [22, 20, 18, 16, 14] });
    draw(ctx, o, x, y, flat(L.dim));
    const t = fit(ctx, translation, { width, height: height - o.h - 4, sizes: sizes.filter((s) => s <= 26) });
    draw(ctx, t, x, y + o.h + 4, flat(L.bright));
    return;
  }
  draw(ctx, fit(ctx, translation, { width, height, sizes }), x, y, flat(L.bright));
}

/** Small tag in a box's top-right corner, e.g. "VERIFY". */
function tag(ctx, text, right, top) {
  ctx.save();
  ctx.font = `600 12px ${FONT}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'right';
  ctx.fillStyle = shade(L.focusBorder);
  ctx.fillText(text, right, top);
  ctx.restore();
}

function drawReply(ctx, reply, x, y, w, h, opts) {
  // Points from Claude's own knowledge (not the wearer's notes) are dashed
  // and tagged, so they're said as "I believe..., worth verifying".
  box(ctx, x, y, w, h, reply?.verify ? L.focusBorder : L.border, reply?.source === 'bank' || reply?.verify);
  if (reply?.verify) tag(ctx, 'VERIFY', x + w - 8, y + 4);
  if (!reply?.text) { draw(ctx, fit(ctx, PLACEHOLDER, { width: w - 16, height: h - 12, sizes: [22] }), x + 8, y + 6, flat(L.dim)); return; }
  // Under the reply: how to say it (always, for other scripts) and what it
  // means. Learning mode gives each its own line.
  const extra = !reply.reading ? [reply.gloss]
    : opts.learning ? [reply.reading, reply.gloss]
      : [[reply.reading, reply.gloss].filter(Boolean).join(' - ')];
  const parts = extra.filter(Boolean);
  const inner = { width: w - (reply.verify ? 70 : 16), height: h - 10 };
  const truncated = (f) => f.lines.at(-1)?.text.endsWith('...');
  for (const a of [26, 24, 22, 20, 18]) {
    for (const b of parts.length ? [18, 16, 14] : [0]) {
      const fa = fit(ctx, reply.text, { ...inner, sizes: [a], weight: 500, maxLines: 2 });
      const fbs = parts.map((p) => fit(ctx, p, { ...inner, sizes: [b], maxLines: 2 }));
      const total = fa.h + fbs.reduce((sum, f) => sum + f.h + 2, 0);
      if (fa.lines.length && !truncated(fa) && total <= inner.height && !fbs.some(truncated)) {
        draw(ctx, fa, x + 8, y + 5, flat(L.bright));
        let py = y + 5 + fa.h + 2;
        fbs.forEach((f) => { draw(ctx, f, x + 8, py, flat(L.soft)); py += f.h + 2; });
        return;
      }
    }
  }
  // Too long even at the smallest sizes: reply on top, the rest truncated.
  const fa = fit(ctx, reply.text, { ...inner, sizes: [18], weight: 500, maxLines: 2 });
  draw(ctx, fa, x + 8, y + 5, flat(L.bright));
  if (parts.length) draw(ctx, fit(ctx, parts.join(' - '), { ...inner, height: inner.height - fa.h - 2, sizes: [14], maxLines: 1 }), x + 8, y + 5 + fa.h + 2, flat(L.soft));
}

function drawTurn(ctx, scene, opts) {
  const g = geometryOf(opts);
  drawHeader(ctx, scene, opts, g.header);
  divider(ctx, g);
  (scene.replies ?? []).slice(0, 3).forEach((r, i) => {
    const b = g.reply(i);
    drawReply(ctx, r, b.x, b.y, b.w, b.h, opts);
  });
}

/**
 * The wearer is saying one reply: it gets the whole area, the part already
 * said dims, and if it no longer fits, the said part scrolls off.
 */
function drawFocus(ctx, scene, opts) {
  const g = geometryOf(opts);
  if (g.focusHeader) drawHeader(ctx, { ...scene, live: '' }, { ...opts, showOriginal: g.focusHeader.original }, g.focusHeader);
  else drawHeader(ctx, { ...scene, live: '' }, opts, g.header);
  divider(ctx, g);
  const r = scene.replies?.[scene.focus.index];
  if (!r?.text) return;
  const area = g.focus;
  box(ctx, area.x, area.y, area.w, area.h, L.focusBorder, r.verify);
  if (r.verify) tag(ctx, 'VERIFY', area.x + area.w - 10, area.y + 6);
  // All said: it stays up, readable, until the other person talks.
  const done = Boolean(scene.focus.done);
  if (done) tag(ctx, 'SAID', area.x + area.w - (r.verify ? 72 : 10), area.y + 6);
  const said = done ? 0 : Math.min(scene.focus.chars, r.text.length);
  const inner = { width: area.w - 24 };
  let text = r.text;
  let offset = 0;
  const parts = [r.reading, r.gloss].filter(Boolean);
  const rest = () => parts.reduce((h, p) => h + fit(ctx, p, { ...inner, height: 999, sizes: [22] }).h + 6, 0);
  const budget = area.h - 24 - rest();
  let main = fit(ctx, text, { ...inner, height: budget, sizes: [48, 44, 40, 36, 32, 28, 24], weight: 500 });
  if (main.lines.at(-1)?.text.endsWith('...') && said > 0) {
    // Free up room: drop what's already been said.
    offset = said;
    text = `...${r.text.slice(said).trimStart()}`;
    main = fit(ctx, text, { ...inner, height: budget, sizes: [40, 36, 32, 28, 24], weight: 500 });
  }
  let y = area.y + 12;
  draw(ctx, main, area.x + 12, y, (i) => (done ? L.soft : offset ? L.bright : i < said ? L.said : L.bright));
  y += main.h + 8;
  // Pronunciation follows along at the same proportion.
  if (r.reading) {
    const f = fit(ctx, r.reading, { ...inner, height: 60, sizes: [24, 22, 20, 18] });
    const readSaid = Math.round((said / r.text.length) * r.reading.length);
    draw(ctx, f, area.x + 12, y, (i) => (i < readSaid ? L.said : L.soft));
    y += f.h + 6;
  }
  if (r.gloss) draw(ctx, fit(ctx, r.gloss, { ...inner, height: area.y + area.h - y - 6, sizes: [22, 20, 18] }), area.x + 12, y, flat(L.dim));
}

export function render(ctx, scene, opts) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (scene.kind === 'turn') drawTurn(ctx, scene, opts);
  else if (scene.kind === 'focus') drawFocus(ctx, scene, opts);
  else drawMessage(ctx, scene.text);
}

// ------------------------------------------------------------- sending

export function createDrawnHud(gm, { onError, onFrame, learning = () => false, showOriginal = () => false, layout = () => 'stacked', canvas } = {}) {
  const cv = canvas ?? document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let scene = { kind: 'status', text: '' };
  let presented = null;
  let dirty = false;
  let running = false;
  let pageReady = false;
  let useLz4 = true;
  let frameId = 0;

  function set(patch) {
    scene = { ...scene, ...patch };
    dirty = true;
    pump();
  }

  async function send(frame, regions) {
    const parts = regions.map((r) => ({ ...r, stride: r.width / 2, tile: crop(frame, W, r.x, r.y, r.width, r.height) }));
    if (useLz4) {
      try {
        const lz = (p) => ({ x: p.x, y: p.y, width: p.width, height: p.height, stride: p.stride, decodedSize: p.tile.length, dataBase64: toBase64(lz4Compress(p.tile)) });
        if (parts.length === 1) {
          await gm.display.updateImageLz4(lz(parts[0]));
        } else {
          // Several regions appear together, not one after another.
          frameId = (frameId % 65535) + 1;
          await gm.display.beginFrame({ frameId, tileCount: parts.length });
          for (let i = 0; i < parts.length; i += 1) await gm.display.updateFrameImageLz4({ frameId, tileIndex: i, ...lz(parts[i]) });
        }
        return;
      } catch (error) {
        // Older hosts without LZ4: fall back to uncompressed images for good.
        useLz4 = false;
        onError?.(Object.assign(new Error(`LZ4 images failed (${error.code ?? error.message}); using uncompressed images`), { code: 'LZ4_FALLBACK' }));
      }
    }
    for (const p of parts) {
      await gm.display.updateImage({ x: p.x, y: p.y, width: p.width, height: p.height, stride: p.stride, dataBase64: toBase64(p.tile) });
    }
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (dirty) {
        dirty = false;
        render(ctx, scene, { learning: learning(), showOriginal: showOriginal(), layout: layout() });
        onFrame?.(cv);
        const frame = toGray4(ctx.getImageData(0, 0, W, H).data, W, H);
        if (!pageReady) { await gm.display.createPage(); pageReady = true; presented = null; }
        const regions = changedRegions(presented, frame);
        if (regions.length) await send(frame, regions);
        presented = frame;
      }
    } catch (error) {
      pageReady = false;
      presented = null;
      onError?.(error);
    } finally {
      running = false;
    }
  }

  return {
    canvas: cv,
    status(text) { set({ kind: 'status', text, live: '' }); },
    theirTurn(translation, instant = [], original = '') {
      set({ kind: 'turn', translation, original, live: '', liveSeen: 0, replies: [0, 1, 2].map((i) => instant[i]), focus: null });
    },
    translation(text) { set({ translation: text, live: '' }); },
    reply(index, reply) {
      const replies = [...(scene.replies ?? [])];
      replies[index] = reply;
      set({ replies });
    },
    liveTheirs(text) {
      const seen = Math.min(scene.live ? scene.live.length : 0, text.length);
      if (scene.kind === 'turn') set({ live: text, liveSeen: seen });
      else set({ kind: 'turn', live: text, liveSeen: seen, translation: '', original: '', replies: [], focus: null });
    },
    /** done: all of it said; it stays up until the other person talks. */
    focus(index, chars, done = false) { set({ kind: 'focus', focus: { index, chars, done } }); },
    /** The wearer's own words, translated, shown like a reply they're about to say. */
    say(reply) {
      const inTurn = (scene.kind === 'turn' || scene.kind === 'focus') && scene.translation;
      set({ kind: 'focus', replies: [reply], focus: { index: 0, chars: 0 }, live: '', ...(inTurn ? {} : { translation: SAY_HEADER, original: '' }) });
    },
    picked(text) { set({ kind: 'said', text: `${PICKED_PREFIX}${text}` }); },
    mine(text) { set({ kind: 'said', text: `${MINE_PREFIX}${text}` }); },
    /** Redraw with current settings (e.g. learning mode toggled). */
    refresh() { dirty = true; pump(); },
    async close() {
      dirty = false;
      if (pageReady) { pageReady = false; presented = null; try { await gm.display.closePage(); } catch { /* disconnected */ } }
    },
  };
}
