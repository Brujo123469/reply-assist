import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../plugin/lib/session.js';
import { translateOwn, ownWordsPrompt, scriptFor } from '../plugin/lib/claude.js';

function fakeHud() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return { calls, status: rec('status'), theirTurn: rec('theirTurn'), translation: rec('translation'), reply: rec('reply'), picked: rec('picked'), mine: rec('mine'), say: rec('say'), focus: rec('focus'), liveTheirs: rec('liveTheirs') };
}

const settings = () => ({ selfDb: null, marginDb: 8 });

test('own words are translated, shown like a reply, and saying them picks it', async () => {
  const hud = fakeHud();
  const asked = [];
  const translate = async ({ text, history }) => { asked.push({ text, history }); return { text: 'أريد غرفة لليلتين', reading: 'a-REED GHUR-fa li-lay-la-TAYN', gloss: text }; };
  const s = createSession({ hud, suggest: async () => {}, translate, getSettings: settings });
  s.onUtterance({ text: 'مرحبا، كيف يمكنني مساعدتك؟', startSec: 1, endSec: 2 });
  await s.ownWords('I need a room for two nights');
  assert.equal(asked[0].text, 'I need a room for two nights');
  const says = hud.calls.filter((c) => c[0] === 'say').map((c) => c[1]);
  assert.deepEqual(says[0], { text: '...', gloss: 'I need a room for two nights' }, 'placeholder first');
  assert.equal(says.at(-1).reading, 'a-REED GHUR-fa li-lay-la-TAYN');
  // Reading it out picks it, like any reply.
  const result = s.onUtterance({ text: 'أريد غرفة لليلتين', startSec: 5, endSec: 7 });
  assert.equal(result.kind, 'picked');
  assert.deepEqual(s.history.map((t) => t.who), ['them', 'me']);
  assert.equal(s.history[1].text, 'أريد غرفة لليلتين');
});

test('their next words cancel a pending own-words translation', async () => {
  const hud = fakeHud();
  let release;
  const translate = ({ signal }) => new Promise((resolve, reject) => {
    release = () => resolve({ text: 'late', gloss: 'x' });
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const s = createSession({ hud, suggest: async () => {}, translate, getSettings: settings });
  const pending = s.ownWords('thanks');
  s.onUtterance({ text: 'de nada', startSec: 3, endSec: 4 });
  release();
  await pending;
  assert.ok(!hud.calls.some((c) => c[0] === 'say' && c[1].text === 'late'));
});

test('cancelling "say it in English" brings back the replies to their turn', async () => {
  const hud = fakeHud();
  const suggest = async ({ onItem }) => { onItem({ type: 'translation', text: 'Do you have a reservation?' }); };
  const s = createSession({ hud, suggest, translate: async () => ({ text: 'x', gloss: 'x' }), getSettings: () => ({ ...settings(), replyMode: 'claude' }) });
  s.onUtterance({ text: '¿Tiene una reserva?', startSec: 1, endSec: 2 });
  await new Promise((r) => setTimeout(r, 0));
  s.ownDraft('Say it in English...');
  const turns = hud.calls.filter((c) => c[0] === 'theirTurn').length;
  assert.equal(s.restore(), true);
  assert.equal(hud.calls.filter((c) => c[0] === 'theirTurn').length, turns + 1);
  assert.equal(createSession({ hud: fakeHud(), suggest, getSettings: settings }).restore(), false, 'nothing to go back to');
});

test('translateOwn asks for one line and parses reply and pronunciation', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '**أين المحطة؟ | AYN al-ma-HAT-ta**' }] }), { status: 200 });
  };
  const reply = await translateOwn({
    conn: { apiKey: 'k' }, text: 'where is the station?', theirLanguage: 'Arabic', myLanguage: 'English',
    script: scriptFor('ar'), history: [{ who: 'them', text: 'أهلا' }], fetchImpl,
  });
  assert.deepEqual(reply, { text: 'أين المحطة؟', reading: 'AYN al-ma-HAT-ta', gloss: 'where is the station?' });
  assert.deepEqual(sent.thinking, { type: 'disabled' });
  assert.match(sent.messages[0].content, /Them: أهلا/);
  assert.doesNotMatch(ownWordsPrompt({ theirLanguage: 'Spanish', myLanguage: 'English' }), /pronunciation/);
});

test('Arabic-script pronunciations are spelled the way they sound, for the wearer', () => {
  const ar = scriptFor('ar-EG');
  assert.match(ar.reading, /phonetic respelling/);
  assert.match(ar.reading, /CAPITALS/);
  assert.match(ar.reading, /reads English/);
  assert.match(scriptFor('ar', 'Spanish').reading, /reads Spanish/);
  assert.match(scriptFor('fa').reading, /phonetic respelling/);
  assert.match(scriptFor('ja').reading, /romaji/, 'other scripts keep their usual romanization');
});
