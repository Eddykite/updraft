/**
 * Scene machine: Title | Playing | Paused | GameOver (spec §2).
 *
 * The scene is *read* from `state.phase` — the simulation owns the transitions,
 * this layer reacts to them: drain events into audio, write the best score on a
 * crash, swallow input for GAME_OVER_INPUT_LOCK after death so a death-frame tap
 * doesn't instantly burn a restart.
 *
 * One-way flow, strictly (spec §2):
 *
 *   input -> step() -> state -> {renderer, hud} (read-only)
 *                   \-> events[] -> {audio, storage}
 *
 * The renderer never mutates state and the simulation never reads the clock. The
 * only things this file owns are presentation timers — the hint fade, the
 * multiplier pulse, the game-over input lock — and they are deliberately *not*
 * in GameState: none of them may affect a replay.
 *
 * `step` and the storage functions arrive as injected dependencies so the whole
 * shell state machine is unit-testable against a fake simulation, in Node, with
 * no DOM and no canvas.
 */

import {
  GAME_OVER_INPUT_LOCK,
  HINT_FADE_SECONDS,
  MULTIPLIER_PULSE_SECONDS,
  HINT_FADE_DURATION,
} from '../game/constants.js'
import { createInitialState, drainEvents, pause, resume } from '../game/state.js'
import type { GameEvent, GameState } from '../game/state.js'
import { step as realStep } from '../game/update.js'
import type { Audio } from '../io/audio.js'
import type { InputSource } from '../io/input.js'
import * as realStorage from '../io/storage.js'
import { drawHud } from '../render/hud.js'
import type { HudModel } from '../render/hud.js'
import { render } from '../render/renderer.js'

export interface SceneHost {
  /** Feed one step's worth of input and advance. */
  update(dt: number): void
  /** Draw the current state. */
  render(alpha: number): void
  /** Current state, for tests and the shell. */
  current(): GameState
  /** Esc, focus loss or a hidden tab. Does nothing unless a run is in progress. */
  pause(): void
  /** M, or a tap on the speaker. Persists. */
  toggleMute(): void
  /** The first user gesture; the only moment WebAudio can be unlocked. */
  unlockAudio(): void
  /** What the shell publishes for the Playwright suite — see main.ts. */
  status(): SceneStatus
}

/** The externally observable state of the shell. Published as DOM data attributes. */
export interface SceneStatus {
  readonly phase: GameState['phase']
  readonly score: number
  readonly best: number
  readonly muted: boolean
}

type Storage = Pick<typeof realStorage, 'readBest' | 'writeBest' | 'readMuted' | 'writeMuted'>

export interface SceneHostDeps {
  readonly input: InputSource
  readonly audio: Audio
  /** null in unit tests, where nothing is drawn. */
  readonly ctx: CanvasRenderingContext2D | null
  readonly seed: number
  /** Commit SHA, rendered on the title screen (spec §6, item 2). */
  readonly build: string
  readonly storage?: Storage
  /** Injected so the shell can be tested against a fake simulation. */
  readonly step?: typeof realStep
  readonly onStatusChange?: (status: SceneStatus) => void
}

export function createSceneHost(deps: SceneHostDeps): SceneHost {
  const storage: Storage = deps.storage ?? realStorage
  const step = deps.step ?? realStep

  let state = createInitialState(deps.seed)
  let best = storage.readBest()
  let muted = storage.readMuted()
  deps.audio.setMuted(muted)

  // Presentation-only timers. None of these are in GameState, and none of them
  // may ever influence it — a replay must not depend on how long a card was up.
  let time = 0
  let gameOverLock = 0
  let multiplierPulse = 0
  let newBest = false
  /** The hint is a first-run courtesy, not a permanent HUD element. */
  let hintRunsRemaining = 1
  let published: SceneStatus | null = null

  function publish(): void {
    const next: SceneStatus = {
      phase: state.phase,
      score: state.score,
      best,
      muted,
    }
    if (
      published &&
      published.phase === next.phase &&
      published.score === next.score &&
      published.best === next.best &&
      published.muted === next.muted
    ) {
      return
    }
    published = next
    deps.onStatusChange?.(next)
  }

  function handleEvents(events: readonly GameEvent[]): void {
    deps.audio.play(events)
    for (const event of events) {
      switch (event.type) {
        case 'run_started':
          newBest = false
          multiplierPulse = 0
          gameOverLock = 0
          break
        case 'multiplier_up':
          multiplierPulse = 1
          break
        case 'crashed':
          // Death-frame taps are swallowed for GAME_OVER_INPUT_LOCK seconds.
          gameOverLock = GAME_OVER_INPUT_LOCK
          if (hintRunsRemaining > 0) hintRunsRemaining -= 1
          if (event.score > best) {
            best = event.score
            newBest = true
            storage.writeBest(best)
          }
          break
        default:
          break
      }
    }
  }

  function update(dt: number): void {
    time += dt
    if (multiplierPulse > 0)
      multiplierPulse = Math.max(0, multiplierPulse - dt / MULTIPLIER_PULSE_SECONDS)
    if (gameOverLock > 0) gameOverLock = Math.max(0, gameOverLock - dt)

    const input = deps.input.sample()

    if (state.phase === 'paused') {
      // No time passes while paused — the simulation is simply not stepped.
      // The press that resumes is spent on resuming: it must not also yank the
      // kite upward, so the hold is dropped until the next fresh press.
      if (input.confirmPressed) {
        state = resume(state)
        deps.input.swallowHold()
      }
      publish()
      return
    }

    // The game-over screen ignores input entirely for 400 ms.
    const accepted =
      state.phase === 'gameover' && gameOverLock > 0
        ? { holding: input.holding, confirmPressed: false }
        : input

    state = step(state, accepted, dt)

    if (state.events.length > 0) {
      const [drained, events] = drainEvents(state)
      state = drained
      handleEvents(events)
    }

    publish()
  }

  function hudModel(): HudModel {
    const sinceFade = state.elapsed - HINT_FADE_SECONDS
    const hintAlpha = sinceFade <= 0 ? 1 : Math.max(0, 1 - sinceFade / HINT_FADE_DURATION)
    return {
      best,
      muted,
      showHint: hintRunsRemaining > 0 && hintAlpha > 0,
      hintAlpha,
      multiplierPulse,
      newBest,
      restartReady: gameOverLock <= 0,
      time,
      build: deps.build,
    }
  }

  publish()

  return {
    update,

    render(alpha: number): void {
      const ctx = deps.ctx
      if (!ctx) return
      render(ctx, state, { time, alpha })
      drawHud(ctx, state, hudModel())
    },

    current(): GameState {
      return state
    },

    pause(): void {
      const paused = pause(state)
      if (paused !== state) {
        state = paused
        publish()
      }
    },

    toggleMute(): void {
      muted = !muted
      deps.audio.setMuted(muted)
      storage.writeMuted(muted)
      publish()
    },

    unlockAudio(): void {
      deps.audio.unlock()
    },

    status(): SceneStatus {
      return { phase: state.phase, score: state.score, best, muted }
    },
  }
}
