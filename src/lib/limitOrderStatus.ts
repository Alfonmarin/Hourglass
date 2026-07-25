import { createPublicClient, http, parseAbi, type Hex, type PublicClient } from 'viem'
import { getAddresses } from '../config/addresses'
import { findChain, rpcUrl } from '../config/supported-chains'

/**
 * A limit order is one-shot (`limitedCalls(1)`). Once the agent redeems it, the
 * HourGlass limitedCalls enforcer bumps an on-chain counter keyed by
 * `(delegationManager, delegationHash)`. Reading it tells the UI whether the order
 * has already fired — so it can show "Redeemed" instead of "Active".
 */

const limitedCallsAbi = parseAbi([
  'function callCounts(address delegationManager, bytes32 delegationHash) view returns (uint256)',
])

/** True once the limit order's `limitedCalls` counter has reached its limit of 1. */
export async function isLimitOrderRedeemed(chainId: number, delegationHash: Hex): Promise<boolean> {
  const addrs = getAddresses(chainId)
  const enforcer = addrs.hourglass?.limitedCallsEnforcer
  if (!enforcer) return false
  const chain = findChain(chainId)
  if (!chain) return false
  const client = createPublicClient({ chain, transport: http(rpcUrl(chainId)) }) as PublicClient
  try {
    const count = await client.readContract({
      address: enforcer,
      abi: limitedCallsAbi,
      functionName: 'callCounts',
      args: [addrs.delegationManager, delegationHash],
    })
    return count >= 1n
  } catch {
    return false
  }
}
