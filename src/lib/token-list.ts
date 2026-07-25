import { getAddress, isAddress, type Address } from 'viem'

/**
 * Uniswap default token list — the allowlist of vetted tokens per chain.
 *
 * OurGlass uses it to keep the delegation token picker to tokens Uniswap has
 * validated, so a subscriber cannot accidentally delegate against a shitcoin
 * that happens to sit in the Safe. The list is a public JSON (the tokenlists.org
 * standard); it covers mainnet + Base well but barely covers testnets — callers
 * must handle an empty result for a chain (Sepolia / Base Sepolia) and fall back
 * to the custom-address path, never treat "empty" as an error.
 */

/** Uniswap Labs Default token list (tokenlists.org schema). No API key needed. */
export const UNISWAP_TOKEN_LIST_URL = 'https://tokens.uniswap.org'

/** A single vetted token, as consumed by the picker. */
export interface WhitelistedToken {
  chainId: number
  address: Address
  name: string
  symbol: string
  decimals: number
  logoURI?: string
}

/** Raw token entry as it appears in the fetched list (before validation). */
interface RawListToken {
  chainId?: unknown
  address?: unknown
  name?: unknown
  symbol?: unknown
  decimals?: unknown
  logoURI?: unknown
}

function toWhitelistedToken(raw: RawListToken): WhitelistedToken | null {
  if (typeof raw.chainId !== 'number' || !Number.isInteger(raw.chainId)) return null
  if (typeof raw.address !== 'string' || !isAddress(raw.address)) return null
  if (typeof raw.symbol !== 'string' || !raw.symbol) return null
  if (typeof raw.name !== 'string' || !raw.name) return null
  if (typeof raw.decimals !== 'number' || !Number.isInteger(raw.decimals)) return null
  return {
    chainId: raw.chainId,
    // Checksum so equality against on-chain / config addresses is canonical.
    address: getAddress(raw.address),
    name: raw.name,
    symbol: raw.symbol,
    decimals: raw.decimals,
    logoURI: typeof raw.logoURI === 'string' ? raw.logoURI : undefined,
  }
}

// The full list is ~630 KB and immutable per session; fetch once and reuse.
let listPromise: Promise<WhitelistedToken[]> | null = null

async function fetchTokenList(url: string): Promise<WhitelistedToken[]> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Token list fetch failed — HTTP ${res.status}`)
  const body: unknown = await res.json()
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { tokens?: unknown }).tokens)) {
    throw new Error('Token list fetch failed — malformed response (no tokens array)')
  }
  const tokens = (body as { tokens: RawListToken[] }).tokens
  return tokens.map(toWhitelistedToken).filter((t): t is WhitelistedToken => t !== null)
}

/** All whitelisted tokens (every chain), fetched once and memoized. */
export function loadWhitelistedTokens(url: string = UNISWAP_TOKEN_LIST_URL): Promise<WhitelistedToken[]> {
  // A failed fetch must not poison the cache — clear it so the next call retries.
  if (!listPromise) {
    listPromise = fetchTokenList(url).catch((err) => {
      listPromise = null
      throw err
    })
  }
  return listPromise
}

/** Whitelisted tokens for one chain. Empty (not an error) when the chain is uncovered. */
export async function getWhitelistedTokens(
  chainId: number,
  url: string = UNISWAP_TOKEN_LIST_URL,
): Promise<WhitelistedToken[]> {
  const all = await loadWhitelistedTokens(url)
  return all.filter((t) => t.chainId === chainId)
}

/** Test-only: drop the memoized list so a fresh fetch runs next call. */
export function resetTokenListCache(): void {
  listPromise = null
}
