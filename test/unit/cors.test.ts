/**
 * Origin allow-listing for the publisher backend — proves PR preview subdomains
 * are accepted by the default policy while unrelated origins are rejected.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { isOriginAllowed, parseAllowedOrigins } from '../../server/cors'

describe('parseAllowedOrigins', () => {
  test('defaults cover apex, preview wildcard, and local dev', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([
      'https://hourglass.box',
      'https://*.hourglass.box',
      'http://localhost:5173',
    ])
  })

  test('splits and trims a custom list', () => {
    expect(parseAllowedOrigins('https://a.com, https://b.com ')).toEqual(['https://a.com', 'https://b.com'])
  })
})

describe('isOriginAllowed', () => {
  const def = parseAllowedOrigins(undefined)

  test('accepts the apex and every preview subdomain', () => {
    expect(isOriginAllowed('https://hourglass.box', def)).toBe(true)
    expect(isOriginAllowed('https://21.hourglass.box', def)).toBe(true)
    expect(isOriginAllowed('https://feat-x.hourglass.box', def)).toBe(true)
    expect(isOriginAllowed('http://localhost:5173', def)).toBe(true)
  })

  test('rejects look-alike and unrelated origins', () => {
    expect(isOriginAllowed('https://hourglass.box.evil.com', def)).toBe(false)
    expect(isOriginAllowed('https://evil.com', def)).toBe(false)
    // wildcard must not match the bare suffix as its own host
    expect(isOriginAllowed('https://.hourglass.box', def)).toBe(false)
    // scheme must match
    expect(isOriginAllowed('http://21.hourglass.box', def)).toBe(false)
  })

  test('"*" allows anything', () => {
    expect(isOriginAllowed('https://anything.example', ['*'])).toBe(true)
  })
})
