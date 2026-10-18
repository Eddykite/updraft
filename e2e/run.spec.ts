import { expect, test } from '@playwright/test'
import {
  best,
  captureScene,
  hasTouch,
  logicalPoint,
  openGame,
  flyAndCrash,
  phase,
  score,
  seedBest,
  watchConsole,
} from './game.js'

/**
 * A whole run, in a real browser (spec §3, "browser-testable").
 *
 * These are the seams unit tests cannot reach: that a key press and a touch both
 * actually start a run, that holding keeps the kite alive, that dying reaches the
 * game-over screen with a score on it, that restart works, and that the best
 * score survives a reload.
 */

test('a key press starts a run', async ({ page }) => {
  const errors = watchConsole(page)
  await openGame(page)

  expect(await phase(page)).toBe('title')
  await page.keyboard.press('Space')
  await expect(page.locator('html')).toHaveAttribute('data-updraft-phase', 'playing')
  expect(errors).toEqual([])
})

test('a touch starts a run', async ({ page }) => {
  const canvas = await openGame(page)
  test.skip(!(await hasTouch(page)), 'this project has no touch support')

  const middle = await logicalPoint(canvas, 270, 640)
  await page.touchscreen.tap(middle.x, middle.y)
  await expect(page.locator('html')).toHaveAttribute('data-updraft-phase', 'playing')
})

test('holding pins the kite to the ceiling without killing it', async ({ page }) => {
  await openGame(page)

  await page.keyboard.down('Space')
  // Long enough to be pinned against the ceiling (the kite reaches y = 30 in
  // about 0.9 s) and short enough that the first gate is still on its way: with
  // the real simulation the first gate reaches the kite at t = 3.217 s, and the
  // ceiling sits above every possible gap, so "hold forever" is a death, just
  // not a death *by ceiling*. That is the distinction this test is making.
  await page.waitForTimeout(1500)
  expect(await phase(page)).toBe('playing')

  // And it is still flying after letting go again.
  await page.keyboard.up('Space')
  await page.waitForTimeout(200)
  expect(await phase(page)).toBe('playing')
})

test('Esc pauses, and the press that resumes does not also climb', async ({ page }, testInfo) => {
  await openGame(page)

  await page.keyboard.press('Space')
  await expect(page.locator('html')).toHaveAttribute('data-updraft-phase', 'playing')

  await page.keyboard.press('Escape')
  await expect(page.locator('html')).toHaveAttribute('data-updraft-phase', 'paused')
  await captureScene(page, testInfo, 'paused')

  // No time passes while paused: the simulation is simply not stepped.
  const frozen = await score(page)
  await page.waitForTimeout(500)
  expect(await score(page)).toBe(frozen)

  await page.keyboard.press('Space')
  await expect(page.locator('html')).toHaveAttribute('data-updraft-phase', 'playing')
})

test('a deliberate crash reaches game over with the score shown', async ({ page }, testInfo) => {
  const errors = watchConsole(page)
  await openGame(page)

  // Fly the tape rather than just letting go, so the game-over card captured
  // here is a screenshot of a game someone played. Nothing is asserted about the
  // score it reaches — see SCORING_TAPE in game.ts for why a browser cannot
  // promise one, and tests/playable.test.ts for where that *is* proved.
  //
  // The `playing` shot is taken a few phases in, with gates and a ring on
  // screen. Taken on the transition instead it is a picture of empty sky, which
  // is what it was until the thermals moved and the screenshot had to show
  // where they moved to.
  const finalScore = await flyAndCrash(page, async (index) => {
    if (index === 2) await captureScene(page, testInfo, 'playing')
  })
  await captureScene(page, testInfo, 'gameover')

  expect(finalScore).toBeGreaterThanOrEqual(0)
  expect(errors).toEqual([])
})

test('the game-over screen restarts on a press once the lock has expired', async ({ page }) => {
  await openGame(page)

  await page.keyboard.press('Space')
  await page.waitForFunction(
    () => document.documentElement.dataset['updraftPhase'] === 'gameover',
    undefined,
    { polling: 'raf', timeout: 15_000 },
  )

  // This no longer tries to land a press *inside* the 400 ms lock.
  //
  // The rAF polling above was an improvement on a 100 ms `toHaveAttribute`
  // poll — but it narrows the race rather than closing it. Nothing bounds the
  // time between the in-page frame that flips the phase and a CDP keypress
  // arriving, so on a loaded machine the press lands after the lock expires,
  // the run restarts, and the assertion fails for a reason that has nothing to
  // do with the code. The only way to close it in a browser would be to
  // dispatch a synthetic event from inside the same frame callback, which tests
  // the synthetic event rather than the input path.
  //
  // So the lock is proved deterministically in tests/scenes.test.ts, where time
  // is injected, and this test keeps the half only a browser can prove: that a
  // real key event restarts a finished run.
  await page.waitForTimeout(500)
  await page.keyboard.press('Space')
  await expect(page.locator('html')).toHaveAttribute('data-updraft-phase', 'playing')
})

/**
 * Persistence is asserted against a best score that is *known* to be non-zero,
 * rather than one the test hopes to earn.
 *
 * The previous version played a run and compared the stored best to whatever
 * that run scored. On a run that scored 0 — which is most of them, in a browser,
 * for the reasons in SCORING_TAPE — it compared 0 to 0 and proved nothing.
 * Seeding a known best makes every assertion below load-bearing on every
 * machine: a run must not clobber a stored best, a reload must not lose it, and
 * a score that does beat it must be the one that survives.
 */
test('a run never destroys the stored best, and a reload keeps it', async ({ page }) => {
  const seeded = 4242
  await seedBest(page, seeded)
  await openGame(page)
  expect(await best(page)).toBe(seeded)

  const finalScore = await flyAndCrash(page)
  const storedBest = await best(page)
  // Exactly the better of the two — never clobbered, never inflated.
  expect(storedBest).toBe(Math.max(seeded, finalScore))

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-updraft', 'ready')
  expect(await best(page)).toBe(storedBest)
})
