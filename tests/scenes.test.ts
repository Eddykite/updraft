import { describe, expect, it, vi } from 'vitest'
import { createSceneHost } from '../src/app/scenes.js'
import type { SceneHostDeps } from '../src/app/scenes.js'
import {
  FIXED_DT,
  GAME_OVER_INPUT_LOCK,
  HINT_FADE_DURATION,
  HINT_FADE_SECONDS,
  MULTIPLIER_PULSE_SECONDS,
} from '../src/game/constants.js'
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
  let multiplierNext = 0

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
    if (multiplierNext > 0) {
      events.push({ type: 'multiplier_up', multiplier: multiplierNext })
      multiplierNext = 0
    }
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
    /** Emit a multiplier step-up on the next step, to drive the presentation pulse. */
    bumpMultiplier(to = 2) {
      multiplierNext = to
    },
  }
}

/**
 * A recording 2D context.
 *
 * The render path is the half of this file that unit tests used to skip
 * entirely — `ctx: null` made `render()` a one-line no-op, so the hint fade, the
 * HUD model and every branch feeding them were only ever exercised in a browser.
 * This is not here to assert draw calls, which is theatre: it is here so the
 * *decisions* the scene makes about what to draw are testable in Node. The only
 * assertions made against it are about text that is or is not on screen.
 */
function recordingCtx() {
  const texts: string[] = []
  const target: Record<string, unknown> = {
    fillText: (text: string) => texts.push(text),
    createLinearGradient: () => ({ addColorStop: () => {} }),
  }
  const ctx = new Proxy(target, {
    get(object, property: string) {
      if (!(property in object)) object[property] = () => undefined
      return object[property]
    },
    set(object, property: string, value: unknown) {
      object[property] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, texts, drawn: (needle: string) => texts.includes(needle) }
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

describe('what the scene decides to draw', () => {
  /**
   * The hint is a first-run courtesy: it fades out partway through the first
   * run and never returns. Both halves live in this file — the fade is a
   * presentation timer and `hintRunsRemaining` is decremented on the crash —
   * so both are asserted here rather than in a browser.
   */
  it('shows the hint at the start of the first run and lets it fade', () => {
    const canvas = recordingCtx()
    const h = host({ ctx: canvas.ctx })
    h.input.press()
    h.scene.update(FIXED_DT)

    h.scene.render(0)
    expect(canvas.drawn('hold to climb')).toBe(true)

    // Past the fade window, the hint is gone and the rest of the HUD is not.
    advance(h.scene, HINT_FADE_SECONDS + HINT_FADE_DURATION + 0.1)
    canvas.texts.length = 0
    h.scene.render(0)
    expect(canvas.drawn('hold to climb')).toBe(false)
    expect(canvas.texts.length).toBeGreaterThan(0)
  })

  it('does not show it again on the next run', () => {
    const canvas = recordingCtx()
    const h = host({ ctx: canvas.ctx })
    h.input.press()
    h.scene.update(FIXED_DT)
    h.sim.crash()
    h.scene.update(FIXED_DT)

    advance(h.scene, GAME_OVER_INPUT_LOCK)
    h.input.press()
    h.scene.update(FIXED_DT)
    canvas.texts.length = 0
    h.scene.render(0)
    expect(canvas.drawn('hold to climb')).toBe(false)
  })

  /** A second crash must not take the hint counter negative. */
  it('survives a second crash with the hint already spent', () => {
    const h = host()
    for (let run = 0; run < 2; run += 1) {
      h.input.press()
      h.scene.update(FIXED_DT)
      h.sim.crash()
      h.scene.update(FIXED_DT)
      advance(h.scene, GAME_OVER_INPUT_LOCK)
    }
    expect(h.scene.current().phase).toBe('gameover')
  })

  it('draws every scene the game can be in', () => {
    const canvas = recordingCtx()
    const h = host({ ctx: canvas.ctx })

    h.scene.render(0)
    expect(canvas.drawn('UPDRAFT')).toBe(true)

    h.input.press()
    h.scene.update(FIXED_DT)
    h.scene.pause()
    canvas.texts.length = 0
    h.scene.render(0)
    expect(canvas.drawn('PAUSED')).toBe(true)

    h.input.press()
    h.scene.update(FIXED_DT)
    h.input.hold(true)
    advance(h.scene, 0.2)
    h.sim.crash()
    h.scene.update(FIXED_DT)
    canvas.texts.length = 0
    h.scene.render(0.5)
    expect(canvas.drawn('NEW BEST!')).toBe(true)
  })

  /**
   * The multiplier pulse is a presentation timer that decays to zero over
   * MULTIPLIER_PULSE_SECONDS. It grows the number rather than flashing it — the
   * accessibility rule — and nothing outside this file may depend on it, so the
   * only thing to assert is that driving it draws without incident.
   */
  it('runs the multiplier pulse down without flashing anything', () => {
    const canvas = recordingCtx()
    const h = host({ ctx: canvas.ctx })
    h.input.press()
    h.scene.update(FIXED_DT)

    h.sim.bumpMultiplier(3)
    h.scene.update(FIXED_DT)
    expect(h.audio.played).toContainEqual({ type: 'multiplier_up', multiplier: 3 })

    h.scene.render(0)
    advance(h.scene, MULTIPLIER_PULSE_SECONDS * 2)
    expect(() => {
      h.scene.render(0)
    }).not.toThrow()
  })
})

describe('wired to the real simulation and the real storage', () => {
  /**
   * Everything above injects a fake `step` and a fake storage, which is what
   * makes the machine testable — but it also means the default wiring, the one
   * main.ts actually uses, was never executed outside a browser. This runs the
   * shell against the real simulation with no injection at all. localStorage is
   * absent in Node, which io/storage.ts treats as a normal condition.
   */
  it('plays a real run headlessly, remembering nothing and throwing nothing', () => {
    const input = fakeInput()
    const audio = fakeAudio()
    const canvas = recordingCtx()
    const scene = createSceneHost({
      input: input.source,
      audio: audio.audio,
      ctx: canvas.ctx,
      seed: 20261018,
      build: 'test123',
    })

    expect(scene.status()).toEqual({ phase: 'title', score: 0, best: 0, muted: false })

    input.press()
    scene.update(FIXED_DT)
    expect(scene.current().phase).toBe('playing')

    input.hold(true)
    advance(scene, 2)
    scene.render(0)

    expect(scene.current().elapsed).toBeGreaterThan(1)
    expect(canvas.texts.length).toBeGreaterThan(0)
  })
})
