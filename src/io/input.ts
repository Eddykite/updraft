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
 *
 * Everything here is "is something down right now", never "was it pressed for
 * long enough" — holding longer or shorter is the entire skill, and no part of
 * the control scheme asks for precise timing or fine motor control.
 */

import { FIELD_WIDTH } from '../game/constants.js'
import type { InputState } from '../game/state.js'
import { MUTE_BUTTON } from '../render/hud.js'

/** Side-channel for the things that are not altitude: pause, mute, audio unlock. */
export interface InputEvents {
  /** Esc, or the window losing focus. */
  onPause(): void
  /** M, or a tap inside the speaker's 44×44 hit area. */
  onMuteToggle(): void
  /** The first real user gesture — the only moment WebAudio can be unlocked. */
  onGesture(): void
}

export interface InputSource {
  /** Snapshot the current input for one simulation step and clear edge flags. */
  sample(): InputState
  /**
   * Drop the press that is currently down, without waiting for its release.
   *
   * The shell calls this when a press has been spent on something other than
   * flying — resuming from pause, or dismissing the game-over screen — so the
   * same finger does not also yank the kite upward. Holding resumes on the next
   * fresh press.
   */
  swallowHold(): void
  /** Keep the client-pixel -> logical-pixel mapping in step with the canvas. */
  setViewport(scale: number): void
  /** Detach every listener. */
  dispose(): void
}

const CLIMB_KEYS = new Set(['Space', 'ArrowUp', 'KeyW'])

export function createInputSource(target: HTMLCanvasElement, events: InputEvents): InputSource {
  const keysDown = new Set<string>()
  const pointersDown = new Set<number>()
  let confirmPressed = false
  let swallowed = false
  let gestureSeen = false
  /** Logical px per CSS px; kept current by setViewport. */
  let scale = 1
  const disposers: (() => void)[] = []

  function on<T extends EventTarget>(
    node: T,
    type: string,
    handler: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    node.addEventListener(type, handler, options)
    disposers.push(() => {
      node.removeEventListener(type, handler, options)
    })
  }

  function firstGesture(): void {
    if (gestureSeen) return
    gestureSeen = true
    events.onGesture()
  }

  /** A press only counts as "start/restart" and "climb" if it is not a UI tap. */
  function press(): void {
    confirmPressed = true
    // A *fresh* press always ends a swallow, even if the swallowed input is
    // still down. Without this, adding a second finger after resuming from a
    // pause would not climb until the first one was also lifted — see the
    // `swallowHold` contract above, which promises exactly this.
    swallowed = false
    firstGesture()
  }

  function releasedEverything(): boolean {
    return keysDown.size === 0 && pointersDown.size === 0
  }

  // --- keyboard -------------------------------------------------------------

  on(globalThis.window, 'keydown', (event) => {
    const keyboard = event as KeyboardEvent
    if (keyboard.repeat) return

    if (CLIMB_KEYS.has(keyboard.code)) {
      // Space scrolls the page and ↑ scrolls the document; neither is wanted.
      keyboard.preventDefault()
      keysDown.add(keyboard.code)
      press()
      return
    }

    if (keyboard.code === 'Escape') {
      keysDown.clear()
      // Drop any press that has not been sampled yet: pausing must not leave an
      // unconsumed confirm edge that immediately resumes on the next step.
      confirmPressed = false
      events.onPause()
      return
    }

    if (keyboard.code === 'KeyM') {
      firstGesture()
      events.onMuteToggle()
    }
  })

  on(globalThis.window, 'keyup', (event) => {
    const keyboard = event as KeyboardEvent
    keysDown.delete(keyboard.code)
    if (releasedEverything()) swallowed = false
  })

  // --- pointer (mouse, pen and touch all arrive here) -----------------------

  function logicalPoint(event: PointerEvent): { x: number; y: number } {
    const rect = target.getBoundingClientRect()
    return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale }
  }

  function insideMuteButton(event: PointerEvent): boolean {
    const point = logicalPoint(event)
    return (
      point.x >= MUTE_BUTTON.x &&
      point.x <= MUTE_BUTTON.x + MUTE_BUTTON.width &&
      point.y >= MUTE_BUTTON.y &&
      point.y <= MUTE_BUTTON.y + MUTE_BUTTON.height
    )
  }

  on(target, 'pointerdown', (event) => {
    const pointer = event as PointerEvent
    // Right and middle mouse buttons are not a control surface; touch reports 0.
    if (pointer.pointerType === 'mouse' && pointer.button !== 0) return
    pointer.preventDefault()

    if (insideMuteButton(pointer)) {
      firstGesture()
      events.onMuteToggle()
      return
    }

    pointersDown.add(pointer.pointerId)
    press()
  })

  function liftPointer(event: Event): void {
    const pointer = event as PointerEvent
    pointersDown.delete(pointer.pointerId)
    if (releasedEverything()) swallowed = false
  }

  // pointerup is listened for on the window: a drag that starts on the canvas and
  // ends outside it must still count as a release, or the kite climbs forever.
  on(globalThis.window, 'pointerup', liftPointer)
  on(globalThis.window, 'pointercancel', liftPointer)

  // Long-press on mobile and right-click on desktop both open menus mid-flight.
  on(target, 'contextmenu', (event) => {
    event.preventDefault()
  })

  // --- focus ----------------------------------------------------------------

  // Losing focus pauses. It also drops every held key: the keyup for a key
  // released while another window has focus never arrives here.
  on(globalThis.window, 'blur', () => {
    keysDown.clear()
    pointersDown.clear()
    swallowed = false
    // As with Esc: an unsampled press must not survive the pause and resume it.
    confirmPressed = false
    events.onPause()
  })

  return {
    sample(): InputState {
      const holding = !swallowed && !releasedEverything()
      const state: InputState = { holding, confirmPressed }
      confirmPressed = false
      return state
    },

    swallowHold(): void {
      if (!releasedEverything()) swallowed = true
      confirmPressed = false
    },

    setViewport(nextScale: number): void {
      scale = nextScale > 0 ? nextScale : 1
    },

    dispose(): void {
      for (const off of disposers) off()
      disposers.length = 0
      keysDown.clear()
      pointersDown.clear()
    },
  }
}

/** CSS px -> logical px for a canvas of this CSS width. Exported for main.ts. */
export function logicalScaleFor(cssWidth: number): number {
  return cssWidth > 0 ? FIELD_WIDTH / cssWidth : 1
}
