/**
 * Trading API client — the strategy agent's swap builder. The security-critical
 * invariant is that it forces CLASSIC routing and REJECTS anything else (a gasless
 * UniswapX order has no router tx to redeem under the mandate). Also covers the
 * legacy-approval null case. Network is mocked at the fetch boundary.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect, afterEach, spyOn, mock } from 'bun:test'
import { checkApproval, buildSwap } from '../../src/lib/trading-api'
import type { Address } from 'viem'

const KEY = 'test-key'
const SAFE = '0x1111111111111111111111111111111111111111' as Address
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const WETH = '0x4200000000000000000000000000000000000006' as Address
const ROUTER = '0x6fF5693b99212Da76ad316178A184AB56D299b43' as Address

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

/** Mock fetch: map a path fragment to its response. */
function mockFetch(byPath: Record<string, Response>) {
  return spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const u = String(url)
    const key = Object.keys(byPath).find((p) => u.includes(p))
    if (!key) return Promise.resolve(new Response('not mocked', { status: 500 }))
    return Promise.resolve(byPath[key])
  })
}

afterEach(() => mock.restore())

describe('checkApproval', () => {
  test('returns the legacy approval tx when one is needed', async () => {
    mockFetch({ '/check_approval': jsonResponse({ approval: { to: USDC, from: SAFE, data: '0xabc', value: '0', chainId: 8453 } }) })
    const approval = await checkApproval(KEY, { walletAddress: SAFE, token: USDC, amount: '55000000', chainId: 8453 })
    expect(approval?.to).toBe(USDC)
    expect(approval?.data).toBe('0xabc')
  })

  test('returns null when already approved', async () => {
    mockFetch({ '/check_approval': jsonResponse({ approval: null }) })
    expect(await checkApproval(KEY, { walletAddress: SAFE, token: USDC, amount: '1', chainId: 8453 })).toBeNull()
  })
})

describe('buildSwap', () => {
  test('builds the router swap under CLASSIC routing', async () => {
    mockFetch({
      '/quote': jsonResponse({ routing: 'CLASSIC', quote: { foo: 'bar' }, permitData: null }),
      '/swap': jsonResponse({ swap: { to: ROUTER, from: SAFE, data: '0xdeadbeef', value: '0', chainId: 8453 } }),
    })
    const swap = await buildSwap(KEY, { swapper: SAFE, tokenIn: USDC, tokenOut: WETH, amount: '55000000', chainId: 8453 })
    expect(swap.to).toBe(ROUTER)
    expect(swap.data).toBe('0xdeadbeef')
  })

  test('REJECTS a non-CLASSIC (UniswapX) route — cannot be redeemed', async () => {
    mockFetch({ '/quote': jsonResponse({ routing: 'DUTCH_V2', quote: {}, permitData: null }) })
    await expect(
      buildSwap(KEY, { swapper: SAFE, tokenIn: USDC, tokenOut: WETH, amount: '55000000', chainId: 8453 }),
    ).rejects.toThrow(/CLASSIC/)
  })

  test('throws on an HTTP error from the API', async () => {
    mockFetch({ '/quote': new Response('rate limited', { status: 429 }) })
    await expect(
      buildSwap(KEY, { swapper: SAFE, tokenIn: USDC, tokenOut: WETH, amount: '1', chainId: 8453 }),
    ).rejects.toThrow(/429/)
  })
})
