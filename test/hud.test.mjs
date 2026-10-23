import test from 'node:test';
import assert from 'node:assert/strict';
import { createHud, LAYOUT, LAYOUTS, SAY_HEADER, replyText, clip } from '../plugin/lib/hud.js';

const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const [name, layout] of Object.entries(LAYOUTS)) {
  test(`${name} layout: every box fits the 600x350 display and boxes do not overlap`, () => {
    const boxes = [layout.header, ...layout.replies];
    for (const b of [...boxes, layout.focus]) {
      assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= 600 && b.y + b.height <= 350, JSON.stringify(b));
      assert.ok(b.id >= 0 && b.id <= 255);
    }
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) assert.ok(!overlap(boxes[i], boxes[j]), `${i} and ${j} overlap`);
    }
    assert.ok(!overlap(layout.header, layout.focus), 'the focused reply leaves the header alone');
  });
}

const recordingGm = (ops) => ({ display: { createPage: async () => {}, rebuildPage: async (o) => ops.push(o), updateText: async () => {}, closePage: async () => {} } });

test('side by side: replies go right of their words, and a focused reply keeps the left column', async () => {
  const ops = [];
  const hud = createHud(recordingGm(ops), { layout: () => 'side', showOriginal: () => true });
  hud.theirTurn('Where are you going?', [{ text: 'Al centro', gloss: 'downtown' }], '¿Adónde va?');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ops[0][1].x, LAYOUTS.side.replies[0].x);
  hud.focus(0, 0);
  await new Promise((r) => setTimeout(r, 0));
  const focus = ops.at(-1);
  assert.equal(focus[0].text, '¿Adónde va?\nWhere are you going?');
  assert.equal(focus[1].width, LAYOUTS.side.focus.width);
});

test('own words, translated, show as the focused reply', async () => {
  const ops = [];
  const hud = createHud(recordingGm(ops));
  hud.status('Listening');
  hud.say({ text: 'أين المحطة؟', reading: 'AYN al-ma-HAT-ta', gloss: 'where is the station?' });
  await new Promise((r) => setTimeout(r, 0));
  const last = ops.at(-1);
  assert.equal(last[0].text, SAY_HEADER, 'no turn on screen: a plain prompt above it');
  assert.equal(last[1].text, 'أين المحطة؟\nAYN al-ma-HAT-ta\nwhere is the station?');
});

test('reply text and clipping are ASCII-safe and never empty', () => {
  assert.equal(replyText({ text: 'Hasta el viernes', gloss: 'until Friday' }), 'Hasta el viernes - until Friday');
  assert.equal(replyText(null), '...');
  assert.equal(clip(''), '...');
  assert.equal(clip('x'.repeat(200)).length, 120);
});

function fakeGm({ delayMs = 5 } = {}) {
  const calls = [];
  const op = (name) => async (arg) => { calls.push([name, arg]); await new Promise((r) => setTimeout(r, delayMs)); };
  return { calls, display: { createPage: op('createPage'), rebuildPage: op('rebuildPage'), updateText: op('updateText'), closePage: op('closePage') } };
}

test('rapid updates to one element collapse to the latest text', async () => {
  const gm = fakeGm();
  const hud = createHud(gm);
  hud.status('Listening');
  await new Promise((r) => setTimeout(r, 30));
  gm.calls.length = 0;
  for (let i = 0; i < 20; i += 1) hud.translation(`partial ${i}`);
  await new Promise((r) => setTimeout(r, 60));
  const updates = gm.calls.filter(([n]) => n === 'updateText');
  assert.ok(updates.length <= 2, `sent ${updates.length} updates`);
  assert.equal(updates.at(-1)[1].text, 'partial 19');
});

test('updates queued behind a rebuild are folded into it, in order', async () => {
  const gm = fakeGm({ delayMs: 20 });
  const hud = createHud(gm);
  hud.theirTurn('...', []);
  hud.translation('Are you staying long?');
  hud.reply(1, { text: 'Hasta el viernes', gloss: 'until Friday' });
  await new Promise((r) => setTimeout(r, 120));
  const names = gm.calls.map(([n]) => n);
  assert.deepEqual(names, ['createPage', 'rebuildPage']);
  const ops = gm.calls[1][1];
  assert.equal(ops[0].text, 'Are you staying long?');
  assert.equal(ops[2].text, 'Hasta el viernes - until Friday');
});

test('a display error is reported and the next update recreates the page', async () => {
  const gm = fakeGm();
  let fail = true;
  gm.display.rebuildPage = async () => { if (fail) { fail = false; throw Object.assign(new Error('glasses gone'), { code: 'DEVICE_DISCONNECTED' }); } };
  const errors = [];
  const hud = createHud(gm, { onError: (e) => errors.push(e.code) });
  hud.status('one');
  await new Promise((r) => setTimeout(r, 30));
  hud.status('two');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(errors, ['DEVICE_DISCONNECTED']);
  assert.equal(gm.calls.filter(([n]) => n === 'createPage').length, 2);
});

test('text display: original words above the translation, and a focused reply takes the reply area', async () => {
  const ops = [];
  const gm = { display: {
    createPage: async () => {}, rebuildPage: async (o) => ops.push(['rebuild', o]),
    updateText: async (p) => ops.push(['text', p]), closePage: async () => {},
  } };
  const hud = createHud(gm, { showOriginal: () => true, learning: () => true });
  const replies = [{ text: 'はい、初めてです', reading: 'hai, hajimete desu', gloss: 'yes, my first time' }, { text: 'いいえ', gloss: 'no' }, { text: 'まあまあ', gloss: 'so-so' }];
  hud.theirTurn('Is this your first time in Japan?', replies, '日本は初めてですか');
  await new Promise((r) => setTimeout(r, 0));
  const first = ops.find((o) => o[0] === 'rebuild')[1];
  assert.equal(first[0].text, '日本は初めてですか\nIs this your first time in Japan?');
  hud.focus(0, 3);
  await new Promise((r) => setTimeout(r, 0));
  const focus = ops.filter((o) => o[0] === 'rebuild').at(-1)[1];
  assert.equal(focus.length, 2, 'header and one big reply box');
  assert.equal(focus[1].height, LAYOUT.focus.height);
  assert.equal(focus[1].text, '...初めてです\nhai, hajimete desu\nyes, my first time');
});
