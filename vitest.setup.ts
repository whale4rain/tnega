/**
 * jsdom implements no `window.matchMedia`; the web UI reads it for the
 * light/dark theme. Stub the minimum: a query that never matches, and
 * listeners that never fire.
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
