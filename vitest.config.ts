import { defineConfig } from 'vitest/config'

// Spec §3: the coverage gate is >= 85% on src/game/**. There is deliberately
// NO coverage gate on render/ — asserting draw calls is theatre.
//
// The gate is off by default while src/game/** is still stubs, and is turned on
// by setting COVERAGE_ENFORCE=1. CI sets it in .github/workflows/ci.yml — flipping
// that one env value is the whole "make coverage blocking" change once the
// simulation task lands. Test *failures* are blocking right now either way.
const enforceCoverage = process.env.COVERAGE_ENFORCE === '1'

export default defineConfig({
  // vitest.config.ts replaces vite.config.ts for test runs, so the build-time
  // define has to be restated here for any test that reaches app/render code.
  define: {
    __COMMIT_SHA__: JSON.stringify('test'),
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/game/**/*.ts'],
      ...(enforceCoverage
        ? { thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 } }
        : {}),
    },
  },
})
