/**
 * Unit tests for the Safe balance reader. It cross-references the whitelist with
 * on-chain balances via one multicall; a failed per-token read must fail-soft to
 * zero (dropped), and only non-zero holdings are returned, in input order.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import type { Address, PublicClient } from 'viem'
import { readHeldTokens, readTokenBalance } from '../../src/lib/safe-balances'
import type { WhitelistedToken } from '../../src/lib/token-list'

const ACCOUNT = '0x0000000000000000000000000000000000000009' as Address

function token(symbol: string, address: string): WhitelistedToken {
  return { chainId: 1, address: address as Address, name: symbol, symbol, decimals: 6 }
}

const A = token('AAA', '0x0000000000000000000000000000000000000001')
const B = token('BBB', '0x0000000000000000000000000000000000000002')
const C = token('CCC', '0x0000000000000000000000000000000000000003')

type MulticallResult = { status: 'success'; result: bigint } | { status: 'failure'; error: Error }

function clientWith(results: MulticallResult[]): PublicClient {
  // Only multicall is exercised by readHeldTokens; cast the stub to PublicClient.
  return { multicall: async () => results } as unknown as PublicClient
}

describe('readHeldTokens', () => {
  test('returns only non-zero holdings, in input order', async () => {
    const client = clientWith([
      { status: 'success', result: 100n },
      { status: 'success', result: 0n },
      { status: 'success', result: 5n },
    ])
    const held = await readHeldTokens(client, ACCOUNT, [A, B, C])
    expect(held.map((t) => t.symbol)).toEqual(['AAA', 'CCC'])
    expect(held[0].balance).toBe(100n)
    expect(held[1].balance).toBe(5n)
  })

  test('fail-soft: a failed read is dropped, not thrown', async () => {
    const client = clientWith([
      { status: 'failure', error: new Error('revert') },
      { status: 'success', result: 42n },
    ])
    const held = await readHeldTokens(client, ACCOUNT, [A, B])
    expect(held.map((t) => t.symbol)).toEqual(['BBB'])
  })

  test('empty token list short-circuits without a call', async () => {
    let called = false
    const client = { multicall: async () => { called = true; return [] } } as unknown as PublicClient
    expect(await readHeldTokens(client, ACCOUNT, [])).toEqual([])
    expect(called).toBe(false)
  })
})

describe('readTokenBalance', () => {
  test('returns the balance on success', async () => {
    const client = { readContract: async () => 7n } as unknown as PublicClient
    expect(await readTokenBalance(client, ACCOUNT, A.address)).toBe(7n)
  })

  test('returns 0n when the read fails', async () => {
    const client = { readContract: async () => { throw new Error('no code') } } as unknown as PublicClient
    expect(await readTokenBalance(client, ACCOUNT, A.address)).toBe(0n)
  })
})
