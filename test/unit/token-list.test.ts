/**
 * Unit tests for the Uniswap token-list service. The list is hostile-ish public
 * input (a large JSON), so parsing must drop malformed entries, checksum
 * addresses, filter by chain, and memoize — while treating an uncovered chain as
 * an empty result, never an error (testnets are barely covered).
 *
 * Run: bun test test/unit
 */
import { describe, test, expect, afterEach, spyOn, mock } from 'bun:test'
import {
  getWhitelistedTokens,
  loadWhitelistedTokens,
  resetTokenListCache,
} from '../../src/lib/token-list'

const USDC_LOWER = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDC_CHECKSUM = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

function listResponse(tokens: unknown[]): Response {
  return new Response(JSON.stringify({ name: 'Test', tokens }), { status: 200 })
}

function mockFetch(response: Response | (() => Response | Promise<Response>)) {
  return spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(typeof response === 'function' ? response() : response),
  )
}

afterEach(() => {
  resetTokenListCache()
  mock.restore()
})

describe('getWhitelistedTokens', () => {
  test('parses valid tokens and checksums the address', async () => {
    mockFetch(listResponse([
      { chainId: 1, address: USDC_LOWER, name: 'USD Coin', symbol: 'USDC', decimals: 6 },
    ]))
    const [token] = await getWhitelistedTokens(1)
    expect(token.address).toBe(USDC_CHECKSUM)
    expect(token.symbol).toBe('USDC')
    expect(token.decimals).toBe(6)
  })

  test('filters by chainId', async () => {
    mockFetch(listResponse([
      { chainId: 1, address: USDC_LOWER, name: 'USD Coin', symbol: 'USDC', decimals: 6 },
      { chainId: 8453, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', symbol: 'USDC', decimals: 6 },
    ]))
    expect(await getWhitelistedTokens(1)).toHaveLength(1)
    expect((await getWhitelistedTokens(8453))[0].chainId).toBe(8453)
  })

  test('returns empty (not an error) for an uncovered chain', async () => {
    mockFetch(listResponse([
      { chainId: 1, address: USDC_LOWER, name: 'USD Coin', symbol: 'USDC', decimals: 6 },
    ]))
    expect(await getWhitelistedTokens(84532)).toEqual([])
  })

  test('drops malformed entries (bad address, missing symbol, non-integer decimals)', async () => {
    mockFetch(listResponse([
      { chainId: 1, address: 'not-an-address', name: 'X', symbol: 'X', decimals: 18 },
      { chainId: 1, address: USDC_LOWER, name: 'Y', symbol: '', decimals: 6 },
      { chainId: 1, address: USDC_LOWER, name: 'Z', symbol: 'Z', decimals: 1.5 },
      { chainId: 1, address: USDC_LOWER, name: 'Good', symbol: 'GOOD', decimals: 6 },
    ]))
    const tokens = await getWhitelistedTokens(1)
    expect(tokens).toHaveLength(1)
    expect(tokens[0].symbol).toBe('GOOD')
  })
})

describe('loadWhitelistedTokens caching', () => {
  test('fetches once and memoizes across calls', async () => {
    const fetchSpy = mockFetch(listResponse([
      { chainId: 1, address: USDC_LOWER, name: 'USD Coin', symbol: 'USDC', decimals: 6 },
    ]))
    await loadWhitelistedTokens()
    await loadWhitelistedTokens()
    await getWhitelistedTokens(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  test('a failed fetch does not poison the cache — the next call retries', async () => {
    let calls = 0
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() => {
      calls += 1
      return calls === 1
        ? Promise.resolve(new Response('nope', { status: 500 }))
        : Promise.resolve(listResponse([
            { chainId: 1, address: USDC_LOWER, name: 'USD Coin', symbol: 'USDC', decimals: 6 },
          ]))
    })
    await expect(loadWhitelistedTokens()).rejects.toThrow(/HTTP 500/)
    const tokens = await loadWhitelistedTokens()
    expect(tokens).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test('throws on a malformed response (no tokens array)', async () => {
    mockFetch(new Response(JSON.stringify({ name: 'broken' }), { status: 200 }))
    await expect(loadWhitelistedTokens()).rejects.toThrow(/malformed/)
  })
})
