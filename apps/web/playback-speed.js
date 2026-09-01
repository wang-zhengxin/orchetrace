export const PLAYBACK_RATES = Object.freeze([0.25, 0.5, 1, 2, 4, 8]);

export function nextPlaybackRate(current, direction) {
  const currentIndex = PLAYBACK_RATES.indexOf(Number(current));
  const fallbackIndex = PLAYBACK_RATES.indexOf(1);
  const nextIndex = Math.max(
    0,
    Math.min(PLAYBACK_RATES.length - 1, (currentIndex < 0 ? fallbackIndex : currentIndex) + Math.sign(direction)),
  );
  return PLAYBACK_RATES[nextIndex];
}

export function scalePlaybackElapsed(elapsedMs, rate) {
  const elapsed = Number(elapsedMs);
  const speed = Number(rate);
  if (!Number.isFinite(elapsed) || elapsed < 0 || !PLAYBACK_RATES.includes(speed)) return 0;
  return elapsed * speed;
}
