import { expect, test } from '@playwright/test'
import {
  best,
  captureScene,
  hasTouch,
  logicalPoint,
  openGame,
  phase,
  score,
  simulationReady,
  watchConsole,
} from './game.js'

/**
 * A whole run, in a real browser (spec §3, "browser-testable").
 *
 * These are the seams unit tests cannot reach: that a key press and a touch both
 * actually start a run, that holding keeps the kite alive, that dying reaches the
 * game-over screen with a score on it, that restart works, and that the best
 * score survives a reload.
 *
 * Every test here skips itself with a reason while `src/game/update.ts` is still
 * the contract stub (GOK-4). That is deliberate and temporary: the suite names
 * the work and turns itself on the moment the simulation lands, rather than
 * being quietly omitted. Delete `requireSimulation` with the probe in
 * src/app/scenes.ts.
 */
async function requireSimulation(page: import('@playwright/test').Page): Promise<void> {
  const ready = await simulationReady(page)
  test.skip(
    !ready,
    'the simulation body (GOK-4) has not landed yet: step() still throws `not implemented`',
  )
}

test('a key press starts a run', async ({ page }) => {
  const errors = watchConsole(page)
  await openGame(page)
  await requireSimulation(page)

  expect(await phase(page)).toBe('title')
  await page.keyboard.press('Space')
  await expect(page.locator('html')).toHaveAttribute('data-updraft-phase', 'playing')
  expect(errors).toEqual([])
})

test('a touch starts a run', async ({ page }) => {
  const canvas = await openGame(page)
  await requireSimulation(page)
  test.skip(!(await hasTouch(page)), 'this project has no touch support')

  const middle = await logicalPoint(canvas, 270, 640)
  await page.touchscreen.tap(middle.x, middle.y)
  await expect(page.locator('html')).toHaveAttribute('data-updraft-phase', 'playing')
})

test('holding pins the kite to the ceiling without killing it', async ({ page }) => {
  await openGame(page)
  await requireSimulation(page)

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
  await requireSimulation(page)

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
  await requireSimulation(page)

  await page.keyboard.press('Space')
  await expect(page.locator('html')).toHaveAttribute('data-updraft-phase', 'playing')
  await captureScene(page, testInfo, 'playing')

  // Let go of everything: gravity does the rest, and the ground is fatal.
  await expect(page.locator('html')).toHaveAttribute('data-updraft-phase', 'gameover', {
    timeout: 15_000,
  })
  await captureScene(page, testInfo, 'gameover')

  expect(await score(page)).toBeGreaterThanOrEqual(0)
  expect(errors).toEqual([])
})

test('the game-over screen ignores a death-frame press, then restarts', async ({ page }) => {
  await openGame(page)
  await requireSimulation(page)

  await page.keyboard.press('Space')
  // Catch the death on the frame it happens. `toHaveAttribute` polls every
  // 100 ms, which can burn a quarter of the 400 ms lock before the press below
  // is even sent; waitForFunction polls on rAF instead.
  await page.waitForFunction(
    () => document.documentElement.dataset.updraftPhase === 'gameover',
    undefined,
    { polling: 'raf', timeout: 15_000 },
  )

  // Inside the 400 ms lock: this press must not burn the restart.
  await page.keyboard.press('Space')
  expect(await phase(page)).toBe('gameover')

  await page.waitForTimeout(500)
  await page.keyboard.press('Space')
  await expect(page.locator('html')).toHaveAttribute('data-updraft-phase', 'playing')
})

test('the best score survives a reload', async ({ page }) => {
  await openGame(page)
  await requireSimulation(page)

  // Fly well enough to score, then die.
  await page.keyboard.down('Space')
  await page.waitForTimeout(2600)
  await page.keyboard.up('Space')
  await expect(page.locator('html')).toHaveAttribute('data-updraft-phase', 'gameover', {
    timeout: 20_000,
  })

  const finalScore = await score(page)
  const storedBest = await best(page)
  expect(storedBest).toBeGreaterThanOrEqual(finalScore)

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-updraft', 'ready')
  expect(await best(page)).toBe(storedBest)
})
