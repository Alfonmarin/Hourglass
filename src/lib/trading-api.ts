import type { Address, Hex } from 'viem'

/**
 * Minimal Uniswap Trading API client for the strategy agent. It builds a swap the
 * agent redeems AS THE SAFE, so it must stay on the paths a functionCall +
 * erc20BalanceChange mandate allows:
 *   - CLASSIC routing only → swap.to is the Universal Router, swap.data is an
 *     `execute(bytes,bytes[],uint256)` call (a gasless UniswapX order can't be
 *     redeemed under the mandate — no on-chain tx to bound).
 *   - Legacy approval (approve directly to the router), never Permit2 — Permit2
 *     is not a whitelisted target and needs an EIP-712 signature the Safe can't give.
 *
 * The API key (x-api-key) is agent-side only; never ship it to the browser.
 */

const BASE_URL = 'https://trade-api.gateway.uniswap.org/v1'

export interface TradingApiTx {
  to: Address
  from: Address
  data: Hex
  value: string
  chainId: number
}

function headers(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'x-universal-router-version': '2.0',
  }
}

async function post<T>(path: string, apiKey: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`Trading API ${path} failed (${res.status}): ${await res.text()}`)
  return (await res.json()) as T
}

/**
 * The legacy approval tx the Safe must send before swapping, or null if already
 * approved. `walletAddress` must be the Safe (the swapper/token owner).
 */
export async function checkApproval(
  apiKey: string,
  params: { walletAddress: Address; token: Address; amount: string; chainId: number },
): Promise<TradingApiTx | null> {
  const body = await post<{ approval: TradingApiTx | null }>('/check_approval', apiKey, params)
  return body.approval ?? null
}

/** CLASSIC swap params — chain ids are strings per the Trading API. */
export interface SwapRequest {
  swapper: Address
  tokenIn: Address
  tokenOut: Address
  amount: string
  chainId: number
  slippageTolerance?: number
}

/**
 * Quote (CLASSIC) then build the swap tx. Returns the router `execute(...)` tx the
 * agent redeems under the mandate. Rejects a non-CLASSIC route (a UniswapX order
 * can't be bounded/redeemed the same way).
 */
export async function buildSwap(apiKey: string, req: SwapRequest): Promise<TradingApiTx> {
  const quote = await post<{ routing: string; quote: unknown; permitData: unknown }>('/quote', apiKey, {
    swapper: req.swapper,
    tokenIn: req.tokenIn,
    tokenOut: req.tokenOut,
    tokenInChainId: String(req.chainId),
    tokenOutChainId: String(req.chainId),
    amount: req.amount,
    type: 'EXACT_INPUT',
    slippageTolerance: req.slippageTolerance ?? 0.5,
    // routingPreference now accepts only BEST_PRICE | FASTEST (CLASSIC was deprecated
    // as an input). "CLASSIC" remains the response `routing` value we still require
    // below to reject a non-redeemable UniswapX order.
    routingPreference: 'BEST_PRICE',
  })
  if (quote.routing !== 'CLASSIC') {
    throw new Error(`expected CLASSIC routing, got "${quote.routing}" — cannot redeem a non-router swap`)
  }
  // Legacy path: no permitData / signature sent.
  const body = await post<{ swap: TradingApiTx }>('/swap', apiKey, { quote: quote.quote })
  return body.swap
}
