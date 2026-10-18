import { describe, expect, it, vi } from 'vitest'
import { createSceneHost } from '../src/app/scenes.js'
import type { SceneHostDeps } from '../src/app/scenes.js'
import { FIXED_DT, GAME_OVER_INPUT_LOCK } from '../src/game/constants.js'
import { createInitialState } from '../src/game/state.js'
import type { GameEvent, GameState, InputState } from '../src/game/state.js'
import type { Audio } from '../src/io/audio.js'
import type { InputSource } from '../src/io/input.js'

/**
 * The shell state machine (spec §2).
 *
 * The simulation is injected, so everything this layer actually owns is
 * testable today and in Node: the game-over input lock, pause/resume, draining
 * events into audio and storage, and the best-score write. The real `step` is
 * covered by the simulation task's own suite.
 */

/**
 * A stand-in simulation with the contract's transitions and nothing else:
 * confirm starts a run, holding scores, and `crash()` ends it.
 */
function fakeSimulation() {
  let crashNext = false

  function step(state: GameState, input: InputState, dt: number): GameState {
    if (state.phase === 'title' || state.phase === 'gameover') {
      if (!input.confirmPressed) return state
      return {
        ...createInitialState(state.seed),
        phase: 'playing',
        events: [{ type: 'run_started' }],
      }
    }
    if (state.phase !== 'playing') return state

    const events: GameEvent[] = []
    const score = state.score + (input.holding ? 1 : 0)
    if (crashNext) {
      crashNext = false
      events.push({ type: 'crashed', cause: 'ground', score })
      return { ...state, phase: 'gameover', score, crashCause: 'ground', events }
    }
    return { ...state, elapsed: state.elapsed + dt, tick: state.tick + 1, score, events }
  }

  return {
    step,
    crash() {
      crashNext = true
    },
  }
}

function fakeInput() {
  let next: InputState = { holding: false, confirmPressed: false }
  const swallowHold = vi.fn(() => {
    next = { holding: false, confirmPressed: false }
  })
  const source: InputSource = {
    sample: () => {
      const sampled = next
      next = { holding: next.holding, confirmPressed: false }
      return sampled
    },
    swallowHold,
    setViewport: vi.fn(),
    dispose: vi.fn(),
  }
  return {
    source,
    swallowHold,
    press(holding = true) {
      next = { holding, confirmPressed: true }
    },
    hold(holding: boolean) {
      next = { holding, confirmPressed: false }
    },
  }
}

function fakeAudio() {
  const played: GameEvent[] = []
  const unlock = vi.fn<() => void>()
  const setMuted = vi.fn<(muted: boolean) => void>()
  const audio: Audio = {
    unlock,
    play: (events) => played.push(...events),
    setMuted,
    isMuted: () => false,
    dispose: vi.fn<() => void>(),
  }
  return { audio, played, unlock, setMuted }
}

function fakeStorage(best = 0, muted = false) {
  const state = { best, muted }
  const writeBest = vi.fn((score: number) => {
    state.best = score
  })
  const writeMuted = vi.fn((value: boolean) => {
    state.muted = value
  })
  return {
    state,
    writeBest,
    writeMuted,
    api: {
      readBest: () => state.best,
      writeBest,
      readMuted: () => state.muted,
      writeMuted,
    },
  }
}

function host(overrides: Partial<SceneHostDeps> = {}) {
  const sim = fakeSimulation()
  const input = fakeInput()
  const audio = fakeAudio()
  const storage = fakeStorage()
  const statuses: unknown[] = []
  const scene = createSceneHost({
    input: input.source,
    audio: audio.audio,
    ctx: null,
    seed: 42,
    build: 'test123',
    storage: storage.api,
    step: sim.step,
    onStatusChange: (status) => statuses.push(status),
    ...overrides,
  })
  return { scene, sim, input, audio, storage, statuses }
}

/** Run `seconds` worth of fixed steps. */
function advance(scene: { update(dt: number): void }, seconds: number): void {
  const steps = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < steps; i += 1) scene.update(FIXED_DT)
}

describe('starting a run', () => {
  it('begins at the title screen and starts on a press', () => {
    const h = host()
    expect(h.scene.current().phase).toBe('title')

    h.input.press()
    h.scene.update(FIXED_DT)

    expect(h.scene.current().phase).toBe('playing')
    expect(h.audio.played).toContainEqual({ type: 'run_started' })
  })

  it('publishes status only when something changes', () => {
    const h = host()
    const before = h.statuses.length
    h.scene.update(FIXED_DT)
    h.scene.update(FIXED_DT)
    expect(h.statuses.length).toBe(before)

    h.input.press()
    h.scene.update(FIXED_DT)
    expect(h.statuses.length).toBe(before + 1)
  })
})

