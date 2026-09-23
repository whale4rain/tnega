import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'apps/web/dist/**',
      'node_modules/**',
      'coverage/**',
      'data/benchmarks/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/benchmark/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        URL: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    files: ['apps/desktop/scripts/build.mjs', 'scripts/package-desktop.mjs'],
    languageOptions: {
      globals: {
        URL: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    files: ['apps/desktop/scripts/verify-workbench.cjs'],
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
