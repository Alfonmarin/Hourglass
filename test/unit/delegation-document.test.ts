/**
 * Unit tests for the delegation document description (ADR 0005): token
 * `symbol`/`amount` come from an attacker-deployable ERC-20, so `describeDelegation`
 * must sanitize them before they enter the pinned document (which any UI rendering
 * the Intuition graph will display).
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { describeDelegation, type DelegationDetails } from '../../src/lib/intuition/delegation-document'

const base: DelegationDetails = { kind: 'subscription', amount: '300', tokenSymbol: 'USDC', period: 'month' }

describe('describeDelegation — token metadata is sanitized', () => {
  test('a normal token is described verbatim', () => {
    expect(describeDelegation(base)).toContain('300 USDC / month')
  })

  test('an injection symbol is stripped of HTML-significant characters', () => {
    const out = describeDelegation({ ...base, tokenSymbol: '<img src=x onerror=alert(1)>USDC' })
    expect(out).not.toContain('<')
    expect(out).not.toContain('>')
    expect(out).toContain('img src=x onerror=alert(1)USDC'.slice(0, 32))
  })

  test('an oversized symbol is capped', () => {
    const out = describeDelegation({ ...base, tokenSymbol: 'A'.repeat(500_000) })
    // the symbol portion is bounded, so the whole sentence stays short
    expect(out.length).toBeLessThan(200)
  })

  test('an absurd amount string is bounded', () => {
    const huge = '0.' + '0'.repeat(400) + '1'
    const out = describeDelegation({ ...base, amount: huge })
    expect(out.length).toBeLessThan(200)
  })

  test('is deterministic — same input, same description', () => {
    const hostile = { ...base, tokenSymbol: '<b>💥USDC', amount: '100' }
    expect(describeDelegation(hostile)).toBe(describeDelegation(hostile))
  })
})