describe('the game-over input lock', () => {
  it('ignores input for GAME_OVER_INPUT_LOCK so a death-frame tap is not burned', () => {
    const h = host()
    h.input.press()
    h.scene.update(FIXED_DT)
    h.sim.crash()
    h.scene.update(FIXED_DT)
    expect(h.scene.current().phase).toBe('gameover')

    // The finger that was on the screen when the kite hit the ground.
    h.input.press()
    h.scene.update(FIXED_DT)
    expect(h.scene.current().phase).toBe('gameover')

    advance(h.scene, GAME_OVER_INPUT_LOCK)
    h.input.press()
    h.scene.update(FIXED_DT)
    expect(h.scene.current().phase).toBe('playing')
  })
})

describe('best score', () => {
  it('writes a new best on a crash and reports it as new', () => {
    const h = host()
    h.input.press()
    h.scene.update(FIXED_DT)
    h.input.hold(true)
    advance(h.scene, 0.2)
    h.sim.crash()
    h.scene.update(FIXED_DT)

    const score = h.scene.current().score
    expect(score).toBeGreaterThan(0)
    expect(h.storage.writeBest).toHaveBeenCalledWith(score)
    expect(h.scene.status().best).toBe(score)
  })

  it('does not write when the run did not beat the stored best', () => {
    const storage = fakeStorage(5000)
    const h = host({ storage: storage.api })
    h.input.press()
    h.scene.update(FIXED_DT)
    h.sim.crash()
    h.scene.update(FIXED_DT)

    expect(storage.writeBest).not.toHaveBeenCalled()
    expect(h.scene.status().best).toBe(5000)
  })

  it('reads the stored best at construction', () => {
    const storage = fakeStorage(1234)
    const h = host({ storage: storage.api })
    expect(h.scene.status().best).toBe(1234)
  })
})

describe('pause and resume', () => {
  it('does not advance the simulation while paused', () => {
    const h = host()
    h.input.press()
    h.scene.update(FIXED_DT)
    h.input.hold(true)
    advance(h.scene, 0.1)

    h.scene.pause()
    expect(h.scene.current().phase).toBe('paused')
    const frozen = h.scene.current()
    advance(h.scene, 0.5)
    expect(h.scene.current().tick).toBe(frozen.tick)
    expect(h.scene.current().score).toBe(frozen.score)
  })

  it('the press that resumes does not also climb', () => {
    const h = host()
    h.input.press()
    h.scene.update(FIXED_DT)
    h.scene.pause()

    h.input.press()
    h.scene.update(FIXED_DT)

    expect(h.scene.current().phase).toBe('playing')
    expect(h.input.swallowHold).toHaveBeenCalledTimes(1)
  })

  it('pausing at the title screen or after a crash does nothing', () => {
    const h = host()
    h.scene.pause()
    expect(h.scene.current().phase).toBe('title')

    h.input.press()
    h.scene.update(FIXED_DT)
    h.sim.crash()
    h.scene.update(FIXED_DT)
    h.scene.pause()
    expect(h.scene.current().phase).toBe('gameover')
  })
})

describe('mute', () => {
  it('toggles, tells the audio layer, and persists', () => {
    const h = host()
    expect(h.scene.status().muted).toBe(false)

    h.scene.toggleMute()
    expect(h.scene.status().muted).toBe(true)
    expect(h.audio.setMuted).toHaveBeenLastCalledWith(true)
    expect(h.storage.writeMuted).toHaveBeenLastCalledWith(true)

    h.scene.toggleMute()
    expect(h.scene.status().muted).toBe(false)
  })

  it('restores a persisted mute at construction', () => {
    const storage = fakeStorage(0, true)
    const h = host({ storage: storage.api })
    expect(h.scene.status().muted).toBe(true)
    expect(h.audio.setMuted).toHaveBeenCalledWith(true)
  })
})

describe('event draining', () => {
  it('hands every simulation event to audio and empties the queue', () => {
    const h = host()
    h.input.press()
    h.scene.update(FIXED_DT)
    expect(h.scene.current().events).toEqual([])
    expect(h.audio.played).toEqual([{ type: 'run_started' }])
  })

  it('unlockAudio forwards the first gesture', () => {
    const h = host()
    h.scene.unlockAudio()
    expect(h.audio.unlock).toHaveBeenCalledTimes(1)
  })
})

describe('rendering without a context', () => {
  it('is a no-op rather than a crash (headless unit tests)', () => {
    const h = host()
    expect(() => {
      h.scene.render(0.5)
    }).not.toThrow()
  })
})
