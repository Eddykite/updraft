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
      // src/app/** and src/io/** were outside the gate until GOK-5, which is
      // where most of the shell's source lives — so the gate was measuring a
      // third of the codebase. They are in now, under their own threshold so a
      // shell regression cannot be masked by the simulation's headroom.
      //
      // Still deliberately excluded, for the same reason as render/: asserting
      // that an oscillator was constructed is theatre, not evidence. io/audio.ts
      // and main.ts are proved by the browser suite, which checks that the mute
      // state is what the player set and that nothing throws.
      include: ['src/game/**/*.ts', 'src/app/**/*.ts', 'src/io/**/*.ts'],
      exclude: ['src/io/audio.ts'],
      thresholds: {
        'src/game/**/*.ts': { lines: 85, functions: 85, branches: 85, statements: 85 },
        'src/{app,io}/**/*.ts': { lines: 85, functions: 85, branches: 85, statements: 85 },
      },
    },
  },
})
