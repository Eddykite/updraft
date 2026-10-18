import { expect, test } from '@playwright/test'
import { best, captureScene, logicalPoint, openGame, phase, watchConsole } from './game.js'
import { MUTE_BUTTON } from '../src/render/hud.js'

/**
 * The shell against the built bundle (spec §4 step 8).
 *
 * Everything here is true with or without the simulation body: the page boots,
 * the canvas is mounted at the right logical size and letterboxed rather than
 * stretched, the console is clean, the speaker is a real 44 × 44 control whose
 * state survives a reload, and a tampered-with best score cannot reach the HUD.
 *
 * The run-level assertions live in run.spec.ts.
 */

test('boots the built bundle with a mounted canvas and a clean console', async ({ page }) => {
  const errors = watchConsole(page)
  const canvas = await openGame(page)

  await expect(page).toHaveTitle('UPDRAFT')
  await expect(canvas).toHaveAttribute('data-logical-width', '540')
  await expect(canvas).toHaveAttribute('data-logical-height', '960')
  expect(await phase(page)).toBe('title')

  // Letterboxed, never stretched: the element keeps the 9:16 field ratio and fits.
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  if (box && viewport) {
    expect(box.width).toBeGreaterThan(0)
    expect(box.width / box.height).toBeCloseTo(540 / 960, 1)
    expect(box.width).toBeLessThanOrEqual(viewport.width + 1)
    expect(box.height).toBeLessThanOrEqual(viewport.height + 1)
  }

  expect(errors).toEqual([])
})

test('keeps running for a few seconds without logging anything', async ({ page }) => {
  const errors = watchConsole(page)
  await openGame(page)
  // The loop is live on the title screen too: clouds drift, the kite breathes.
  await page.waitForTimeout(2000)
  expect(errors).toEqual([])
})

test('the mute toggle persists across a reload', async ({ page }) => {
  const errors = watchConsole(page)
  const canvas = await openGame(page)

  await expect(page.locator('html')).toHaveAttribute('data-updraft-muted', 'false')

  // Tap the middle of the speaker's 44 × 44 hit area, in logical coordinates.
  // Derived from MUTE_BUTTON — the same single source hud.ts draws and input.ts
  // hit-tests — so the claim that the icon and the tap target cannot drift is
  // actually what this test checks, rather than a pair of matching literals.
  const speaker = await logicalPoint(
    canvas,
    MUTE_BUTTON.x + MUTE_BUTTON.width / 2,
    MUTE_BUTTON.y + MUTE_BUTTON.height / 2,
  )
  await page.mouse.click(speaker.x, speaker.y)
  await expect(page.locator('html')).toHaveAttribute('data-updraft-muted', 'true')

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-updraft', 'ready')
  await expect(page.locator('html')).toHaveAttribute('data-updraft-muted', 'true')

  // ...and tapping the speaker never counts as a press that starts a run.
  expect(await phase(page)).toBe('title')
  expect(errors).toEqual([])
})

test('a persisted best score is read back onto the title screen', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('updraft.best.v1', '{"v":1,"best":1234,"muted":false}')
  })
  await openGame(page)
  expect(await best(page)).toBe(1234)
})

test('a tampered-with best score falls back to zero instead of rendering garbage', async ({
  page,
}) => {
  const errors = watchConsole(page)
  await page.addInitScript(() => {
    // The user can edit this. Corrupt JSON, a wrong version, a hostile number.
    window.localStorage.setItem('updraft.best.v1', '{"v":0,"best":"9e99"')
  })
  await openGame(page)

  expect(await best(page)).toBe(0)
  expect(errors).toEqual([])
})

test('captures the title screen as deploy evidence', async ({ page }, testInfo) => {
  await openGame(page)
  // One frame of settled animation, so the artifact is not a half-painted canvas.
  await page.waitForTimeout(400)
  await captureScene(page, testInfo, 'title')
})
