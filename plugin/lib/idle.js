// Auto-stop after silence, so a forgotten session doesn't keep streaming audio
// to (and paying for) speech-to-text.
//
// Call poke() on any sign of use: recognized speech or a temple-button press.
// After timeoutMs with no poke, onTimeout fires; warnMs before that, onWarn
// gives the wearer a chance to keep going. timeoutMs <= 0 disables it.

export const AUTO_STOP_CHOICES = [0, 1, 2, 3, 5, 10]; // minutes; 0 = off
export const DEFAULT_AUTO_STOP_MIN = 3;

export function createIdleTimer({
  timeoutMs,
  warnMs = 30000,
  onWarn,
  onTimeout,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let warnTimer = null;
  let stopTimer = null;
  let warned = false;

  const clear = () => {
    if (warnTimer != null) clearTimer(warnTimer);
    if (stopTimer != null) clearTimer(stopTimer);
    warnTimer = stopTimer = null;
  };

  return {
    /** Restart the countdown. Returns true if a warning was showing. */
    poke() {
      const wasWarned = warned;
      warned = false;
      clear();
      if (!(timeoutMs > 0)) return wasWarned;
      const warnAt = timeoutMs - warnMs;
      if (warnAt > 0 && onWarn) {
        warnTimer = setTimer(() => { warnTimer = null; warned = true; onWarn(); }, warnAt);
      }
      stopTimer = setTimer(() => { stopTimer = null; warned = false; onTimeout(); }, timeoutMs);
      return wasWarned;
    },
    stop() { warned = false; clear(); },
  };
}
