import { useQuery } from '@tanstack/react-query'
import { getWhitelistedTokens, type WhitelistedToken } from '../lib/token-list'

/**
 * The Uniswap-vetted tokens for a chain — the full whitelist, NOT filtered by the
 * Safe's balance. Drives the "buy this token" picker of a strategy: the target is
 * something the Safe does not hold yet (it will be bought), so balance filtering
 * (useSafeTokens) would wrongly hide it.
 *
 * Empty on chains the whitelist barely covers (testnets); the picker keeps its
 * custom-address escape hatch there.
 */
export function useWhitelistedTokens(chainId: number | undefined): {
  tokens: WhitelistedToken[]
  loading: boolean
  error: unknown
} {
  const query = useQuery({
    queryKey: ['whitelisted-tokens', chainId],
    enabled: Boolean(chainId),
    queryFn: (): Promise<WhitelistedToken[]> => getWhitelistedTokens(chainId!),
  })

  return {
    tokens: query.data ?? [],
    loading: query.isLoading,
    error: query.error,
  }
}
