/**
 * Three WebAudio oscillator blips: gate pass, thermal collect, crash (spec §2).
 *
 * No audio files — synthesised tones only, which is part of holding the 60 KB
 * budget. The context is unlocked on the first user gesture (the tap that starts
 * the run), which is also what mobile browsers require. Mute is persisted by the
 * scene host through io/storage.ts.
 *
 * Driven by draining `state.events`; the simulation itself never makes a sound.
 *
 * Why these three and nothing else: a sound you hear several times a second for
 * a minute has to stay under the annoyance line. So every tone is short (≤ 0.4 s),
 * quiet (peak ≈ 0.05 of full scale), has no sharp attack transient, and the gate
 * blip is *pitched by the current multiplier* up a pentatonic scale — which turns
 * the most-repeated sound into something that rewards a streak instead of
 * nagging, and means the multiplier is audible without a fourth sound.
 */

import { MULTIPLIER_CAP } from '../game/constants.js'
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

/** Pentatonic steps, one per multiplier level (1× … 5×). */
const GATE_PITCHES = [392, 440, 523.25, 587.33, 659.25]

/** Peak gain per voice. Deliberately low: this plays once a second for minutes. */
const VOICE_GAIN = 0.05

type AudioContextConstructor = new () => AudioContext

function audioContextConstructor(): AudioContextConstructor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextConstructor
    webkitAudioContext?: AudioContextConstructor
  }
  return scope.AudioContext ?? scope.webkitAudioContext ?? null
}

export function createAudio(initialMuted: boolean): Audio {
  let muted = initialMuted
  let ctx: AudioContext | null = null
  let master: GainNode | null = null

  /**
   * Create the context lazily, inside a gesture. Creating one eagerly on load
   * gets it suspended on mobile and warned about in Chrome.
   */
  function ensureContext(): AudioContext | null {
    if (ctx) return ctx
    const Ctor = audioContextConstructor()
    if (!Ctor) return null
    try {
      ctx = new Ctor()
      // A compressor as a cheap limiter: overlapping blips never clip or spike.
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -12
      limiter.ratio.value = 12
      master = ctx.createGain()
      master.gain.value = 1
      master.connect(limiter)
      limiter.connect(ctx.destination)
      return ctx
    } catch {
      ctx = null
      master = null
      return null
    }
  }

  /** One voice: an oscillator through its own envelope. Self-cleaning. */
  function voice(
    type: OscillatorType,
    startHz: number,
    endHz: number,
    duration: number,
    gain: number,
    lowpassHz?: number,
  ): void {
    const context = ctx
    const out = master
    if (!context || !out) return
    try {
      const now = context.currentTime
      const osc = context.createOscillator()
      osc.type = type
      osc.frequency.setValueAtTime(startHz, now)
      if (endHz !== startHz) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(endHz, 1), now + duration)
      }

      const envelope = context.createGain()
      // A 6 ms attack rather than a step: no click, which is most of what makes
      // a repeated blip grating.
      envelope.gain.setValueAtTime(0.0001, now)
      envelope.gain.exponentialRampToValueAtTime(gain, now + 0.006)
      envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration)

      let tail: AudioNode = envelope
      if (lowpassHz !== undefined) {
        const filter = context.createBiquadFilter()
        filter.type = 'lowpass'
        filter.frequency.value = lowpassHz
        envelope.connect(filter)
        tail = filter
      }

      osc.connect(envelope)
      tail.connect(out)
      osc.start(now)
      osc.stop(now + duration + 0.02)
      osc.onended = () => {
        osc.disconnect()
        envelope.disconnect()
        if (tail !== envelope) tail.disconnect()
      }
    } catch {
      // A browser that refuses to make a sound is not a reason to drop a frame.
    }
  }

  /** points = SCORE_PER_* × multiplier, so the award carries the multiplier. */
  function multiplierFromPoints(points: number, perUnit: number): number {
    if (!Number.isFinite(points) || points <= 0) return 1
    return Math.min(Math.max(Math.round(points / perUnit), 1), MULTIPLIER_CAP)
  }

  function gatePass(multiplier: number): void {
    const pitch = GATE_PITCHES[multiplier - 1] ?? GATE_PITCHES[0]!
    voice('triangle', pitch, pitch, 0.085, VOICE_GAIN)
  }

  function thermalCollect(multiplier: number): void {
    const base = 660 + (multiplier - 1) * 40
    voice('sine', base, base * 1.5, 0.14, VOICE_GAIN)
  }

  function crash(): void {
    // Falling, filtered, and the only tone allowed to be longer than a blip.
    voice('sawtooth', 190, 58, 0.4, VOICE_GAIN * 1.6, 900)
  }

  return {
    unlock(): void {
      const context = ensureContext()
      if (!context) return
      if (context.state === 'suspended') void context.resume()
    },

    play(events: readonly GameEvent[]): void {
      if (muted || events.length === 0) return
      if (!ensureContext()) return
      for (const event of events) {
        switch (event.type) {
          case 'gate_passed':
            gatePass(multiplierFromPoints(event.points, 10))
            break
          case 'thermal_collected':
            thermalCollect(multiplierFromPoints(event.points, 5))
            break
          case 'crashed':
            crash()
            break
          default:
            // run_started, streak_reset and multiplier_up are shown, not heard:
            // the HUD pulse and the gate pitch already carry them.
            break
        }
      }
    },

    setMuted(next: boolean): void {
      muted = next
      if (master) master.gain.value = next ? 0 : 1
    },

    isMuted(): boolean {
      return muted
    },

    dispose(): void {
      const context = ctx
      ctx = null
      master = null
      if (context) void context.close().catch(() => undefined)
    },
  }
}
