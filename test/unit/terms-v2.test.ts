/**
 * Unit tests for terms v2 (ADR 0005): the salted terms commit to ADDRESSES, not
 * a free-text org name, and the display amount is DERIVED from the on-chain raw
 * caveat value — so the salt is reconstructible from public data alone. These
 * tests prove the reconstructibility property at the buildTerms boundary:
 * identical public inputs always yield the identical salt, regardless of how the
 * user typed the amount or what a hostile token reports.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { parseUnits, type Address } from 'viem'
import { buildTerms, hashTerms } from '../../src/lib/subscriptionTerms'
import { buildStreamTerms, hashStreamTerms } from '../../src/lib/streamTerms'

const SAFE = '0x00000000000000000000000000000000000000Aa' as Address
const RECIPIENT = '0x00000000000000000000000000000000000000Bb' as Address
const TOKEN = '0x00000000000000000000000000000000000000Cc' as Address
const START = 1_800_000_000

function subTerms(over: Partial<Parameters<typeof buildTerms>[0]> = {}) {
  return buildTerms({
    organization: { recipient: RECIPIENT, delegate: RECIPIENT },
    subscriber: { label: 'Safe', account: SAFE },
    token: { address: TOKEN, symbol: 'USDC', decimals: 6 },
    amountPerPeriodRaw: parseUnits('100', 6).toString(),
    periodSeconds: 2_592_000,
    startDate: START,
    endDate: null,
    ...over,
  })
}

describe('terms v2 — no org name in the salt', () => {
  test('organization carries addresses only', () => {
    const terms = subTerms()
    expect(terms.organization).toEqual({ recipient: RECIPIENT, delegate: RECIPIENT })
    expect('name' in terms.organization).toBe(false)
  })
})

describe('terms v2 — amount derived from the on-chain raw', () => {
  test('amountPerPeriod is formatUnits(raw, decimals)', () => {
    expect(subTerms({ amountPerPeriodRaw: '1000000' }).amountPerPeriod).toBe('1')
    expect(subTerms({ amountPerPeriodRaw: '2500000' }).amountPerPeriod).toBe('2.5')
  })

  test('the raw is preserved verbatim', () => {
    expect(subTerms({ amountPerPeriodRaw: '1000000' }).amountPerPeriodRaw).toBe('1000000')
  })
})

describe('terms v2 — reconstructibility (the core property)', () => {
  test('identical public inputs yield the identical salt', () => {
    expect(hashTerms(subTerms())).toBe(hashTerms(subTerms()))
  })

  test("user amount formatting does not affect the salt (keyed off the raw)", () => {
    // "100", "100.0", "0100.00" all parse to the same on-chain raw, so a
    // reconstructor reading only the raw reproduces the same salt.
    const a = parseUnits('100', 6).toString()
    const b = parseUnits('100.0', 6).toString()
    const c = parseUnits('0100.00', 6).toString()
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(hashTerms(subTerms({ amountPerPeriodRaw: a }))).toBe(hashTerms(subTerms({ amountPerPeriodRaw: c })))
  })

  test('endDate null vs set changes the salt but stays deterministic', () => {
    const withEnd = hashTerms(subTerms({ endDate: START + 999 }))
    expect(withEnd).not.toBe(hashTerms(subTerms({ endDate: null })))
    expect(withEnd).toBe(hashTerms(subTerms({ endDate: START + 999 })))
  })
})

describe('terms v2 — hostile token is sanitized deterministically', () => {
  test('a malicious symbol is stripped/capped in the terms, salt still computes', () => {
    const terms = subTerms({ token: { address: TOKEN, symbol: '<img onerror=x>USDC', decimals: 6 } })
    expect(terms.token.symbol).not.toContain('<')
    expect(terms.token.symbol.length).toBeLessThanOrEqual(32)
    expect(typeof hashTerms(terms)).toBe('string')
  })

  test('same hostile token + same raw → same salt on both sides', () => {
    const hostile = { address: TOKEN, symbol: '<script>💥USDC', decimals: 199 }
    const a = subTerms({ token: hostile })
    const b = subTerms({ token: hostile })
    expect(hashTerms(a)).toBe(hashTerms(b))
  })
})

describe('stream terms v2 — no org name, token sanitized', () => {
  test('organization carries addresses only', () => {
    const terms = buildStreamTerms({
      organization: { recipient: RECIPIENT, delegate: RECIPIENT },
      subscriber: { label: 'Payer', account: SAFE },
      token: { address: TOKEN, symbol: 'USDC', decimals: 6 },
      ratePerPeriod: '1000',
      ratePeriodSeconds: 2_592_000,
      amountPerSecondRaw: '1',
      initialAmountRaw: '0',
      maxAmountRaw: (2n ** 256n - 1n).toString(),
      startTime: START,
    })
    expect(terms.organization).toEqual({ recipient: RECIPIENT, delegate: RECIPIENT })
    expect('name' in terms.organization).toBe(false)
    expect(typeof hashStreamTerms(terms)).toBe('string')
  })
})
