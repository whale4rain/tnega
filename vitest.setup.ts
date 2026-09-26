/**
 * Astryx components read breakpoint media queries through its useMediaQuery
 * hook, and jsdom implements no `window.matchMedia` at all — every component
 * that adapts to viewport size throws on render without this. Stub the minimum
 * those hooks touch: a query that never matches, and listeners that never fire.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }),
  })
}
