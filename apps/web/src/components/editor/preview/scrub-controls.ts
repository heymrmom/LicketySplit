export function getKeyboardScrubTarget(
  key: string,
  currentTime: number,
  duration: number,
  shiftKey = false,
): number | null {
  const safeDuration = Math.max(0, duration);
  const step = shiftKey ? 5 : 1;
  switch (key) {
    case "ArrowLeft":
      return Math.max(0, currentTime - step);
    case "ArrowRight":
      return Math.min(safeDuration, currentTime + step);
    case "PageDown":
      return Math.max(0, currentTime - Math.max(1, safeDuration * 0.1));
    case "PageUp":
      return Math.min(safeDuration, currentTime + Math.max(1, safeDuration * 0.1));
    case "Home":
      return 0;
    case "End":
      return safeDuration;
    default:
      return null;
  }
}
