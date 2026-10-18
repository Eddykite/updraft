import { expect, test } from '@playwright/test'

/**
 * Scaffold smoke (spec §4 step 8).
 *
 * What is assertable today: the built bundle loads, the canvas mounts at the
 * right logical size and a sane letterboxed CSS size, and the console is clean.
 *
 * The full §3 browser suite — a key press and a touch both start a run, holding
 * keeps the kite alive past 3 s, a deliberate crash reaches game over with the
 * score shown, restart works, best score survives a reload, mute persists, plus
 * the three-scene screenshots at 1440×900 and 390×844 — lands with the shell
 * task. It is listed as `test.fixme` below so the suite names the work rather
 * than silently omitting it.
 */

test('boots the built bundle with a mounted canvas and a clean console', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))

  await page.goto('/')

  await expect(page).toHaveTitle('UPDRAFT')
  await expect(page.locator('html')).toHaveAttribute('data-updraft', 'ready')

  const canvas = page.locator('canvas#game')
  await expect(canvas).toBeVisible()
  await expect(canvas).toHaveAttribute('data-logical-width', '540')
  await expect(canvas).toHaveAttribute('data-logical-height', '960')

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

  expect(consoleErrors).toEqual([])
})

test.fixme('a key press starts a run', async () => {})
test.fixme('a touch starts a run', async () => {})
test.fixme('holding keeps the kite alive past 3 s', async () => {})
test.fixme('a deliberate crash reaches game over with the score shown', async () => {})
test.fixme('restart works from the game-over screen', async () => {})
test.fixme('best score survives a reload', async () => {})
test.fixme('the mute toggle persists', async () => {})
test.fixme('captures title / playing / game-over screenshots at both viewports', async () => {})
