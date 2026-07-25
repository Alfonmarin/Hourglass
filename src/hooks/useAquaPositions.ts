import { useQuery } from '@tanstack/react-query'
import { createPublicClient, erc20Abi, http, type Address, type PublicClient } from 'viem'
import { findChain, rpcUrl } from '../config/supported-chains'
import { AquaABI } from '../config/abis'
import { AQUA_ADDRESS } from '../config/aqua'
import { getAquaStrategiesFor, type StoredAquaStrategy } from '../lib/aqua/positions'

/** Aqua marks a docked strategy by writing 255 into its `tokensCount`. */
const DOCKED = 255

export interface AquaPositionToken {
  address: Address
  symbol: string
  decimals: number
  /** What was shipped, from the local record. */
  shipped: bigint
  /** Allowance this strategy added when shipped. Undefined on pre-headroom records. */
  approved?: bigint
  /** Aqua's virtual balance — grows and shrinks as takers swap. */
  virtual: bigint
}

/**
 * One token's total exposure across every active strategy.
 *
 * This is the unit that decides whether a position is really backed. A Safe
 * holds a single ERC-20 allowance to Aqua, shared by every strategy it has
 * shipped, so judging one strategy against that allowance in isolation reports
 * "covered" when the strategies collectively are not.
 */
export interface AquaTokenDemand {
  address: Address
  symbol: string
  decimals: number
  /** Summed virtual balance across active strategies. */
  required: bigint
  held: bigint
  allowance: bigint
  isCovered: boolean
}

export interface AquaPosition {
  strategy: StoredAquaStrategy
  tokens: AquaPositionToken[]
  isDocked: boolean
  /** Every leg's token covered, counting what the Safe's other strategies claim too. */
  isBacked: boolean
}

/**
 * Reconcile the locally recorded strategies against the chain.
 *
 * The distinction this exists to surface: `ship()` validates nothing. A Safe can
 * ship a strategy over tokens it does not hold and has not approved, and Aqua
 * will happily record the virtual balance. Showing that number alone would
 * overstate the position, so demand is aggregated per token and checked against
 * the Safe's real balance and its one shared allowance.
 */
export function useAquaPositions(
  safeAddress: Address | undefined,
  chainId: number | undefined,
): {
  positions: AquaPosition[]
  demand: AquaTokenDemand[]
  loading: boolean
  error: unknown
  refetch: () => void
} {
  const query = useQuery({
    queryKey: ['aqua-positions', safeAddress, chainId],
    enabled: Boolean(safeAddress && chainId && chainId in AQUA_ADDRESS),
    queryFn: async (): Promise<{ positions: AquaPosition[]; demand: AquaTokenDemand[] }> => {
      const strategies = getAquaStrategiesFor(safeAddress!, chainId!)
      if (strategies.length === 0) return { positions: [], demand: [] }
      const chain = findChain(chainId!)
      const aqua = AQUA_ADDRESS[chainId!]
      if (!chain || !aqua) return { positions: [], demand: [] }
      const client = createPublicClient({ chain, transport: http(rpcUrl(chainId!)) }) as PublicClient

      // Virtual balance per (strategy, token), straight from Aqua.
      const raws = await Promise.all(
        strategies.map((strategy) =>
          Promise.all(
            strategy.tokens.map(async (token) => {
              const [balance, tokensCount] = await client.readContract({
                address: aqua,
                abi: AquaABI,
                functionName: 'rawBalances',
                args: [strategy.order.maker, strategy.app, strategy.strategyHash, token.address],
              })
              return { token, virtual: BigInt(balance), tokensCount }
            }),
          ),
        ),
      )

      // Balance and allowance are per token, not per strategy — read them once.
      const uniqueTokens = new Map<string, { address: Address; symbol: string; decimals: number }>()
      for (const strategy of strategies) {
        for (const token of strategy.tokens) uniqueTokens.set(token.address.toLowerCase(), token)
      }
      const wallet = new Map<string, { held: bigint; allowance: bigint }>()
      await Promise.all(
        [...uniqueTokens.values()].map(async (token) => {
          const [held, allowance] = await Promise.all([
            client.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [safeAddress!] }),
            client.readContract({ address: token.address, abi: erc20Abi, functionName: 'allowance', args: [safeAddress!, aqua] }),
          ])
          wallet.set(token.address.toLowerCase(), { held, allowance })
        }),
      )

      // Sum what the active strategies collectively claim, per token.
      const required = new Map<string, bigint>()
      for (const legs of raws) {
        for (const leg of legs) {
          if (leg.tokensCount === DOCKED) continue
          const key = leg.token.address.toLowerCase()
          required.set(key, (required.get(key) ?? 0n) + leg.virtual)
        }
      }

      const demand: AquaTokenDemand[] = [...uniqueTokens.values()].map((token) => {
        const key = token.address.toLowerCase()
        const need = required.get(key) ?? 0n
        const { held, allowance } = wallet.get(key) ?? { held: 0n, allowance: 0n }
        return {
          address: token.address,
          symbol: token.symbol,
          decimals: token.decimals,
          required: need,
          held,
          allowance,
          isCovered: held >= need && allowance >= need,
        }
      })
      const covered = new Map(demand.map((d) => [d.address.toLowerCase(), d.isCovered]))

      const positions: AquaPosition[] = strategies.map((strategy, i) => {
        const legs = raws[i]
        const isDocked = legs.some((leg) => leg.tokensCount === DOCKED)
        return {
          strategy,
          tokens: legs.map((leg) => ({
            address: leg.token.address,
            symbol: leg.token.symbol,
            decimals: leg.token.decimals,
            shipped: BigInt(leg.token.shipped),
            approved: leg.token.approved === undefined ? undefined : BigInt(leg.token.approved),
            virtual: leg.virtual,
          })),
          isDocked,
          isBacked: !isDocked && legs.every((leg) => covered.get(leg.token.address.toLowerCase()) ?? false),
        }
      })

      return { positions, demand }
    },
  })

  return {
    positions: query.data?.positions ?? [],
    demand: query.data?.demand ?? [],
    loading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
  }
}
