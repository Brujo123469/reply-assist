import { createGMPlugin } from './vendor/gm-plugin-web-sdk.esm.js';
import { startGlassesAudio } from './lib/audio.js';
import { connectDeepgram } from './lib/stt.js';
import { streamSuggestions, fetchReplyBank, fetchPhrasebook, fetchPrep, pickParaphrase, translateOwn, scriptFor, DEFAULT_MODEL } from './lib/claude.js';
import { starterFor, ASSIST_BANKS } from './lib/starter-phrasebooks.js';
import { createPhrasebook, refreshStarters, phrasebookKey, packKey, builtPack, DEFAULT_MODE, MODES } from './lib/phrasebook.js';
import { createHud, PICKED_PREFIX, MINE_PREFIX } from './lib/hud.js';
import { createDrawnHud } from './lib/drawn-hud.js';
import { createLevelTimeline, rmsDb } from './lib/levels.js';
import { createSession } from './lib/session.js';
import { createIdleTimer, AUTO_STOP_CHOICES, DEFAULT_AUTO_STOP_MIN } from './lib/idle.js';
import { createDiagLog, createAudioStats, redact } from './lib/diag.js';
import { SPOKEN_LANGUAGES, READ_LANGUAGES, AUTO, nameOf, detectedCode } from './lib/languages.js';

// ---------------------------------------------------------------- settings



const DEFAULT_SETTINGS = {
  theirLang: 'es',
  myLang: 'en',
  situation: '',
  replyMode: DEFAULT_MODE,
  learning: false,        // replies on separate lines: text, pronunciation, meaning
  display: 'drawn',       // 'drawn': rendered on the phone, sent as images; 'text': firmware text
  layout: 'stacked',      // 'stacked': their words on top, replies below; 'side': their words left, replies right
  sayOwn: false,          // no reply fits: say it in your own language and get it translated to read out
  mode: 'translate',      // 'translate': another language; 'assist': same-language Q&A from your notes
  notes: '',              // Q&A assist: what you're presenting, used for answers
  assistKnowledge: 'notes', // Q&A assist: 'notes' only, or 'general' (Claude's own knowledge, marked verify)
  connection: 'server',   // 'server': your Reply Assist server; 'direct': API keys on this phone
  serverUrl: '',
  appToken: '',
  claudeKey: '',
  deepgramKey: '',
  model: DEFAULT_MODEL,
  marginDb: 8,
  selfDb: null,
  autoStopMin: DEFAULT_AUTO_STOP_MIN,
  solo: false,            // testing alone: what you say counts as the other person (unless it's a reply on screen)
};
const SETTINGS_KEY = 'settings';
const bankKey = (s) => `bank:${s.theirLang}:${s.mode === 'assist' ? s.theirLang : s.myLang}`;

let settings = { ...DEFAULT_SETTINGS };

const viaServer = () => settings.connection === 'server';
/** Claude connection for lib/claude.js. */
const claudeConn = () => (viaServer() ? { server: settings.serverUrl, token: settings.appToken } : { apiKey: settings.claudeKey });
/** Speech-to-text connection for lib/stt.js. */
const sttConn = () => (viaServer() ? { server: settings.serverUrl, token: settings.appToken } : { apiKey: settings.deepgramKey });
const canUseClaude = () => (viaServer() ? Boolean(settings.serverUrl && settings.appToken) : Boolean(settings.claudeKey));
const canListen = () => (viaServer() ? Boolean(settings.serverUrl && settings.appToken) : Boolean(settings.deepgramKey));
const secrets = () => [settings.claudeKey, settings.deepgramKey, settings.appToken];
const missingSetup = () => (viaServer() ? 'Add your server address and app token in Settings first.' : 'Add your Claude and Deepgram API keys in Settings first.');

// ---------------------------------------------------------------- dom

const $ = (id) => document.getElementById(id);
const el = {
  pair: $('pair'), state: $('state'), status: $('status'),
  start: $('start'), calibrate: $('calibrate'),
  hud: document.querySelector('.hud'), hudCanvas: $('hud-canvas'),
  hudHeader: $('hud-header'), hudReplies: $('hud-replies'),
  meter: $('meter-fill'), log: $('log'),
  settings: $('settings'), form: $('settings-form'),
  theirLang: $('their-lang'), myLang: $('my-lang'), autoStop: $('auto-stop'),
  marginOut: $('margin-out'), calibOut: $('calib-out'), resetCalib: $('reset-calib'),
  diag: $('diagnostics'), diagOut: $('diag-out'), diagCopy: $('diag-copy'), diagClear: $('diag-clear'),
  pbOut: $('phrasebook-out'), pbBuild: $('pb-build'), pbClear: $('pb-clear'),
  connection: $('connection'), sayOwn: $('say-own'),
};

function fillSelect(select, options) {
  for (const [code, name] of options) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    select.append(opt);
  }
}
fillSelect(el.theirLang, SPOKEN_LANGUAGES);
fillSelect(el.myLang, READ_LANGUAGES);
fillSelect(el.autoStop, AUTO_STOP_CHOICES.map((m) => [String(m), m ? `${m} min` : 'Off']));

function setState(text, tone = 'idle') {
  el.state.textContent = text;
  el.state.dataset.tone = tone;
}

function setStatus(text, tone) {
  el.status.textContent = text ?? '';
  if (tone) el.status.dataset.tone = tone; else delete el.status.dataset.tone;
}

function renderSettings() {
  const f = el.form.elements;
  f.theirLang.value = settings.theirLang;
  f.myLang.value = settings.myLang;
  f.situation.value = settings.situation;
  f.mode.value = settings.mode;
  f.notes.value = settings.notes;
  f.assistKnowledge.value = settings.assistKnowledge;
  showModeFields(settings.mode);
  f.replyMode.value = settings.replyMode;
  f.learning.checked = settings.learning;
  f.display.value = settings.display;
  f.layout.value = settings.layout;
  f.sayOwn.checked = settings.sayOwn;
  f.connection.value = settings.connection;
  f.serverUrl.value = settings.serverUrl;
  f.appToken.value = settings.appToken;
  showConnectionFields(settings.connection);
  f.claudeKey.value = settings.claudeKey;
  f.deepgramKey.value = settings.deepgramKey;
  f.model.value = settings.model;
  f.marginDb.value = settings.marginDb;
  f.solo.checked = settings.solo;
  f.autoStopMin.value = String(settings.autoStopMin);
  el.marginOut.textContent = `${settings.marginDb} dB`;
  el.calibOut.textContent = settings.selfDb == null
    ? 'Voice not calibrated. Picking replies still works; calibrating also lets it tell when you go off-script.'
    : `Your voice: ${settings.selfDb.toFixed(1)} dB. Speech quieter than ${(settings.selfDb - settings.marginDb).toFixed(1)} dB counts as the other person.`;
  renderLanguageLabel();
  renderPhrasebook();
}

