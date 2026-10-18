import { afterEach, describe, expect, it } from 'vitest'
import { STORAGE_KEY } from '../src/game/constants.js'
import {
  EMPTY,
  MAX_BEST,
  parsePersisted,
  readBest,
  readMuted,
  sanitiseBest,
  serialise,
  writeBest,
  writeMuted,
} from '../src/io/storage.js'

/**
 * localStorage is untrusted input (spec §3, §7).
 *
 * The user can open devtools and put anything at all under our key, and the
 * failure mode we are buying off here is not "the score is wrong" — it is a
 * white screen because something threw during boot, or `NaN` rendered 72px high
 * across the top of the HUD. Every case below must fall back to 0 / false.
 */

class FakeStorage {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
  key(): string | null {
    return null
  }
  get length(): number {
    return this.map.size
  }
}

function install(storage: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('parsePersisted — hostile input', () => {
  const hostile: ReadonlyArray<readonly [string, string | null | undefined]> = [
    ['a missing key', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['corrupt JSON', '{"v":1,"best":'],
    ['not JSON at all', 'best score: lots'],
    ['a JSON string', '"1200"'],
    ['a JSON number', '4242'],
    ['a JSON array', '[{"v":1,"best":10}]'],
    ['null', 'null'],
    ['an old version', '{"v":0,"best":1200}'],
    ['a future version', '{"v":99,"best":1200}'],
    ['a missing version', '{"best":1200}'],
    ['a string version', '{"v":"1","best":1200}'],
    ['NaN (as the JSON literal null round-trip)', '{"v":1,"best":null}'],
    ['a wrong-type best', '{"v":1,"best":"9999"}'],
    ['an object best', '{"v":1,"best":{"valueOf":1}}'],
    ['a boolean best', '{"v":1,"best":true}'],
  ]

  for (const [label, raw] of hostile) {
    it(`falls back to zero for ${label}`, () => {
      expect(parsePersisted(raw)).toEqual(EMPTY)
    })
  }

  it('clamps a negative best to zero', () => {
    expect(parsePersisted('{"v":1,"best":-500}').best).toBe(0)
  })

  it('clamps an absurdly large best rather than rendering it', () => {
    expect(parsePersisted('{"v":1,"best":1e30}').best).toBe(MAX_BEST)
    expect(parsePersisted(`{"v":1,"best":${Number.MAX_SAFE_INTEGER}}`).best).toBe(MAX_BEST)
  })

  it('floors a fractional best', () => {
    expect(parsePersisted('{"v":1,"best":123.99}').best).toBe(123)
  })

  it('treats any non-true muted value as not muted', () => {
    expect(parsePersisted('{"v":1,"best":10,"muted":"yes"}').muted).toBe(false)
    expect(parsePersisted('{"v":1,"best":10,"muted":1}').muted).toBe(false)
    expect(parsePersisted('{"v":1,"best":10,"muted":true}').muted).toBe(true)
  })

  it('accepts a well-formed record', () => {
    expect(parsePersisted('{"v":1,"best":1234,"muted":false}')).toEqual({
      best: 1234,
      muted: false,
    })
  })

  it('round-trips through serialise', () => {
    expect(parsePersisted(serialise({ best: 980, muted: true }))).toEqual({
      best: 980,
      muted: true,
    })
  })
})

describe('sanitiseBest', () => {
  it('rejects every non-finite and non-numeric value', () => {
    for (const value of [NaN, Infinity, -Infinity, '12', null, undefined, {}, [], true]) {
      expect(sanitiseBest(value)).toBe(0)
    }
  })
})

describe('read/write against a real-ish Storage', () => {
  it('persists and reads back a best score and a mute flag under one key', () => {
    const storage = new FakeStorage()
    install(storage)

    expect(readBest()).toBe(0)
    expect(readMuted()).toBe(false)

    writeBest(1240)
    writeMuted(true)

    expect(readBest()).toBe(1240)
    expect(readMuted()).toBe(true)
    // One versioned key, not one key per field (spec §2).
    expect(storage.length).toBe(1)
    expect(storage.getItem(STORAGE_KEY)).toBe('{"v":1,"best":1240,"muted":true}')
  })

  it('writing one field does not clobber the other', () => {
    install(new FakeStorage())
    writeBest(300)
    writeMuted(true)
    writeBest(450)
    expect(readMuted()).toBe(true)
    expect(readBest()).toBe(450)
  })

  it('survives storage that throws on every access (private mode, quota)', () => {
    install({
      getItem(): string {
        throw new Error('SecurityError')
      },
      setItem(): void {
        throw new Error('QuotaExceededError')
      },
    })

    expect(() => writeBest(100)).not.toThrow()
    expect(() => writeMuted(true)).not.toThrow()
    expect(readBest()).toBe(0)
    expect(readMuted()).toBe(false)
  })

  it('survives localStorage being absent entirely', () => {
    expect(() => writeBest(100)).not.toThrow()
    expect(readBest()).toBe(0)
    expect(readMuted()).toBe(false)
  })

  it('clamps on the way in, so a forged value cannot be laundered by a write', () => {
    install(new FakeStorage())
    writeBest(Number.POSITIVE_INFINITY)
    expect(readBest()).toBe(0)
    writeBest(1e12)
    expect(readBest()).toBe(MAX_BEST)
  })
})
