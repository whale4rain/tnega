import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// Session integration tests must never write into the user's real Tnega home.
const testTnegaHome = mkdtempSync(join(tmpdir(), 'tnega-test-home-'))
process.env.TNEGA_HOME = testTnegaHome
afterAll(() => rmSync(testTnegaHome, { recursive: true, force: true }))

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
