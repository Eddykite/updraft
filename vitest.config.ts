import { defineConfig } from 'vitest/config'

// Spec §3: the coverage gate is >= 85% on src/game/**. There is deliberately
// NO coverage gate on render/ — asserting draw calls is theatre.
//
// The gate is blocking as of GOK-4, and unconditionally so: it used to be behind
// COVERAGE_ENFORCE while the simulation was still stubs, but a gate that only
// exists in CI is one a developer finds out about from a red build. `pnpm
// test:coverage` fails here exactly as it fails there.
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
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
    },
  },
})
