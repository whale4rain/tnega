/**
 * The two layers `pnpm test` distinguishes.
 *
 * The code layer runs on any machine with the repository checked out: no
 * credentials, no built artifact, no GUI and no elevated OS privilege. It is
 * what `pnpm test` runs and what a change has to keep green.
 *
 * The host layer needs something the machine has to provide — a real build, a
 * provider key, Chromium/Electron, or the Windows ACL machinery. Its failures
 * therefore say as much about the host as about the code, so it is opt-in:
 * `pnpm test -- --全量` (or `pnpm test:all`) runs both layers.
 *
 * Convention for new tests: a host-layer file is named `*.e2e.test.ts` or
 * `*.smoke.test.ts` and needs no entry below. `test/publish.test.ts` keeps its
 * historical name because the release CI pins that exact path.
 */
export const hostTests = [
  // Runs `scripts/build.mjs` before asserting, so it needs a quiet machine and minutes.
  'test/publish.test.ts',
  // Needs a real provider key and makes paid network calls.
  '**/*.smoke.test.ts',
  // Conventions that already exist in the tree: `foo.e2e.test.ts` and `e2e-foo.test.ts`.
  '**/*.e2e.test.ts',
  '**/e2e-*.test.ts',
]

/** The default Vitest configuration ignores these; the 全量 one keeps them. */
export const ignoredByDefault = ['**/node_modules/**', '**/dist/**', ...hostTests]
