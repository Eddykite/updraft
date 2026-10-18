/* eslint-disable @typescript-eslint/no-unused-vars -- contract stub; remove when implemented */
/**
 * Three WebAudio oscillator blips: gate pass, thermal collect, crash (spec §2).
 *
 * No audio files — synthesised tones only, which is part of holding the 60 KB
 * budget. The context is unlocked on the first user gesture (the tap that starts
 * the run), which is also what mobile browsers require. Mute is persisted via
 * io/storage.ts.
 *
 * Driven by draining `state.events`; the simulation itself never makes a sound.
 */

import type { GameEvent } from '../game/state.js'

export interface Audio {
  /** Must be called from a user-gesture handler. */
  unlock(): void
  /** Play whatever this batch of simulation events calls for. */
  play(events: readonly GameEvent[]): void
  setMuted(muted: boolean): void
  isMuted(): boolean
  dispose(): void
}

export function createAudio(initialMuted: boolean): Audio {
  throw new Error('not implemented')
}
