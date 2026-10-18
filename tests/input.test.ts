import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInputSource, logicalScaleFor } from '../src/io/input.js'
import type { InputSource } from '../src/io/input.js'
import { FIELD_WIDTH, MUTE_HIT_AREA } from '../src/game/constants.js'
import { MUTE_BUTTON } from '../src/render/hud.js'

/**
 * The input state machine (concept doc, "Controls").
 *
 * These are the details that decide whether the game feels broken: a multi-touch
 * grab must not drop the climb when one finger lifts, a pointer released outside
 * the canvas must still count as a release (or the kite climbs forever), and the
 * press that resumes from a pause must not also yank the kite upward.
 *
 * No DOM here — a tiny listener registry stands in for window and the canvas, so
 * this runs in Node with the rest of the suite.
 */

type Listener = (event: unknown) => void

class FakeEventTarget {
  readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string, event: Record<string, unknown> = {}): void {
    const payload = { preventDefault: () => undefined, ...event }
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(payload)
  }

  count(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
}

class FakeCanvas extends FakeEventTarget {
  getBoundingClientRect() {
    // A 540-logical-px field displayed 270 CSS px wide: scale 2 logical per CSS px.
    return { left: 20, top: 40, width: 270, height: 480 }
  }
}

let window: FakeEventTarget
let canvas: FakeCanvas
let input: InputSource
let events: {
  onPause: ReturnType<typeof vi.fn<() => void>>
  onMuteToggle: ReturnType<typeof vi.fn<() => void>>
  onGesture: ReturnType<typeof vi.fn<() => void>>
}

beforeEach(() => {
  window = new FakeEventTarget()
  canvas = new FakeCanvas()
  Object.defineProperty(globalThis, 'window', {
    value: window,
    configurable: true,
    writable: true,
  })
  events = {
    onPause: vi.fn<() => void>(),
    onMuteToggle: vi.fn<() => void>(),
    onGesture: vi.fn<() => void>(),
  }
  input = createInputSource(canvas as unknown as HTMLCanvasElement, events)
  // CSS 270 px wide -> 2 logical px per CSS px, matching FakeCanvas.
  input.setViewport(logicalScaleFor(270))
})

afterEach(() => {
  input.dispose()
  Reflect.deleteProperty(globalThis, 'window')
})

/** A point inside the canvas, given in logical field coordinates. */
function pointerAt(logicalX: number, logicalY: number, pointerId = 1) {
  return {
    pointerId,
    pointerType: 'touch',
    button: 0,
    clientX: 20 + logicalX / 2,
    clientY: 40 + logicalY / 2,
  }
}

describe('keyboard', () => {
  it('climbs on Space, ArrowUp and W, and reports confirm as a one-step edge', () => {
    for (const code of ['Space', 'ArrowUp', 'KeyW']) {
      window.emit('keydown', { code })
      const first = input.sample()
      expect(first).toEqual({ holding: true, confirmPressed: true })
      // The edge is consumed; the hold is not.
      expect(input.sample()).toEqual({ holding: true, confirmPressed: false })
      window.emit('keyup', { code })
      expect(input.sample()).toEqual({ holding: false, confirmPressed: false })
    }
  })

  it('ignores auto-repeat so a held key is one press, not sixty', () => {
    window.emit('keydown', { code: 'Space' })
    input.sample()
    window.emit('keydown', { code: 'Space', repeat: true })
    expect(input.sample().confirmPressed).toBe(false)
  })

  it('keeps climbing while any of several keys is still down', () => {
    window.emit('keydown', { code: 'Space' })
    window.emit('keydown', { code: 'KeyW' })
    window.emit('keyup', { code: 'Space' })
    expect(input.sample().holding).toBe(true)
    window.emit('keyup', { code: 'KeyW' })
    expect(input.sample().holding).toBe(false)
  })

  it('Esc pauses and does not climb', () => {
    window.emit('keydown', { code: 'Escape' })
    expect(events.onPause).toHaveBeenCalledTimes(1)
    expect(input.sample()).toEqual({ holding: false, confirmPressed: false })
  })

  it('M toggles mute without starting a run', () => {
    window.emit('keydown', { code: 'KeyM' })
    expect(events.onMuteToggle).toHaveBeenCalledTimes(1)
    expect(input.sample().confirmPressed).toBe(false)
  })

  it('ignores keys that mean nothing here', () => {
    window.emit('keydown', { code: 'KeyQ' })
    expect(input.sample()).toEqual({ holding: false, confirmPressed: false })
  })
})

