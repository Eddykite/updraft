/* eslint-disable @typescript-eslint/no-unused-vars -- contract stub; remove when implemented */
/**
 * Draws a GameState to a 2D context (spec §2).
 *
 * Read-only: the renderer never mutates state and never decides anything. Flat
 * geometry drawn in code — no sprite sheets, no image files, no font files
 * (system font stack only, spec §8 decision 2). Introducing any binary asset is
 * a spec revision, not a build-task decision.
 *
 * There is deliberately no coverage gate on this directory (spec §3): asserting
 * draw calls is theatre. Its evidence is the Playwright screenshots.
 */

import type { GameState } from '../game/state.js'
import type { Viewport } from './viewport.js'

export function render(ctx: CanvasRenderingContext2D, state: GameState, viewport: Viewport): void {
  throw new Error('not implemented')
}
