/**
 * Scene machine: Title | Playing | Paused | GameOver (spec §2).
 *
 * The scene is *read* from `state.phase` — the simulation owns the transitions,
 * this layer reacts to them: drain events into audio, write the best score on a
 * crash, swallow input for GAME_OVER_INPUT_LOCK after death so a death-frame tap
 * doesn't instantly burn a restart.
 */

import type { GameState } from '../game/state.js'

export interface SceneHost {
  /** Feed one step's worth of input and advance. */
  update(dt: number): void
  /** Draw the current state. */
  render(alpha: number): void
  /** Current state, for tests and the shell. */
  current(): GameState
}

export function createSceneHost(): SceneHost {
  throw new Error('not implemented')
}
