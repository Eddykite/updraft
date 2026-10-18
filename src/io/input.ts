/* eslint-disable @typescript-eslint/no-unused-vars -- contract stub; remove when implemented */
/**
 * keyboard + pointer + touch -> InputState (spec §2).
 *
 * Desktop: Space / ↑ / W / left mouse button climb; Esc pauses; M mutes.
 * Touch: hold anywhere on the canvas climbs; the speaker icon has a 44×44 hit area.
 *
 * Details that matter (concept doc):
 *  - while ANY pointer is down the kite climbs (multi-touch is "held" if at
 *    least one finger is down)
 *  - losing focus pauses, and the next press resumes rather than climbing
 *  - `confirmPressed` is an edge: true for exactly one step
 */

import type { InputState } from '../game/state.js'

export interface InputSource {
  /** Snapshot the current input for one simulation step and clear edge flags. */
  sample(): InputState
  /** Detach every listener. */
  dispose(): void
}

export function createInputSource(target: HTMLCanvasElement): InputSource {
  throw new Error('not implemented')
}
