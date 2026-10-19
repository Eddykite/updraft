import { expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import { STORAGE_KEY } from '../src/game/constants.js'
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

/** The default course. Fixed so every browser, machine and run flies the same one. */
export const DEFAULT_SEED = 20261018

/** Load the game. A fixed seed makes the course identical in every browser and run. */
export async function openGame(page: Page, options: { seed?: number } = {}): Promise<Locator> {
  const seed = options.seed ?? DEFAULT_SEED
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
 * Logical field coordinates -> a client point inside the canvas.
 *
 * The field size is read off the canvas rather than hardcoded. main.ts publishes
 * it for exactly this purpose, and a test that re-derives geometry the app
 * already states is a test that can silently disagree with it.
 */
export async function logicalPoint(
  canvas: Locator,
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  const box = await canvas.boundingBox()
  if (!box) throw new Error('the canvas has no box — it did not mount')
  const width = Number(await canvas.getAttribute('data-logical-width'))
  const height = Number(await canvas.getAttribute('data-logical-height'))
  if (!width || !height) throw new Error('the canvas did not publish its logical size')
  return { x: box.x + (x / width) * box.width, y: box.y + (y / height) * box.height }
}

/**
 * An input tape: milliseconds to hold, then to release, alternating, starting
 * held. Found by searching schedules against the real `step()` on DEFAULT_SEED
 * — see tools/feel/tape-search.ts, which is how it is re-derived.
 *
 * **Re-derived for spec v2.** The tape is a property of the course, so moving
 * the gate spawn x, the ramp and the ring's placement invalidated the old one
 * outright: it scored zero on a clean replay of the v2 course. That is the
 * failure mode worth knowing about — nothing in the browser suite asserts the
 * tape scores, so a rotten tape shows up only as quietly worse deploy evidence.
 *
 * It is a *best effort* at a scoring run, and nothing asserts that it scores.
 * That caveat is the whole design note, so it is worth the paragraph.
 *
 * UPDRAFT's accelerations are strong in both directions (±1400/1500 px/s²), so
 * no input keeps the kite roughly where it is: holding pins it to the ceiling,
 * which fits through no gate, and releasing drops it to the ground in under a
 * second. Scoring takes real flying. A browser test cannot fly, because closing
 * the loop needs the kite's altitude and the shell deliberately does not publish
 * it — it exposes what a player can see, and telemetry nothing else needs is
 * telemetry that goes stale.
 *
 * Open-loop replay was then tried and rejected on evidence. This tape survives
 * +50 ms of delay per phase in simulation, which is comfortably more than a CDP
 * round trip costs — and it still scored zero three times running when the suite
 * was run fully parallel, because contention makes the browser drop frames and
 * the game's own catch-up clamp then runs it in slow motion relative to the
 * test's wall clock. A test that needs a quiet machine is a test that fails for
 * reasons unrelated to the code.
 *
 * So: the *simulation* proves a played run scores, deterministically, in
 * tests/playable.test.ts. The browser proves the things only a browser can —
 * that real key and touch events reach the simulation, and that nothing a run
 * does destroys a stored best. This tape just makes the game-over screenshot
 * show a game someone played, when the machine is quiet enough.
 */
export const SCORING_TAPE = [831, 389, 851, 498, 301, 536, 542, 516, 402] as const

/**
 * Play the tape from the title screen, then let go and wait for the crash.
 * Returns the final score, which may legitimately be 0 — see SCORING_TAPE.
 */
export async function flyAndCrash(page: Page): Promise<number> {
  await page.keyboard.press('Space')
  await expect(page.locator('html')).toHaveAttribute('data-updraft-phase', 'playing')

  for (const [index, duration] of SCORING_TAPE.entries()) {
    if (index % 2 === 0) await page.keyboard.down('Space')
    else await page.keyboard.up('Space')
    await page.waitForTimeout(duration)
    if ((await phase(page)) !== 'playing') break
  }
  await page.keyboard.up('Space')

  await expect(page.locator('html')).toHaveAttribute('data-updraft-phase', 'gameover', {
    timeout: 20_000,
  })
  return score(page)
}

/** Put a known best score in storage before the page loads. */
export async function seedBest(page: Page, value: number): Promise<void> {
  await page.addInitScript(
    ([key, best]: [string, number]) => {
      window.localStorage.setItem(key, JSON.stringify({ v: 1, best, muted: false }))
    },
    [STORAGE_KEY, value] as [string, number],
  )
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