function renderLanguageLabel() {
  const spoken = settings.theirLang === AUTO ? `Auto${detectedLang ? ` (${nameOf(detectedLang)})` : ''}` : nameOf(settings.theirLang);
  el.pair.textContent = settings.mode === 'assist' ? `${spoken} · Q&A assist` : `${spoken} → ${nameOf(settings.myLang)}`;
}

function showModeFields(mode) {
  for (const field of el.form.querySelectorAll('[data-for-mode]')) field.hidden = field.dataset.forMode !== mode;
}

function showConnectionFields(connection) {
  for (const group of el.form.querySelectorAll('[data-conn]')) group.hidden = group.dataset.conn !== connection;
}

function readForm() {
  const f = el.form.elements;
  return {
    ...settings,
    theirLang: f.theirLang.value,
    myLang: f.myLang.value,
    situation: f.situation.value.trim(),
    mode: f.mode.value === 'assist' ? 'assist' : 'translate',
    notes: f.notes.value,
    assistKnowledge: f.assistKnowledge.value === 'general' ? 'general' : 'notes',
    replyMode: Object.values(MODES).includes(f.replyMode.value) ? f.replyMode.value : DEFAULT_MODE,
    learning: f.learning.checked,
    display: f.display.value === 'text' ? 'text' : 'drawn',
    layout: f.layout.value === 'side' ? 'side' : 'stacked',
    sayOwn: f.sayOwn.checked,
    connection: f.connection.value === 'direct' ? 'direct' : 'server',
    serverUrl: f.serverUrl.value.trim().replace(/\/+$/, ''),
    appToken: f.appToken.value.trim(),
    claudeKey: f.claudeKey.value.trim(),
    deepgramKey: f.deepgramKey.value.trim(),
    model: f.model.value.trim() || DEFAULT_MODEL,
    marginDb: Number(f.marginDb.value),
    solo: f.solo.checked,
    autoStopMin: Number(f.autoStopMin.value),
  };
}

// ---------------------------------------------------------------- phone mirror of the HUD

function mirror(hud) {
  let replies = [null, null, null];
  const drawReplies = () => {
    focusing = false;
    el.hudReplies.replaceChildren(...replies.filter(Boolean).map((r) => {
      const li = document.createElement('li');
      li.dataset.source = r.source ?? 'claude';
      if (r.verify) li.dataset.verify = 'true';
      const a = document.createElement('span'); a.className = 'reply'; a.textContent = r.text;
      li.append(a);
      if (r.reading) { const c = document.createElement('span'); c.className = 'reading'; c.textContent = r.reading; li.append(c); }
      if (r.gloss) { const b = document.createElement('span'); b.className = 'gloss'; b.textContent = r.gloss; li.append(b); }
      return li;
    }));
  };
  let original = '';
  let focusing = false; // a reply is being said (the others are hidden)
  const header = (t) => {
    el.hudHeader.textContent = original && original !== t ? `${original}\n${t}` : t;
  };
  return {
    status(t) { original = ''; replies = [null, null, null]; header(t); drawReplies(); hud?.status(t); },
    theirTurn(t, instant = [], orig = '') { original = orig; replies = [0, 1, 2].map((i) => instant[i] ?? null); header(t); drawReplies(); hud?.theirTurn(t, instant, orig); },
    translation(t) { header(t); hud?.translation(t); },
    reply(i, r) { replies[i] = r; drawReplies(); hud?.reply(i, r); },
    liveTheirs(t) {
      original = '';
      el.hudHeader.textContent = t;
      // A reply the wearer was saying makes way once the other person talks.
      if (focusing) { focusing = false; replies = [null, null, null]; drawReplies(); }
      hud?.liveTheirs?.(t);
    },
    say(r) { replies = [r, null, null]; drawReplies(); hud?.say?.(r); },
    focus(i, chars, done = false) {
      // Phone: dim the part of the chosen reply already said, hide the others.
      focusing = true;
      [...el.hudReplies.children].forEach((li, n) => {
        li.hidden = n !== i;
        const span = li.querySelector('.reply');
        const r = replies.filter(Boolean)[n];
        if (n === i && span && r) {
          const cut = done ? 0 : chars;
          const said = document.createElement('span'); said.className = 'said'; said.textContent = r.text.slice(0, cut);
          span.replaceChildren(said, document.createTextNode(r.text.slice(cut)));
        }
      });
      hud?.focus?.(i, chars, done);
    },
    picked(t) { original = ''; replies = [null, null, null]; header(`${PICKED_PREFIX}${t}`); drawReplies(); hud?.picked(t); },
    mine(t) { original = ''; replies = [null, null, null]; header(`${MINE_PREFIX}${t}`); drawReplies(); hud?.mine(t); },
    refresh() { hud?.refresh?.(); },
    close() { return hud?.close(); },
  };
}

// ---------------------------------------------------------------- conversation log

const LABEL = { theirs: 'Them', picked: 'You (picked)', mine: 'You' };
let lastTheirItem = null;

function addLog(entry) {
  logToDiag(entry);
  if (entry.type === 'translation' && lastTheirItem) {
    const tr = document.createElement('span');
    tr.className = 'tr';
    tr.textContent = entry.text;
    lastTheirItem.append(tr);
    return;
  }
  if (entry.type === 'latency') { setStatus(`First reply line in ${entry.ms} ms`); return; }
  if (entry.type === 'error') {
    const li = document.createElement('li');
    li.dataset.kind = 'error';
    li.textContent = entry.message;
    el.log.prepend(li);
    return;
  }
  if (entry.type !== 'utterance' || entry.kind === 'ignore') return;

  const li = document.createElement('li');
  li.dataset.kind = entry.kind;
  const who = document.createElement('span');
  who.className = 'who';
  const a = document.createElement('span');
  a.textContent = LABEL[entry.kind] ?? entry.kind;
  const b = document.createElement('span');
  // Showing the level and match score makes the sensitivity slider tunable.
  const parts = [];
  if (Number.isFinite(entry.levelDb)) parts.push(`${entry.levelDb.toFixed(0)} dB`);
  if (entry.score) parts.push(`match ${(entry.score * 100).toFixed(0)}%`);
  b.textContent = parts.join(' · ');
  who.append(a, b);
  const text = document.createElement('span');
  text.textContent = entry.text;
  li.append(who, text);
  el.log.prepend(li);
  lastTheirItem = entry.kind === 'theirs' ? li : null;
  while (el.log.children.length > 60) el.log.lastChild.remove();
}

