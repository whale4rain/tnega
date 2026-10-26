import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'apps/web/dist/**',
      'node_modules/**',
      '.pnpm-store/**',
      'data/**',
      '.tnega/**',
      // Scratch files at the repository root are git-ignored by the same
      // pattern; linting them reported failures that never existed in a clone.
      '.tnega-*',
      'coverage/**',
      // Build and packaging output that .gitignore already excludes; without
      // these, linting fails on any checkout that has packaged the desktop app.
      '.worktrees/**',
      'apps/desktop/out/**',
      'apps/desktop/release*/**',
      // Evaluation records keep the harness that produced them verbatim: the
      // Terminal-Bench runner is written for that container's Node, not for this
      // repository's lint rules, and it is never built or shipped.
      'docs/eval/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/desktop/scripts/build.mjs', 'scripts/package-desktop.mjs', 'scripts/release.mjs', 'scripts/tag-release.mjs'],
    languageOptions: {
      globals: {
        URL: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
      },
    },
  },
  {
    files: ['apps/desktop/scripts/verify-workbench.cjs', 'apps/desktop/scripts/verify-chrome.cjs', 'apps/desktop/scripts/verify-browser-theme.cjs'],
    languageOptions: {
      globals: {
        URL: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        require: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        AbortController: 'readonly',
        Headers: 'readonly',
        TextDecoder: 'readonly',
        URLSearchParams: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        window: 'readonly',
      },
    },
  },
)
