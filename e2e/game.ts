import { expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Helpers shared by the browser suite (spec §3, §4 step 8).
 *
 * The shell publishes its state as `data-updraft-*` attributes on <html> (see
 * src/main.ts). Asserting against those is the honest way to check "the run
 * reached game over with a score": the alternative is reading pixels off a
 * canvas, which proves nothing and breaks on every tuning change. The pixels
 * are evidence for a human instead — the screenshots below.
 */

export const SCREENSHOT_DIR = 'test-results/screens'

/** Load the game. A fixed seed makes the course identical in every browser and run. */
export async function openGame(page: Page, options: { seed?: number } = {}): Promise<Locator> {
  const seed = options.seed ?? 20261018
  await page.goto(`/?seed=${seed}`)
  await expect(page.locator('html')).toHaveAttribute('data-updraft', 'ready')
  const canvas = page.locator('canvas#game')
  await expect(canvas).toBeVisible()
  return canvas
}

/** Collect console errors and page exceptions for the lifetime of a test. */
export function watchConsole(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

export async function phase(page: Page): Promise<string> {
  return (await page.locator('html').getAttribute('data-updraft-phase')) ?? ''
}

export async function score(page: Page): Promise<number> {
  return Number(await page.locator('html').getAttribute('data-updraft-score'))
}

export async function best(page: Page): Promise<number> {
  return Number(await page.locator('html').getAttribute('data-updraft-best'))
}

/**
 * TEMPORARY — remove with `probeSimulation` in src/app/scenes.ts.
 *
 * The shell is merged before the simulation body lands (GOK-4). Until it does,
 * `step` throws and no run can start, so the run-level assertions below skip
 * themselves *loudly* rather than being quietly omitted or asserting nothing.
 */
export async function simulationReady(page: Page): Promise<boolean> {
  return (await page.locator('html').getAttribute('data-updraft-simulation')) === 'ready'
}

/** Logical field coordinates -> a client point inside the canvas. */
export async function logicalPoint(
  canvas: Locator,
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  const box = await canvas.boundingBox()
  if (!box) throw new Error('the canvas has no box — it did not mount')
  return { x: box.x + (x / 540) * box.width, y: box.y + (y / 960) * box.height }
}

/** Does this browser context deliver touch events? */
export async function hasTouch(page: Page): Promise<boolean> {
  return page.evaluate(() => 'ontouchstart' in window || navigator.maxTouchPoints > 0)
}

/** Save a named screenshot as a CI artifact; the deploy task reuses these as evidence. */
export async function captureScene(page: Page, testInfo: TestInfo, scene: string): Promise<string> {
  const viewport = page.viewportSize()
  const size = viewport ? `${viewport.width}x${viewport.height}` : 'unknown'
  await mkdir(SCREENSHOT_DIR, { recursive: true })
  const path = join(SCREENSHOT_DIR, `${scene}-${size}.png`)
  await page.screenshot({ path })
  await testInfo.attach(`${scene} ${size}`, { path, contentType: 'image/png' })
  return path
}
