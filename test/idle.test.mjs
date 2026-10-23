import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdleTimer } from '../plugin/lib/idle.js';

// Manual clock: timers fire only when advance() passes their due time.
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { at, fn }
  return {
    setTimer(fn, ms) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    get pending() { return timers.size; },
  };
}

function setup(timeoutMs, warnMs = 30000) {
  const clock = fakeClock();
  const events = [];
  const idle = createIdleTimer({
    timeoutMs,
    warnMs,
    onWarn: () => events.push('warn'),
    onTimeout: () => events.push('stop'),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, events, idle };
}

test('warns 30 s before stopping, then stops after the timeout', () => {
  const { clock, events, idle } = setup(180000);
  idle.poke();
  clock.advance(149999);
  assert.deepEqual(events, []);
  clock.advance(1);
  assert.deepEqual(events, ['warn']);
  clock.advance(30000);
  assert.deepEqual(events, ['warn', 'stop']);
});

test('speech restarts the countdown', () => {
  const { clock, events, idle } = setup(180000);
  idle.poke();
  clock.advance(170000);
  assert.deepEqual(events, ['warn']);
  assert.equal(idle.poke(), true, 'poke reports that a warning was showing');
  clock.advance(170000);
  assert.deepEqual(events, ['warn', 'warn']);
  assert.equal(events.includes('stop'), false);
  assert.equal(idle.poke(), true);
  assert.equal(idle.poke(), false, 'no warning showing after the reset');
});

test('stop() cancels everything', () => {
  const { clock, events, idle } = setup(60000);
  idle.poke();
  idle.stop();
  clock.advance(600000);
  assert.deepEqual(events, []);
  assert.equal(clock.pending, 0);
});

test('a timeout of 0 means off', () => {
  const { clock, events, idle } = setup(0);
  idle.poke();
  clock.advance(3600000);
  assert.deepEqual(events, []);
  assert.equal(clock.pending, 0);
});

test('timeouts shorter than the warning skip the warning', () => {
  const { clock, events, idle } = setup(20000);
  idle.poke();
  clock.advance(20000);
  assert.deepEqual(events, ['stop']);
});
