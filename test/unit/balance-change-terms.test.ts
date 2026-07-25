/**
 * Decode of the erc20BalanceChange caveat terms — the strategy-rail caveat (DCA /
 * range). Layout is enforceDecrease(1) + token(20) + recipient(20) + amount(32) =
 * 73 bytes, verified against ERC20BalanceChangeEnforcer.getTermsInfo. Correctness
 * matters: it reconstructs the spend cap + token from a published mandate.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { encodePacked, getAddress } from 'viem'
import { decodeBalanceChangeTerms } from '../../src/lib/intuition/discover'

const TOKEN = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e')
const SAFE = getAddress('0x1111111111111111111111111111111111111111')

describe('decodeBalanceChangeTerms', () => {
  test('decodes a Decrease cap (enforceDecrease = true)', () => {
    const terms = encodePacked(
      ['uint8', 'address', 'address', 'uint256'],
      [1, TOKEN, SAFE, 55_000_000n], // 55 USDC @ 6dp
    )
    const t = decodeBalanceChangeTerms(terms)
    expect(t.enforceDecrease).toBe(true)
    expect(t.token).toBe(TOKEN)
    expect(t.recipient).toBe(SAFE)
    expect(t.amount).toBe(55_000_000n)
  })

  test('decodes an Increase floor (enforceDecrease = false)', () => {
    const terms = encodePacked(
      ['uint8', 'address', 'address', 'uint256'],
      [0, TOKEN, SAFE, 1_000n],
    )
    const t = decodeBalanceChangeTerms(terms)
    expect(t.enforceDecrease).toBe(false)
    expect(t.amount).toBe(1_000n)
  })

  test('terms are exactly 73 bytes', () => {
    const terms = encodePacked(
      ['uint8', 'address', 'address', 'uint256'],
      [1, TOKEN, SAFE, 1n],
    )
    expect((terms.length - 2) / 2).toBe(73)
  })
})