// ---------------------------------------------------------------- diagnostics

// What each pipeline stage did, for "it isn't working" reports. Copied from
// the Diagnostics section, and saved to storage when listening stops so the
// last session's log survives a reload.
const DIAG_KEY = 'diagnostics';
const diag = createDiagLog();
const audioStats = createAudioStats();
let hostCaps = {};
const quote = (t, max = 80) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return `"${s.length > max ? `${s.slice(0, max - 3)}...` : s}"`;
};

function logToDiag(entry) {
  if (entry.type === 'utterance') {
    const parts = [entry.kind];
    if (Number.isFinite(entry.levelDb)) parts.push(`${entry.levelDb.toFixed(0)} dB`);
    if (entry.score) parts.push(`match ${(entry.score * 100).toFixed(0)}%`);
    diag.log('turn', `${parts.join(' · ')} ${quote(entry.text)}`);
  } else if (entry.type === 'latency') {
    diag.log('claude', `first reply line in ${entry.ms} ms`);
  } else if (entry.type === 'error') {
    diag.log('error', entry.message);
  } else if (entry.type === 'phrasebook') {
    usage.lookups += 1;
    if (entry.hit) usage.phrasebook += 1;
    diag.log('phrasebook', entry.hit
      ? `answered (match ${(entry.score * 100).toFixed(0)}%) ${quote(entry.q)}`
      : `no match (best ${(entry.score * 100).toFixed(0)}%)`);
  } else if (entry.type === 'claude-request') {
    usage.claude += 1;
    diag.log('claude', `asked about ${quote(entry.text)}`);
  } else if (entry.type === 'pick') {
    if (entry.hit) usage.picked += 1;
    diag.log('phrasebook', entry.hit
      ? `Claude matched a rewording to ${quote(entry.q)} (from ${entry.options} close questions)`
      : `no rewording match among ${entry.options ?? 0} close questions${entry.error ? `: ${entry.error}` : ''}`);
  } else if (entry.type === 'learned') {
    diag.log('phrasebook', `learned ${quote(entry.q)}`);
  }
}

// Per-session counts, to see how much the phrasebook is saving.
const usage = { lookups: 0, phrasebook: 0, picked: 0, claude: 0 };
const usageSummary = () => `Claude reply calls ${usage.claude} · phrasebook answers ${usage.phrasebook} of ${usage.lookups} lookups · rewordings matched ${usage.picked}`;

const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

function diagText() {
  const keyInfo = (k) => (k ? `set (${k.length} chars)` : 'MISSING');
  const header = [
    `Reply Assist diagnostics, exported ${new Date().toISOString()}`,
    `settings: ${settings.theirLang} -> ${settings.myLang} · model ${settings.model} · auto-stop ${settings.autoStopMin || 'off'} min${settings.solo ? ' · SOLO PRACTICE' : ''}`
      + ` · voice ${settings.selfDb == null ? 'not calibrated' : `${settings.selfDb.toFixed(1)} dB`} · margin ${settings.marginDb} dB`,
    viaServer()
      ? `connection: server ${hostOf(settings.serverUrl) || 'NOT SET'} · app token ${keyInfo(settings.appToken)}`
      : `connection: direct keys · Claude ${keyInfo(settings.claudeKey)} · Deepgram ${keyInfo(settings.deepgramKey)}`,
    `mode: ${settings.mode}${settings.mode === 'assist' ? ` (notes ${settings.notes.length} chars)` : ''} · replies: ${settings.replyMode} · phrasebook ${phrasebook.size} entries in ${phrasebook.packs().length} packs (${phrasebook.learnedCount} learned)`,
    `host audio: ${JSON.stringify(hostCaps?.audio ?? null)}`,
    `browser: ${navigator.userAgent}`,
    '',
  ];
  return redact([...header, ...diag.lines()].join('\n'), secrets());
}

function saveDiag() {
  gm.storage.set(DIAG_KEY, diagText()).catch(() => {});
}

// The last saved log, shown until this run logs something.
let savedDiag = '';
const currentDiag = () => (diag.size ? diagText() : savedDiag);

function renderDiag() {
  if (!el.diag.open) return;
  el.diagOut.textContent = currentDiag() || 'Nothing logged yet. Start listening, then check back here.';
  el.diagOut.scrollTop = el.diagOut.scrollHeight;
}
diag.onChange(renderDiag);

async function copyDiag() {
  const text = currentDiag();
  if (!text) { setStatus('Nothing logged yet.'); return; }
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Diagnostics copied. Paste them into your message.');
  } catch {
    // Some WebViews block the async clipboard; select the text instead.
    el.diag.open = true;
    renderDiag();
    const range = document.createRange();
    range.selectNodeContents(el.diagOut);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const ok = document.execCommand?.('copy');
    setStatus(ok ? 'Diagnostics copied. Paste them into your message.' : 'Text selected: copy it with your device\'s Copy command.');
  }
}

// ---------------------------------------------------------------- live session

const gm = createGMPlugin();
const levels = createLevelTimeline();
let live = null; // { audio, stt, session, hud }
let paused = false;
let starting = false;

function updateMeter(pcm) {
  const db = rmsDb(pcm);
  const pct = Math.max(0, Math.min(100, ((db + 60) / 50) * 100));
  el.meter.style.width = `${pct}%`;
  el.meter.dataset.self = String(settings.selfDb != null && db >= settings.selfDb - settings.marginDb);
}

// ---------------------------------------------------------------- phrasebook

// One phrasebook per language pair (per language in Q&A assist), saved in
// plugin storage as one item per topic pack plus a list of the packs, so a
// large phrasebook isn't one huge item and saving only touches what changed.
// Starter phrases ship with the plugin and aren't saved.
let phrasebook = createPhrasebook();
let saveTimer = null;
let saveAll = false;

