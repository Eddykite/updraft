/* eslint-disable @typescript-eslint/no-unused-vars -- contract stub; remove when implemented */
/**
 * Best score in localStorage: one versioned key, validated and clamped (spec §2, §7).
 *
 * **localStorage is untrusted input** — the user can edit it. Corrupt JSON, a
 * missing key, NaN, negative, absurdly large, wrong-type and old-version values
 * must all fall back to 0 rather than throwing or displaying garbage. That is a
 * tested requirement (spec §3), not a nicety.
 *
 * The key is STORAGE_KEY in game/constants.ts. Mute state is persisted here too.
 */

/** Read the best score, or 0 for anything unexpected. Never throws. */
export function readBest(): number {
  throw new Error('not implemented')
}

/** Persist a new best score. Never throws (private mode / quota are normal). */
export function writeBest(score: number): void {
  throw new Error('not implemented')
}

/** Read the persisted mute flag; false for anything unexpected. Never throws. */
export function readMuted(): boolean {
  throw new Error('not implemented')
}

/** Persist the mute flag. Never throws. */
export function writeMuted(muted: boolean): void {
  throw new Error('not implemented')
}
