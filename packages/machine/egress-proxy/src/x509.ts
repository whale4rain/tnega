import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { isIP } from 'node:net'

/**
 * Just enough X.509 to run a private CA for the egress proxy: an ECDSA P-256
 * root, and short-lived leaf certificates for the hosts the proxy adds keys
 * to. Written against RFC 5280 with node:crypto, so the proxy needs no
 * certificate library.
 */

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size])
  const bytes: number[] = []
  for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content])
}

const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items))
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items))
const octets = (content: Buffer): Buffer => tlv(0x04, content)
const bits = (content: Buffer, unused = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unused]), content]))
const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'))
const explicit = (tag: number, content: Buffer): Buffer => tlv(0xa0 | tag, content)
const TRUE = Buffer.from([0x01, 0x01, 0xff])

function integer(value: Buffer): Buffer {
  let bytes = value
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] ?? 0) < 0x80) bytes = bytes.subarray(1)
  if ((bytes[0] ?? 0) >= 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes])
  return tlv(0x02, bytes)
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number)
  const out = [40 * (parts[0] ?? 0) + (parts[1] ?? 0)]
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f]
    for (let rest = part >> 7; rest > 0; rest >>= 7) chunk.unshift(0x80 | (rest & 0x7f))
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}

function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/gu, '').slice(0, 14)
  // UTCTime up to 2049, GeneralizedTime after (RFC 5280 4.1.2.5).
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`))
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'))

function name(commonName: string): Buffer {
  return seq(set(seq(oid('2.5.4.3'), utf8(commonName))))
}

function extension(id: string, value: Buffer, critical = false): Buffer {
  return seq(oid(id), ...(critical ? [TRUE] : []), octets(value))
}

function keyId(publicKey: KeyObject): Buffer {
  return createHash('sha1').update(publicKey.export({ type: 'spki', format: 'der' })).digest()
}

function serial(): Buffer {
  const bytes = randomBytes(16)
  bytes[0] = ((bytes[0] ?? 0) & 0x7f) | 0x01
  return bytes
}

function pem(label: string, der: Buffer): string {
  const body = der.toString('base64').match(/.{1,64}/gu)?.join('\n') ?? ''
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

interface Issue {
  subject: string
  publicKey: KeyObject
  issuer: string
  issuerKey: KeyObject
  notBefore: Date
  notAfter: Date
  extensions: Buffer[]
}

function certificate(issue: Issue): string {
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial()),
    ECDSA_SHA256,
    name(issue.issuer),
    seq(time(issue.notBefore), time(issue.notAfter)),
    name(issue.subject),
    issue.publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...issue.extensions)),
  )
  const signature = sign('sha256', tbs, issue.issuerKey)
  return pem('CERTIFICATE', seq(tbs, ECDSA_SHA256, bits(signature)))
}

export interface KeyPairPem {
  certificatePem: string
  keyPem: string
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** A new root for this proxy. Keep its key with the proxy; give boxes only the certificate. */
export function createRootCertificate(commonName = 'tnega egress proxy', validDays = 3650): KeyPairPem {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const id = keyId(publicKey)
  const now = Date.now()
  const certificatePem = certificate({
    subject: commonName,
    issuer: commonName,
    publicKey,
    issuerKey: privateKey,
    notBefore: new Date(now - HOUR),
    notAfter: new Date(now + validDays * DAY),
    extensions: [
      extension('2.5.29.19', seq(TRUE), true), // basicConstraints: CA
      extension('2.5.29.15', bits(Buffer.from([0x06]), 1), true), // keyUsage: keyCertSign, cRLSign
      extension('2.5.29.14', octets(id)), // subjectKeyIdentifier
    ],
  })
  return { certificatePem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}

/** A short-lived certificate for one host, signed by the root. */
export function issueHostCertificate(root: KeyPairPem, host: string, validDays = 7): KeyPairPem {
  const rootKey = createPrivateKey(root.keyPem)
  const rootName = commonNameOf(root.certificatePem)
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const ip = isIP(host)
  const altName = ip === 4
    ? tlv(0x87, Buffer.from(host.split('.').map(Number)))
    : ip === 6 ? tlv(0x87, ipv6Bytes(host)) : tlv(0x82, Buffer.from(host, 'ascii'))
  const now = Date.now()
  const certificatePem = certificate({
    subject: host,
    issuer: rootName,
    publicKey,
    issuerKey: rootKey,
    notBefore: new Date(now - HOUR),
    notAfter: new Date(now + validDays * DAY),
    extensions: [
      extension('2.5.29.19', seq(), true), // basicConstraints: not a CA
      extension('2.5.29.15', bits(Buffer.from([0x80]), 7), true), // keyUsage: digitalSignature
      extension('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
      extension('2.5.29.17', seq(altName)), // subjectAltName
      extension('2.5.29.35', seq(tlv(0x80, keyId(createPublicKey(rootKey))))), // authorityKeyIdentifier
    ],
  })
  return { certificatePem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}

function ipv6Bytes(address: string): Buffer {
  const [head = '', tail = ''] = address.split('::')
  const left = head ? head.split(':') : []
  const right = address.includes('::') && tail ? tail.split(':') : []
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  const out = Buffer.alloc(16)
  groups.forEach((group, index) => out.writeUInt16BE(parseInt(group || '0', 16), index * 2))
  return out
}

function commonNameOf(certificatePem: string): string {
  // The root's subject is the issuer of every leaf; read it back from the DER.
  const der = Buffer.from(certificatePem.replace(/-----[^-]+-----/gu, '').replace(/\s+/gu, ''), 'base64')
  const marker = oid('2.5.4.3')
  const at = der.indexOf(marker)
  if (at < 0) throw new Error('root certificate has no common name')
  const valueAt = at + marker.length
  const size = der[valueAt + 1] ?? 0
  return der.subarray(valueAt + 2, valueAt + 2 + size).toString('utf8')
}