const assist = () => settings.mode === 'assist';
/** [spoken language, reading language] the phrasebook is keyed by. */
// Auto-detect: the language Deepgram last reported, until it changes.
let detectedLang = null;
/** The language being spoken: chosen, or detected in auto mode. */
const spokenLang = () => (settings.theirLang === AUTO ? detectedLang ?? AUTO : settings.theirLang);
const spokenName = () => (spokenLang() === AUTO ? 'the other person\'s language' : nameOf(spokenLang()));
const bookLangs = () => (assist() ? [spokenLang(), spokenLang()] : [spokenLang(), settings.myLang]);
const starterPhrases = () => (assist() ? null : starterFor(spokenLang(), settings.myLang)?.phrases ?? null);

/**
 * Auto-detect reported a language. When it changes, switch to that
 * language's phrasebook and instant replies (Claude is told the language
 * on every request).
 */
function noteLanguage(tag) {
  if (settings.theirLang !== AUTO) return;
  const code = detectedCode(tag);
  if (!code || code === detectedLang) return;
  detectedLang = code;
  diag.log('stt', `detected ${nameOf(code)}`);
  renderLanguageLabel();
  loadPhrasebook();
  const current = live ?? dry;
  loadBank().then((bank) => current?.session.setBank(bank)).catch(() => {});
}

// The session keeps this object; it always forwards to the current
// phrasebook, which changes when the language does.
const bookProxy = {
  lookup: (...a) => phrasebook.lookup(...a),
  candidates: (...a) => phrasebook.candidates(...a),
  add: (...a) => phrasebook.add(...a),
  use: (...a) => phrasebook.use(...a),
  addWording: (...a) => phrasebook.addWording(...a),
  get size() { return phrasebook.size; },
};

async function loadPhrasebook() {
  const [a, b] = bookLangs();
  let stored;
  try { stored = (await gm.storage.get(phrasebookKey(a, b)))?.value; } catch { /* treat as never saved */ }
  let saved = [];
  if (Array.isArray(stored)) {
    saved = stored; // saved before packs existed: migrate on the next save
    saveAll = true;
  } else if (Array.isArray(stored?.packs)) {
    for (const pack of stored.packs) {
      try {
        const entries = (await gm.storage.get(packKey(a, b, pack)))?.value;
        if (Array.isArray(entries)) saved.push(...entries);
      } catch (e) { diag.log('phrasebook', `couldn't load pack ${pack}: ${e.message}`); }
    }
  }
  const starter = starterPhrases();
  phrasebook = starter ? refreshStarters(saved, starter) : createPhrasebook(saved);
  diag.log('phrasebook', `loaded ${phrasebook.size} phrases in ${phrasebook.packs().length} packs`);
  if (saveAll) savePhrasebook();
  renderPhrasebook();
}

/** Back to the built-in phrases (or empty, for pairs without them). */
function resetPhrasebook() {
  if (assist()) {
    phrasebook.removeSource('prep');
    phrasebook.removeSource('learned');
  } else {
    phrasebook.clear();
    phrasebook.add(starterPhrases() ?? [], 'starter');
  }
  savePhrasebook();
  const left = phrasebook.size;
  diag.log('phrasebook', left ? `reset to ${left} starter phrases` : 'cleared');
  setStatus(left ? `Phrasebook reset to ${left} starter phrases.` : 'Cleared.');
}

/** Save soon (learning can add several entries in a row), only changed packs. */
function savePhrasebook() {
  renderPhrasebook();
  clearTimeout(saveTimer);
  const [a, b] = bookLangs();
  const book = phrasebook;
  saveTimer = setTimeout(async () => {
    const all = saveAll;
    saveAll = false;
    const packs = [...new Set([...book.takeDirty(), ...(all ? book.packs() : [])])].filter((p) => p !== 'starter');
    try {
      for (const pack of packs) {
        const entries = book.toJSON(pack);
        if (entries.length) await gm.storage.set(packKey(a, b, pack), entries);
        else await gm.storage.remove(packKey(a, b, pack)).catch(() => {});
      }
      await gm.storage.set(phrasebookKey(a, b), { v: 2, packs: book.packs().filter((p) => p !== 'starter') });
    } catch (e) {
      diag.log('phrasebook', `save failed: ${e.message}`);
    }
  }, 1000);
}

function renderPhrasebook() {
  const n = (source) => phrasebook.count(source);
  if (assist()) {
    el.pbOut.textContent = phrasebook.size
      ? `Prepared: ${n('prep')} likely questions from your notes, ${n('learned')} learned in Q&A.`
      : 'No questions prepared yet. Add your notes, then prepare likely questions.';
    el.pbBuild.textContent = 'Prepare questions from notes';
    el.pbClear.textContent = 'Clear prepared questions';
    return;
  }
  const pair = `${nameOf(settings.theirLang)} → ${nameOf(settings.myLang)}`;
  const parts = [['starter', 'built-in'], ['built', 'built'], ['learned', 'learned']].filter(([s]) => n(s)).map(([s, label]) => `${n(s)} ${label}`);
  el.pbOut.textContent = phrasebook.size
    ? `Phrasebook (${pair}): ${phrasebook.size} phrases (${parts.join(', ')}).`
    : `Phrasebook (${pair}) is empty. Build one for your situation, or let it learn as you talk.`;
  el.pbBuild.textContent = 'Build phrasebook';
  el.pbClear.textContent = starterPhrases() ? 'Reset phrasebook' : 'Clear phrasebook';
}

