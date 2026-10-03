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
      'coverage/**',
      // Build and packaging output that .gitignore already excludes; without
      // these, linting fails on any checkout that has packaged the desktop app.
      '.worktrees/**',
      'apps/desktop/out/**',
      'apps/desktop/release*/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/desktop/scripts/build.mjs', 'scripts/package-desktop.mjs', 'scripts/release.mjs'],
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
