import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

/**
 * Spec §2, "the one architectural rule": `src/game/**` is pure.
 *
 * No DOM, no canvas, no Date.now, no Math.random, no imports from io/ or render/
 * or app/. Everything non-deterministic is passed in. This is not style — it is
 * what makes the determinism and property tests in spec §3 possible at all, so it
 * fails the build rather than being a review comment.
 *
 * Belt and braces: tsconfig.game.json typechecks src/game without the DOM lib, so
 * ambient browser globals are also type errors there.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Browser layers: main.ts, app/, io/, render/
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, __COMMIT_SHA__: 'readonly' },
    },
  },

  // ---------------------------------------------------------------------------
  // The purity boundary.
  // ---------------------------------------------------------------------------
  {
    files: ['src/game/**/*.ts'],
    languageOptions: {
      // No browser globals and no node globals in the simulation.
      globals: {},
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/io/*',
                '**/io',
                '**/render/*',
                '**/render',
                '**/app/*',
                '**/app',
                '**/main',
                '**/main.ts',
              ],
              message:
                'src/game/** is pure (spec §2). It may not import from io/, render/ or app/. Pass what you need in through step(state, input, dt).',
            },
            {
              group: ['node:*', 'vite', 'vitest'],
              message: 'src/game/** must run in a bare JS runtime with no host APIs (spec §2).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'src/game/** is pure: no DOM (spec §2).' },
        { name: 'document', message: 'src/game/** is pure: no DOM (spec §2).' },
        { name: 'navigator', message: 'src/game/** is pure: no DOM (spec §2).' },
        {
          name: 'localStorage',
          message: 'src/game/** is pure: storage lives in io/storage.ts (spec §2).',
        },
        {
          name: 'sessionStorage',
          message: 'src/game/** is pure: storage lives in io/storage.ts (spec §2).',
        },
        { name: 'performance', message: 'src/game/** is pure: time is passed in as dt (spec §2).' },
        {
          name: 'requestAnimationFrame',
          message: 'src/game/** is pure: the loop lives in app/loop.ts (spec §2).',
        },
        {
          name: 'fetch',
          message: 'src/game/** is pure, and the game makes no network calls at all (spec §7).',
        },
        { name: 'process', message: 'src/game/** is pure: no host APIs (spec §2).' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'src/game/** is deterministic: use the seeded PRNG in game/rng.ts (spec §2).',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'src/game/** never reads the clock: time arrives as dt (spec §2).',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'src/game/** never reads the clock: time arrives as dt (spec §2).',
        },
      ],
    },
  },

  // Config files, scripts and tests run in Node.
  {
    files: [
      '*.config.ts',
      '*.config.js',
      'scripts/**/*.mjs',
      'tests/**/*.ts',
      'e2e/**/*.ts',
      'tools/**/*.ts',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // Plain JS that is not part of a tsconfig project: no type-aware linting.
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
)