async function buildPhrasebook() {
  if (!canUseClaude()) { setStatus(missingSetup(), 'error'); return; }
  if (assist() && !settings.notes.trim()) { el.settings.open = true; setStatus('Add your notes first (Settings → Your notes), then save.', 'error'); return; }
  el.pbBuild.disabled = true;
  setStatus(assist()
    ? 'Preparing likely questions from your notes… (one Claude request, up to a minute)'
    : `Building a phrasebook${settings.situation ? ' for your situation' : ''}… (one Claude request, up to a minute)`);
  diag.log('phrasebook', assist() ? `preparing from ${settings.notes.length} chars of notes` : `building for ${quote(settings.situation || 'general travel')}`);
  try {
    if (assist()) {
      const entries = await fetchPrep({ conn: claudeConn(), model: settings.model, language: spokenName(), notes: settings.notes, situation: settings.situation, general: settings.assistKnowledge === 'general' });
      if (!entries.length) throw new Error('Claude didn\'t return any usable questions. Try again.');
      phrasebook.removeSource('prep');
      const added = phrasebook.add(entries, 'prep', 'prep');
      savePhrasebook();
      diag.log('phrasebook', `prepared ${added} questions`);
      setStatus(`Ready: ${added} likely questions with answer points.`);
    } else {
      const entries = await fetchPhrasebook({
        conn: claudeConn(), model: settings.model,
        theirLanguage: nameOf(settings.theirLang), myLanguage: nameOf(settings.myLang), situation: settings.situation,
        script: scriptFor(settings.theirLang, nameOf(settings.myLang)),
      });
      if (!entries.length) throw new Error('Claude didn\'t return any usable phrases. Try again.');
      const added = phrasebook.add(entries, 'built', builtPack(settings.situation));
      savePhrasebook();
      diag.log('phrasebook', `built: ${added} phrases`);
      setStatus(`Phrasebook ready: added ${added} phrases.`);
    }
  } catch (error) {
    diag.log('phrasebook', `build failed: ${error.code ?? ''} ${error.message}`);
    setStatus(`Couldn't build it: ${error.message}`, 'error');
  } finally {
    el.pbBuild.disabled = false;
  }
}

async function loadBank(signal) {
  const key = bankKey(settings);
  try {
    const cached = (await gm.storage.get(key))?.value;
    if (Array.isArray(cached) && cached.length >= 6) return cached;
  } catch { /* fall through to fetch */ }
  const starter = assist() ? ASSIST_BANKS[spokenLang()] : starterFor(spokenLang(), settings.myLang)?.bank;
  if (starter) return starter;
  if (!canUseClaude() || spokenLang() === AUTO) return [];
  const bank = await fetchReplyBank({
    conn: claudeConn(), model: settings.model,
    theirLanguage: spokenName(), myLanguage: nameOf(assist() ? spokenLang() : settings.myLang), signal,
    script: assist() ? null : theirScript(),
  });
  if (bank.length >= 6) await gm.storage.set(key, bank).catch(() => {});
  return bank;
}

// Their words in the original script go above the translation for
// languages written differently from yours, and in learning mode.
const showOriginal = () => !assist() && (Boolean(scriptFor(spokenLang())) || settings.learning);
/** Script rules for the spoken language, with pronunciations spelled for the wearer's language. */
const theirScript = () => scriptFor(spokenLang(), nameOf(settings.myLang));

function makeGlassesHud() {
  const options = {
    learning: () => settings.learning,
    layout: () => settings.layout,
    showOriginal,
    onError: (e) => {
      diag.log('display', `${e.code ?? 'error'}: ${e.message}`);
      if (e.code !== 'LZ4_FALLBACK') setStatus(`Display: ${e.code ?? ''} ${e.message}`, 'error');
    },
  };
  const drawn = settings.display !== 'text';
  el.hud.dataset.mode = drawn ? 'drawn' : 'text';
  return drawn ? createDrawnHud(gm, { ...options, canvas: el.hudCanvas }) : createHud(gm, options);
}

// Solo practice: with no voice level to compare against, everything said
// counts as the other person unless it matches a reply on screen (a pick).
const liveSettings = () => (settings.solo ? { ...settings, selfDb: null } : settings);

function makeSession({ getSettings = liveSettings } = {}) {
  const hud = mirror(makeGlassesHud());
  const session = createSession({
    hud,
    levels,
    getSettings,
    phrasebook: bookProxy,
    onLearned: savePhrasebook,
    log: addLog,
    suggest: (args) => streamSuggestions({
      ...args,
      conn: claudeConn(),
      model: settings.model,
      // Read at request time: in auto mode the language can change mid-conversation.
      settings: assist()
        ? { assist: true, language: spokenName(), notes: settings.notes, situation: settings.situation, general: settings.assistKnowledge === 'general' }
        : { theirLanguage: spokenName(), myLanguage: nameOf(settings.myLang), situation: settings.situation, script: theirScript() },
    }),
    // "Say it in English": the wearer's own words, in the other person's language.
    translate: canUseClaude() ? (args) => translateOwn({
      ...args, conn: claudeConn(), model: settings.model,
      theirLanguage: spokenName(), myLanguage: nameOf(settings.myLang), script: theirScript(),
    }) : null,
    // Rewording check, alongside the reply request (phrasebook-first mode).
    pick: canUseClaude() ? (args) => pickParaphrase({ ...args, conn: claudeConn(), model: settings.model }) : null,
  });
  return { hud, session };
}

// Typed mode: same session, HUD and Claude path, text instead of speech.
let dry = null; // { hud, session, clock, bankCtl }

async function endDry() {
  const current = dry;
  if (!current) return;
  dry = null;
  current.bankCtl.abort();
  current.session.stop();
  await current.hud.close();
}

async function typedLine(who, text) {
  if (live) {
    setStatus('Stop listening first to use typed mode.', 'error');
    return;
  }
  if ((settings.replyMode !== MODES.PHRASEBOOK || who === 'own') && !canUseClaude()) {
    el.settings.open = true;
    setStatus(missingSetup(), 'error');
    return;
  }
  if (!dry) {
    const { hud, session } = makeSession({ getSettings: () => ({ ...settings, selfDb: settings.selfDb ?? -20 }) });
    const bankCtl = new AbortController();
    dry = { hud, session, clock: 0, bankCtl };
    hud.status(`Typed mode · ${nameOf(settings.theirLang)}`);
    loadBank(bankCtl.signal).then((bank) => dry?.session.setBank(bank)).catch(() => {});
  }
  dry.clock += 3; // leave a gap so turns never look like continuations
  // Stand-in loudness: well above or below the wearer's level.
  const self = settings.selfDb ?? -20;
  const timing = { startSec: dry.clock, endSec: dry.clock + 1, levelDb: who === 'me' ? self : self - 30 };
  // Play the line in as speech-to-text would: a few words at a time, then
  // the finished sentence. Shows live words and reply focusing without a mic.
  const run = ++typedRun;
  const session = dry.session;
  if (who === 'own') {
    session.ownWords(text);
    return;
  }
  for (const partial of partialsOf(text)) {
    session.onInterim({ text: partial, ...timing });
    await new Promise((r) => setTimeout(r, 260));
    if (run !== typedRun || dry?.session !== session) return; // a newer line took over
  }
  session.onUtterance({ text, ...timing });
}

