import { erc20Abi, zeroAddress, type Address, type PublicClient } from 'viem'
import { UniswapV3FactoryABI, UniswapV3PoolABI } from '../config/abis'
import { UNISWAP_V3_FACTORY, FEE_TIERS, CANDIDATE_TOKENS, type CandidateToken } from '../config/uniswap'

export interface PoolInfo {
  poolAddress: Address
  token0: CandidateToken
  token1: CandidateToken
  fee: number
  sqrtPriceX96: bigint
  liquidity: bigint
  /** Raw balance of token0 held by the pool — a TVL proxy, not a USD figure. */
  tvlToken0: bigint
  /** Raw balance of token1 held by the pool — a TVL proxy, not a USD figure. */
  tvlToken1: bigint
  /** Annualized fee yield estimate from the subgraph, or null if unavailable. */
  apy: number | null
}

/**
 * Scans every candidate-token pair × fee tier for a real, already-deployed
 * Uniswap v3 pool, and reads its current on-chain state. Skips pairs the
 * factory has no pool for (a very likely outcome on testnet) rather than
 * erroring — an empty result is a valid outcome the caller must handle.
 */
export async function discoverPools(client: PublicClient, chainId: number): Promise<PoolInfo[]> {
  const factory = UNISWAP_V3_FACTORY[chainId]
  const tokens = CANDIDATE_TOKENS[chainId]
  if (!factory || !tokens || tokens.length < 2) return []

  const pairs: [CandidateToken, CandidateToken][] = []
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) pairs.push([tokens[i], tokens[j]])
  }

  const found: PoolInfo[] = []
  for (const [a, b] of pairs) {
    for (const fee of FEE_TIERS) {
      const poolAddress = await client.readContract({
        address: factory,
        abi: UniswapV3FactoryABI,
        functionName: 'getPool',
        args: [a.address, b.address, fee],
      })
      if (poolAddress === zeroAddress) continue

      const [slot0, liquidity, token0Address] = await Promise.all([
        client.readContract({ address: poolAddress, abi: UniswapV3PoolABI, functionName: 'slot0' }),
        client.readContract({ address: poolAddress, abi: UniswapV3PoolABI, functionName: 'liquidity' }),
        client.readContract({ address: poolAddress, abi: UniswapV3PoolABI, functionName: 'token0' }),
      ])
      // Pools order tokens by address, not by discovery order — resolve which
      // candidate is which side so callers get the right decimals/symbol.
      const token0 = token0Address.toLowerCase() === a.address.toLowerCase() ? a : b
      const token1 = token0 === a ? b : a

      const [tvlToken0, tvlToken1] = await Promise.all([
        client.readContract({ address: token0.address, abi: erc20Abi, functionName: 'balanceOf', args: [poolAddress] }),
        client.readContract({ address: token1.address, abi: erc20Abi, functionName: 'balanceOf', args: [poolAddress] }),
      ])

      found.push({
        poolAddress,
        token0,
        token1,
        fee,
        sqrtPriceX96: slot0[0],
        liquidity,
        tvlToken0,
        tvlToken1,
        apy: null,
      })
    }
  }
  return found
}

interface PoolDayData {
  feesUSD: string
  tvlUSD: string
}

/**
 * Best-effort 24h-fees / TVL annualized estimate from the official Uniswap
 * subgraph. Base Sepolia has thin real trading, so an empty/missing result is
 * the expected common case — this returns null rather than a fabricated
 * number whenever the endpoint isn't configured, unreachable, or has no rows.
 */
export async function fetchPoolApy(poolAddress: Address): Promise<number | null> {
  const url = import.meta.env.VITE_UNISWAP_SUBGRAPH_URL
  if (!url) return null

  const apiKey = import.meta.env.VITE_THEGRAPH_API_KEY
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        query: `{ pool(id: "${poolAddress.toLowerCase()}") { poolDayData(first: 1, orderBy: date, orderDirection: desc) { feesUSD tvlUSD } } }`,
      }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: { pool?: { poolDayData?: PoolDayData[] } } }
    const day = json.data?.pool?.poolDayData?.[0]
    if (!day) return null
    const tvlUSD = Number(day.tvlUSD)
    const feesUSD = Number(day.feesUSD)
    if (!Number.isFinite(tvlUSD) || tvlUSD <= 0 || !Number.isFinite(feesUSD)) return null
    return (feesUSD / tvlUSD) * 365
  } catch {
    return null
  }
}

/**
 * Ranks pools for the recommendation: real APY first (best information wins),
 * falling back to liquidity as the safety/depth signal when no APY data
 * exists — which, on a testnet, is the common case.
 */
export function rankPools(pools: PoolInfo[]): PoolInfo[] {
  return [...pools]
    .filter((p) => p.liquidity > 0n)
    .sort((a, b) => {
      if (a.apy !== null && b.apy !== null) return b.apy - a.apy
      if (a.apy !== null) return -1
      if (b.apy !== null) return 1
      return b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0
    })
}
