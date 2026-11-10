import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/**
 * Passwords are kept as scrypt hashes: `scrypt$<log2 N>$<r>$<p>$<salt>$<hash>`
 * (base64). The cost is in the text, so it can rise later without breaking
 * hashes made today.
 */

const LOG_N = 15
const R = 8
const P = 1
const KEY_BYTES = 32

function derive(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  const options: ScryptOptions = { N: 2 ** logN, r, p, maxmem: 256 * 2 ** logN * r }
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, KEY_BYTES, options, (error, key) => error ? reject(error) : resolve(key))
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, LOG_N, R, P)
  return `scrypt$${LOG_N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

const STORED = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/u

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = STORED.exec(stored)
  if (!match) return false
  const [, logN, r, p, salt, hash] = match
  const expected = Buffer.from(hash ?? '', 'base64')
  const key = await derive(password, Buffer.from(salt ?? '', 'base64'), Number(logN), Number(r), Number(p))
  return expected.length === key.length && timingSafeEqual(expected, key)
}

/**
 * A hash nobody's password matches, checked when the login is unknown so a
 * wrong login takes as long as a wrong password.
 */
let decoy: Promise<string> | undefined
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(24).toString('base64'))
  return decoy
}