let typedRun = 0;

/** Growing prefixes of a line, the way interim transcripts arrive. */
function partialsOf(text) {
  const wide = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
  const out = [];
  if (wide) {
    for (let i = 2; i < text.length; i += 2) out.push(text.slice(0, i));
  } else {
    const words = text.split(/\s+/);
    for (let i = 1; i < words.length; i += 1) out.push(words.slice(0, i).join(' '));
  }
  return out;
}

// ---------------------------------------------------------------- say it in English

// No reply fits: the wearer double-presses the temple button (or taps the
// phone button) and says what they want in their own language. A short second
// speech-to-text stream in that language hears one sentence, and it comes
// back translated, shown like a reply to read out. Always on request, never
// guessed from what was heard: a wrong guess mid-conversation is worse.
const ownOn = (s = settings) => s.sayOwn && s.mode !== 'assist' && s.theirLang !== s.myLang && canUseClaude();

let own = null;       // { stt, from, timer } while the second stream is open
let ownWindow = null; // { from, to } audio seconds: main-stream words then were the wearer's own language

/** Main-stream words that overlap the second stream were the wearer, misheard. */
const duringOwn = (u) => (own && u.endSec > own.from) || (ownWindow && u.startSec < ownWindow.to && u.endSec > ownWindow.from);

function endOwn() {
  const cap = own;
  if (!cap) return;
  own = null;
  clearTimeout(cap.timer);
  cap.stt?.close();
  ownWindow = { from: cap.from, to: levels.clock + 0.3 };
  renderOwnButton();
}

/** Back to the conversation: their turn's replies again, or the listening screen. */
function leaveOwn(why) {
  diag.log('own', why);
  endOwn();
  if (live && !live.session.restore()) live.hud.status(`Listening · ${nameOf(settings.theirLang)}`);
}

/** Double press / phone button: start saying it in English, or cancel. */
function toggleOwn() {
  if (own) leaveOwn('cancelled');
  else startOwnCapture();
}

function startOwnCapture() {
  if (!live || own) return;
  const lang = nameOf(settings.myLang);
  const session = live.session;
  diag.log('own', `listening for ${lang}`);
  session.ownDraft(`Say it in ${lang}...`);
  const cap = { stt: null, from: levels.clock, timer: null };
  own = cap;
  cap.timer = setTimeout(() => { if (own === cap) leaveOwn('nothing heard in 15 s'); }, 15000);
  try {
    cap.stt = connectDeepgram({
      ...sttConn(),
      language: settings.myLang,
      onUtterance: (u) => {
        if (own !== cap) return;
        diag.log('own', `heard ${quote(u.text)}`);
        endOwn();
        live?.session.ownWords(u.text);
      },
      onInterim: (t) => { if (own === cap) live?.session.ownDraft(t); },
      onStatus: (st, code, reason) => {
        if (own !== cap || (st !== 'error' && st !== 'closed')) return;
        diag.log('own', `speech-to-text ${st}${code != null ? ` code ${code}` : ''}${reason ? ` ${quote(reason)}` : ''}`);
        endOwn();
      },
    });
  } catch (error) {
    diag.log('own', `couldn't open speech-to-text: ${error.message}`);
    endOwn();
  }
  renderOwnButton();
}

function renderOwnButton() {
  el.sayOwn.hidden = !(live && ownOn());
  el.sayOwn.textContent = own ? `Listening for ${nameOf(settings.myLang)}… (tap to cancel)` : `Say it in ${nameOf(settings.myLang)}`;
}
el.sayOwn.addEventListener('click', () => toggleOwn());

