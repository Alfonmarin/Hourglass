import { useQuery } from '@tanstack/react-query'
import { createPublicClient, http, isAddress, type Address, type PublicClient } from 'viem'
import { findChain, rpcUrl } from '../config/supported-chains'
import { readTokenBalance } from '../lib/safe-balances'

/**
 * The Safe's balance of one token, for the delegation solvency readout ("covers
 * N periods"). Kept separate from useSafeTokens because the picker's custom-address
 * path chooses a token that isn't in the whitelist-held set, so its balance must
 * be read on demand.
 */
export function useSafeBalance(
  safeAddress: Address | undefined,
  chainId: number | undefined,
  token: string | undefined,
): { balance: bigint | null; loading: boolean } {
  const enabled = Boolean(safeAddress && chainId && token && isAddress(token))
  const query = useQuery({
    queryKey: ['safe-balance', safeAddress, chainId, token],
    enabled,
    queryFn: async (): Promise<bigint> => {
      const chain = findChain(chainId!)
      if (!chain) return 0n
      const client = createPublicClient({ chain, transport: http(rpcUrl(chainId!)) }) as PublicClient
      return readTokenBalance(client, safeAddress!, token as Address)
    },
  })
  return { balance: query.data ?? null, loading: query.isLoading }
}
