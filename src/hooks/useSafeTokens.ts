import { useQuery } from '@tanstack/react-query'
import { createPublicClient, http, type Address, type PublicClient } from 'viem'
import { findChain, rpcUrl } from '../config/supported-chains'
import { getWhitelistedTokens } from '../lib/token-list'
import { readHeldTokens, type HeldToken } from '../lib/safe-balances'

/**
 * The vetted tokens a Safe can actually pay a delegation from: the intersection
 * of the Uniswap whitelist for the chain and the tokens the Safe holds a
 * non-zero balance of. Drives the delegation token picker — it excludes both
 * shitcoins (not whitelisted) and tokens with nothing to spend (zero balance).
 *
 * On chains the whitelist barely covers (Sepolia / Base Sepolia) this is empty;
 * the picker keeps its custom-address escape hatch for those.
 */
export function useSafeTokens(
  safeAddress: Address | undefined,
  chainId: number | undefined,
): {
  tokens: HeldToken[]
  loading: boolean
  error: unknown
  refetch: () => void
} {
  const query = useQuery({
    queryKey: ['safe-tokens', safeAddress, chainId],
    enabled: Boolean(safeAddress && chainId),
    queryFn: async (): Promise<HeldToken[]> => {
      const whitelist = await getWhitelistedTokens(chainId!)
      if (whitelist.length === 0) return []
      const chain = findChain(chainId!)
      if (!chain) return []
      const client = createPublicClient({ chain, transport: http(rpcUrl(chainId!)) }) as PublicClient
      return readHeldTokens(client, safeAddress!, whitelist)
    },
  })

  return {
    tokens: query.data ?? [],
    loading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
  }
}