async function start() {
  if (live || starting) return;
  if (!canListen() || (settings.replyMode !== MODES.PHRASEBOOK && !canUseClaude())) {
    el.settings.open = true;
    setStatus(missingSetup(), 'error');
    return;
  }
  starting = true;
  el.start.disabled = true;
  setState('Starting', 'warn');
  setStatus('Opening the glasses microphone…');

  await endDry();
  const { hud, session } = makeSession();

  diag.log('start', `listening in ${settings.theirLang}${ownOn() ? ` · say it in ${settings.myLang}: double press` : ''} via ${viaServer() ? `server ${hostOf(settings.serverUrl)}` : 'direct keys'} · replies: ${settings.replyMode}`);
  audioStats.reset();
  Object.assign(usage, { lookups: 0, phrasebook: 0, picked: 0, claude: 0 });
  const sttCounts = { messages: 0, results: 0, finals: 0, other: {} };
  // Set if speech-to-text fails before the mic has finished opening, when
  // there's no live session to stop yet.
  let sttDown = null;

  let stt;
  let firstChunk = true;
  try {
    levels.reset();
    diag.log('stt', 'connecting to Deepgram');
    stt = connectDeepgram({
      ...sttConn(),
      language: settings.theirLang,
      onUtterance: (u) => {
        diag.log('stt', `utterance ${u.startSec.toFixed(1)}-${u.endSec.toFixed(1)} s (${u.reason})${u.language ? ` [${u.language}]` : ''} ${quote(u.text)}`);
        live?.idle.poke();
        if (paused || duringOwn(u)) return;
        noteLanguage(u.language);
        session.onUtterance(u);
      },
      onInterim: (t, timing) => {
        live?.idle.poke();
        setStatus(`… ${t}`);
        if (paused || own) return;
        noteLanguage(timing?.language);
        live?.session.onInterim({ text: t, ...timing });
      },
      onMessage: (msg) => {
        sttCounts.messages += 1;
        if (msg.type === 'Results') {
          sttCounts.results += 1;
          if (msg.is_final) sttCounts.finals += 1;
          if (sttCounts.results === 1) diag.log('stt', 'first transcription result received');
        } else {
          const type = msg.type ?? 'unknown';
          sttCounts.other[type] = (sttCounts.other[type] ?? 0) + 1;
          if (type !== 'UtteranceEnd') diag.log('stt', `message ${type}${msg.description ? `: ${msg.description}` : ''}${msg.err_msg ? `: ${msg.err_msg}` : ''}`);
        }
      },
      onStatus: (s, code, reason) => {
        diag.log('stt', `socket ${s}${code != null ? ` code ${code}` : ''}${reason ? ` reason ${quote(reason)}` : ''}`);
        if (s === 'error' || s === 'closed') {
          const hint = code === 4401 ? ' (check your app token in Settings)'
            : code === 1008 || code === 4001 || code === 4008 ? ' (check the Deepgram key and language)' : '';
          const message = `Speech-to-text disconnected${reason ? `: ${reason}` : ''}${hint}`;
          if (live) { setStatus(message, 'error'); stop(); } else sttDown ??= message;
        }
      },
    });
    diag.log('mic', 'opening glasses microphone');
    const audio = await startGlassesAudio(gm, {
      onPcm: (pcm, chunk) => {
        if (firstChunk) {
          firstChunk = false;
          diag.log('mic', `first audio chunk: ${chunk.frameLengths?.length ?? '?'} opus frames -> ${pcm.length} samples`);
        }
        audioStats.add({ frames: chunk.frameLengths?.length ?? 0, pcm });
        levels.push(pcm);
        updateMeter(pcm);
        if (!paused) {
          if (stt.send(pcm)) audioStats.sent(pcm.byteLength); else audioStats.unsent();
          own?.stt?.send(pcm);
        }
      },
      onDrop: (chunk) => diag.log('mic', `host dropped ${chunk.droppedFrameCount ?? 0} frames${chunk.discontinuity ? ' (discontinuity)' : ''}`),
    });
    diag.log('mic', `capture open, session ${audio.sessionId}`);
    if (sttDown) {
      await audio.stop();
      throw Object.assign(new Error(sttDown), { code: 'STT_DOWN' });
    }
    live = { audio, stt, session, hud, idle: makeIdleTimer(hud) };
    live.idle.poke();
    live.statsTimer = setInterval(() => {
      const extra = Object.entries(sttCounts.other).map(([k, v]) => `${k} ${v}`).join(', ');
      diag.log('audio', audioStats.empty
        ? 'NO audio chunks in the last 5 s'
        : `${audioStats.summary()} · Deepgram replies ${sttCounts.messages} (results ${sttCounts.results}, final ${sttCounts.finals}${extra ? `, ${extra}` : ''})`);
      audioStats.reset();
    }, 5000);
    audio.done.then(
      () => { if (live?.audio === audio) stop('Microphone stopped.'); },
      (error) => {
        diag.log('mic', `audio stream failed: ${error?.message ?? error}`);
        if (live?.audio === audio) { setStatus(`Microphone error: ${error?.message ?? error}`, 'error'); stop(); }
      },
    );
  } catch (error) {
    diag.log('error', `start failed: ${error.code ?? 'Error'}: ${error.message}`);
    stt?.close();
    await hud.close();
    starting = false;
    el.start.disabled = false;
    setState('Stopped', 'error');
    const msg = error.code === 'PERMISSION_DENIED'
      ? 'Microphone permission was denied. Allow it for Reply Assist in the MemoMind app.'
      : error.code === 'STT_DOWN' ? error.message : `${error.code ?? 'Error'}: ${error.message}`;
    setStatus(msg, 'error');
    saveDiag();
    return;
  }

  starting = false;
  paused = false;
  el.start.textContent = 'Stop';
  el.start.className = 'stop';
  el.start.disabled = false;
  setState('Listening', 'live');
  setStatus('');
  renderOwnButton();
  hud.status(`Listening · ${nameOf(settings.theirLang)}`);

  // The instant bank is a nicety; never let it block or break the session.
  const bankCtl = new AbortController();
  live.bankCtl = bankCtl;
  loadBank(bankCtl.signal).then((bank) => live?.session.setBank(bank))
    .catch((e) => { if (e?.name !== 'AbortError') diag.log('claude', `reply bank failed: ${e.message}`); });
}

async function stop(reason) {
  const current = live;
  if (!current) return;
  live = null;
  clearInterval(current.statsTimer);
  if (!audioStats.empty) diag.log('audio', audioStats.summary());
  diag.log('usage', usageSummary());
  diag.log('stop', reason ?? 'stopped');
  current.idle.stop();
  current.bankCtl?.abort();
  current.session.stop();
  endOwn();
  current.stt.close();
  await current.audio.stop();
  await current.hud.close();
  el.meter.style.width = '0';
  el.start.textContent = 'Start listening';
  el.start.className = 'primary';
  el.start.disabled = false;
  renderOwnButton();
  setState('Stopped');
  if (reason) setStatus(reason);
  saveDiag();
}

// Stops streaming (and paying for) speech-to-text once nobody has spoken for
// a while. Plain ASCII on the glasses, like the rest of the HUD chrome.
function makeIdleTimer(hud) {
  const minutes = settings.autoStopMin;
  return createIdleTimer({
    timeoutMs: minutes * 60000,
    onWarn: () => {
      setStatus('No speech for a while. Stopping in 30 s unless someone talks or you press the temple button.');
      hud.status('Quiet. Stopping in 30 s - press to keep listening');
    },
    onTimeout: () => stop(`Stopped after ${minutes} min with no speech.`),
  });
}

function togglePause() {
  if (!live) return;
  paused = !paused;
  setState(paused ? 'Paused' : 'Listening', paused ? 'warn' : 'live');
  live.hud.status(paused ? `Paused · ${ownOn() ? 'hold' : 'double-press'} to resume` : `Listening · ${nameOf(settings.theirLang)}`);
}

// ---------------------------------------------------------------- calibration

async function calibrate() {
  if (starting) return;
  if (live) await stop();
  el.calibrate.disabled = true;
  el.start.disabled = true;
  const dbs = [];
  let audio;
  try {
    setState('Calibrating', 'warn');
    setStatus('Speak normally for 4 seconds, e.g. count to ten.');
    audio = await startGlassesAudio(gm, {
      onPcm: (pcm) => {
        const db = rmsDb(pcm);
        updateMeter(pcm);
        if (Number.isFinite(db)) dbs.push(db);
      },
    });
    await new Promise((r) => setTimeout(r, 4000));
    await audio.stop();
    // Loudest 30% of blocks = speech, not the gaps between words.
    const top = dbs.sort((a, b) => b - a).slice(0, Math.max(1, Math.ceil(dbs.length * 0.3)));
    const selfDb = top.reduce((a, b) => a + b, 0) / top.length;
    if (!Number.isFinite(selfDb) || selfDb < -55) throw new Error('Didn\'t hear you. Try again a bit closer to normal speaking volume.');
    settings = { ...settings, selfDb };
    await gm.storage.set(SETTINGS_KEY, settings);
    renderSettings();
    diag.log('calibrate', `voice ${selfDb.toFixed(1)} dB from ${dbs.length} audio blocks`);
    setStatus(`Calibrated: your voice is about ${selfDb.toFixed(1)} dB.`);
  } catch (error) {
    diag.log('calibrate', `failed after ${dbs.length} audio blocks: ${error.message}`);
    await audio?.stop();
    setStatus(error.message, 'error');
  } finally {
    el.meter.style.width = '0';
    setState('Stopped');
    el.calibrate.disabled = false;
    el.start.disabled = false;
  }
}

