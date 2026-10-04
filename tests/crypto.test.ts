import { describe, expect, it } from 'vitest'
import { deriveKey, fromB64, newSalt, open, randomKey, seal, toB64 } from '@/lib/crypto'

describe('encryption', () => {
  it('round-trips with a random key', async () => {
    const k = await randomKey()
    const s = await seal(k, { a: 1, b: 'two' })
    expect(s.ct).not.toContain('two')
    expect(await open(k, s)).toEqual({ a: 1, b: 'two' })
  })
  it('derives the same key from the same passphrase and salt', async () => {
    const salt = newSalt()
    const a = await deriveKey('correct horse battery', salt)
    const b = await deriveKey('correct horse battery', salt)
    expect(await open(b, await seal(a, 'x'))).toBe('x')
  })
  it('rejects the wrong passphrase', async () => {
    const salt = newSalt()
    const a = await deriveKey('right passphrase', salt)
    const b = await deriveKey('wrong passphrase', salt)
    await expect(open(b, await seal(a, 'x'))).rejects.toThrow()
  })
  it('base64 round-trips binary', () => {
    const bytes = new Uint8Array([0, 255, 1, 128, 64])
    expect(Array.from(fromB64(toB64(bytes)))).toEqual([0, 255, 1, 128, 64])
  })
})
