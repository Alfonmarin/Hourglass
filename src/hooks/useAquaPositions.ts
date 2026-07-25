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
  /** Aqua's virtual balance — grows and shrinks as takers swap. */
  virtual: bigint
  /** What the Safe actually holds right now. */
  held: bigint
  /** What the Safe has approved Aqua to move. */
  allowance: bigint
  /** Whether a taker could actually be paid out of this leg today. */
  isBacked: boolean
}

export interface AquaPosition {
  strategy: StoredAquaStrategy
  tokens: AquaPositionToken[]
  isDocked: boolean
  /** Every leg backed. A shipped strategy is not automatically a funded one. */
  isBacked: boolean
}

/**
 * Reconcile the locally recorded strategies against the chain.
 *
 * The distinction this exists to surface: `ship()` validates nothing. A Safe can
 * ship a strategy over tokens it does not hold and has not approved, and Aqua
 * will happily record the virtual balance. Showing that number alone would
 * overstate the position, so every leg is checked against the Safe's real
 * balance and allowance and reported as backed or not.
 */
export function useAquaPositions(
  safeAddress: Address | undefined,
  chainId: number | undefined,
): {
  positions: AquaPosition[]
  loading: boolean
  error: unknown
  refetch: () => void
} {
  const query = useQuery({
    queryKey: ['aqua-positions', safeAddress, chainId],
    enabled: Boolean(safeAddress && chainId && chainId in AQUA_ADDRESS),
    queryFn: async (): Promise<AquaPosition[]> => {
      const strategies = getAquaStrategiesFor(safeAddress!, chainId!)
      if (strategies.length === 0) return []
      const chain = findChain(chainId!)
      const aqua = AQUA_ADDRESS[chainId!]
      if (!chain || !aqua) return []
      const client = createPublicClient({ chain, transport: http(rpcUrl(chainId!)) }) as PublicClient

      return Promise.all(
        strategies.map(async (strategy): Promise<AquaPosition> => {
          const legs = await Promise.all(
            strategy.tokens.map(async (token): Promise<{ token: AquaPositionToken; tokensCount: number }> => {
              const [raw, held, allowance] = await Promise.all([
                client.readContract({
                  address: aqua,
                  abi: AquaABI,
                  functionName: 'rawBalances',
                  args: [strategy.order.maker, strategy.app, strategy.strategyHash, token.address],
                }),
                client.readContract({
                  address: token.address,
                  abi: erc20Abi,
                  functionName: 'balanceOf',
                  args: [safeAddress!],
                }),
                client.readContract({
                  address: token.address,
                  abi: erc20Abi,
                  functionName: 'allowance',
                  args: [safeAddress!, aqua],
                }),
              ])
              const [balance, tokensCount] = raw
              const virtual = BigInt(balance)
              return {
                tokensCount,
                token: {
                  address: token.address,
                  symbol: token.symbol,
                  decimals: token.decimals,
                  shipped: BigInt(token.shipped),
                  virtual,
                  held,
                  allowance,
                  isBacked: tokensCount !== DOCKED && held >= virtual && allowance >= virtual,
                },
              }
            }),
          )
          const isDocked = legs.some((leg) => leg.tokensCount === DOCKED)
          return {
            strategy,
            tokens: legs.map((leg) => leg.token),
            isDocked,
            isBacked: !isDocked && legs.every((leg) => leg.token.isBacked),
          }
        }),
      )
    },
  })

  return {
    positions: query.data ?? [],
    loading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
  }
}