// ---------------------------------------------------------------- wiring

el.start.addEventListener('click', () => (live ? stop() : start()));

const tryForm = document.getElementById('try-form');
tryForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = tryForm.elements.line;
  const text = input.value.trim();
  if (!text) { setStatus('Type something first.', 'error'); return; }
  typedLine(['me', 'own'].includes(e.submitter?.value) ? e.submitter.value : 'them', text);
  input.value = '';
});
el.calibrate.addEventListener('click', calibrate);

el.diag.addEventListener('toggle', renderDiag);
el.diagCopy.addEventListener('click', copyDiag);
el.pbBuild.addEventListener('click', buildPhrasebook);
el.pbClear.addEventListener('click', resetPhrasebook);
el.connection.addEventListener('change', () => showConnectionFields(el.connection.value));
el.form.elements.mode.addEventListener('change', (e) => showModeFields(e.target.value));

el.diagClear.addEventListener('click', () => {
  savedDiag = '';
  diag.clear();
  gm.storage.remove(DIAG_KEY).catch(() => {});
});

el.form.addEventListener('input', (e) => {
  if (e.target.name === 'marginDb') el.marginOut.textContent = `${e.target.value} dB`;
});

el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = readForm();
  const languageChanged = next.theirLang !== settings.theirLang || next.myLang !== settings.myLang || next.mode !== settings.mode;
  // The text display's boxes are set when a screen is built; the drawn one redraws.
  const displayChanged = next.display !== settings.display || (next.display === 'text' && next.layout !== settings.layout);
  if (languageChanged) detectedLang = null;
  settings = next;
  try {
    await gm.storage.set(SETTINGS_KEY, settings);
    setStatus('Settings saved.');
  } catch (error) {
    setStatus(`Couldn't save settings: ${error.message}`, 'error');
  }
  renderSettings();
  if (languageChanged || displayChanged) await endDry();
  if (languageChanged) await loadPhrasebook();
  renderOwnButton();
  if (live && (languageChanged || displayChanged)) { await stop(); start(); return; }
  if (live) { live.idle.stop(); live.idle = makeIdleTimer(live.hud); live.idle.poke(); }
  // Learning mode and the original-script line apply right away.
  (live ?? dry)?.hud.refresh();
});

el.resetCalib.addEventListener('click', async () => {
  settings = { ...settings, selfDb: null };
  await gm.storage.set(SETTINGS_KEY, settings).catch(() => {});
  renderSettings();
});

async function init() {
  try {
    await gm.ready();
  } catch (error) {
    setState('No host', 'error');
    setStatus(`Couldn't connect to the MemoMind app: ${error.message}`, 'error');
    return;
  }

  try {
    const stored = (await gm.storage.get(SETTINGS_KEY))?.value;
    if (stored && typeof stored === 'object') {
      settings = { ...DEFAULT_SETTINGS, ...stored };
      // Saved before the server option existed: keep using the keys.
      if (!stored.connection) settings.connection = stored.claudeKey ? 'direct' : 'server';
    }
  } catch { /* first run */ }
  try {
    const stored = (await gm.storage.get(DIAG_KEY))?.value;
    if (typeof stored === 'string') savedDiag = redact(stored, secrets());
  } catch { /* none saved */ }
  renderSettings();
  await loadPhrasebook();
  if (!canListen()) el.settings.open = true;

  const caps = await gm.runtime.getCapabilities().catch((e) => { diag.log('init', `getCapabilities failed: ${e.message}`); return {}; });
  hostCaps = caps ?? {};
  diag.log('init', `plugin ready · host audio ${caps?.audio ? 'available' : 'NOT available'}`);
  if (!caps?.audio) {
    setState('No mic', 'error');
    setStatus('This host has no glasses microphone. Connect your MemoMind One and reopen the plugin.', 'error');
  } else {
    setState('Ready');
  }

  // Temple button: tap = new replies. With "Say it in English" on:
  // double = say it in English (again to cancel), hold = pause. Otherwise
  // double = pause, hold = clear.
  try {
    await gm.device.subscribeEvents(['button', 'connection']);
    gm.device.onButton((event) => {
      diag.log('button', `${event.action}${live ? '' : ' (not listening, ignored)'}`);
      if (!live) return;
      // Any press counts as "still here"; a press that dismisses the
      // auto-stop warning does only that.
      if (live.idle.poke()) {
        setStatus('');
        live.hud.status(paused ? `Paused · ${ownOn() ? 'hold' : 'double-press'} to resume` : `Listening · ${nameOf(settings.theirLang)}`);
        return;
      }
      if (event.action === 'single') live.session.refresh();
      else if (event.action === 'double' && ownOn()) toggleOwn();
      else if (event.action === 'double' || (event.action === 'long' && ownOn())) togglePause();
      else if (event.action === 'long') { live.session.clear(); live.hud.status(`Listening · ${nameOf(settings.theirLang)}`); }
    });
    gm.device.onConnection((event) => {
      diag.log('device', `glasses ${event.connected ? 'connected' : 'disconnected'}`);
      if (!event.connected) stop('Glasses disconnected.');
    });
  } catch (e) { diag.log('init', `button events unavailable: ${e.message}`); }

  gm.on('runtime.lifecycleChanged', (data) => {
    diag.log('lifecycle', data?.state ?? 'unknown');
    // The host stops audio when the plugin is hidden; mirror that cleanly.
    if (data?.state && data.state !== 'running') stop('Paused because the app went to the background.');
  });

  el.start.disabled = !caps?.audio;
  el.calibrate.disabled = !caps?.audio;
}

init();