describe('pointer and touch', () => {
  it('a tap anywhere starts and holds', () => {
    canvas.emit('pointerdown', pointerAt(270, 500))
    expect(input.sample()).toEqual({ holding: true, confirmPressed: true })
    window.emit('pointerup', { pointerId: 1 })
    expect(input.sample().holding).toBe(false)
  })

  it('multi-touch counts as held while at least one finger is down', () => {
    canvas.emit('pointerdown', pointerAt(200, 500, 1))
    canvas.emit('pointerdown', pointerAt(300, 600, 2))
    window.emit('pointerup', { pointerId: 1 })
    expect(input.sample().holding).toBe(true)
    window.emit('pointerup', { pointerId: 2 })
    expect(input.sample().holding).toBe(false)
  })

  it('a release outside the canvas still releases', () => {
    canvas.emit('pointerdown', pointerAt(200, 500))
    // pointerup lands on the letterbox, not the canvas.
    window.emit('pointerup', { pointerId: 1 })
    expect(input.sample().holding).toBe(false)
  })

  it('a cancelled pointer releases too', () => {
    canvas.emit('pointerdown', pointerAt(200, 500))
    window.emit('pointercancel', { pointerId: 1 })
    expect(input.sample().holding).toBe(false)
  })

  it('ignores right and middle mouse buttons', () => {
    canvas.emit('pointerdown', { ...pointerAt(200, 500), pointerType: 'mouse', button: 2 })
    expect(input.sample()).toEqual({ holding: false, confirmPressed: false })
    canvas.emit('pointerdown', { ...pointerAt(200, 500), pointerType: 'mouse', button: 0 })
    expect(input.sample()).toEqual({ holding: true, confirmPressed: true })
  })
})

describe('the speaker button', () => {
  it('has a 44 x 44 hit area in the top-right corner', () => {
    expect(MUTE_BUTTON.width).toBe(MUTE_HIT_AREA)
    expect(MUTE_BUTTON.height).toBe(MUTE_HIT_AREA)
    expect(MUTE_BUTTON.x + MUTE_BUTTON.width).toBeLessThanOrEqual(FIELD_WIDTH)
  })

  it('toggles mute instead of flying, anywhere inside the hit area', () => {
    const corners: ReadonlyArray<readonly [number, number]> = [
      [MUTE_BUTTON.x + 1, MUTE_BUTTON.y + 1],
      [MUTE_BUTTON.x + MUTE_BUTTON.width - 1, MUTE_BUTTON.y + MUTE_BUTTON.height - 1],
      [MUTE_BUTTON.x + MUTE_BUTTON.width / 2, MUTE_BUTTON.y + MUTE_BUTTON.height / 2],
    ]
    for (const [x, y] of corners) {
      canvas.emit('pointerdown', pointerAt(x, y))
      expect(input.sample()).toEqual({ holding: false, confirmPressed: false })
    }
    expect(events.onMuteToggle).toHaveBeenCalledTimes(3)
  })

  it('a tap just outside the hit area flies', () => {
    canvas.emit('pointerdown', pointerAt(MUTE_BUTTON.x - 2, MUTE_BUTTON.y + 10))
    expect(input.sample().confirmPressed).toBe(true)
  })
})

describe('focus and resume', () => {
  it('losing focus pauses and drops every held input', () => {
    window.emit('keydown', { code: 'Space' })
    canvas.emit('pointerdown', pointerAt(200, 500))
    window.emit('blur')

    expect(events.onPause).toHaveBeenCalledTimes(1)
    // The keyup for a key released in another window never arrives here.
    expect(input.sample()).toEqual({ holding: false, confirmPressed: false })
  })

  it('swallowHold: the press that resumes does not also climb', () => {
    window.emit('keydown', { code: 'Space' })
    expect(input.sample().confirmPressed).toBe(true)

    // The shell spends this press on resuming.
    input.swallowHold()
    expect(input.sample()).toEqual({ holding: false, confirmPressed: false })

    // Still swallowed while the same key stays down...
    expect(input.sample().holding).toBe(false)

    // ...and climbing again on the next fresh press.
    window.emit('keyup', { code: 'Space' })
    window.emit('keydown', { code: 'Space' })
    expect(input.sample()).toEqual({ holding: true, confirmPressed: true })
  })

  it('swallowHold with nothing held does not swallow the next press', () => {
    input.swallowHold()
    window.emit('keydown', { code: 'Space' })
    expect(input.sample().holding).toBe(true)
  })
})

describe('gestures and teardown', () => {
  it('reports the first user gesture exactly once (WebAudio unlock)', () => {
    window.emit('keydown', { code: 'Space' })
    window.emit('keyup', { code: 'Space' })
    canvas.emit('pointerdown', pointerAt(200, 500))
    expect(events.onGesture).toHaveBeenCalledTimes(1)
  })

  it('dispose removes every listener', () => {
    expect(window.count() + canvas.count()).toBeGreaterThan(0)
    input.dispose()
    expect(window.count() + canvas.count()).toBe(0)
  })
})
