/**
 * Utility to ensure comic and display fonts used by HTML5 canvas rendering
 * are fully loaded and decoded into browser memory before rendering.
 *
 * Canvas 2D context queries font glyphs synchronously. Browsers lazy-load
 * web fonts unless an element in the DOM requests that style or document.fonts.load()
 * is explicitly invoked.
 */

let preloadPromise: Promise<void> | null = null;

export function preloadComicFonts(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) {
    return Promise.resolve();
  }
  if (!preloadPromise) {
    const descriptors = [
      '12px "Comic Sans MS"',
      'bold 12px "Comic Sans MS"',
      'bold 14px "Comic Sans MS"',
      'bold 16px "Comic Sans MS"',
      'italic 12px "Comic Sans MS"',
      'italic bold 12px "Comic Sans MS"',
      'bold 22px "Bangers"',
    ];
    preloadPromise = Promise.all([
      ...descriptors.map((d) => document.fonts.load(d).catch(() => [])),
      document.fonts.ready,
    ]).then(() => undefined);
  }
  return preloadPromise;
}
