import { erc20Abi, type Address, type PublicClient } from 'viem'
import type { WhitelistedToken } from './token-list'

/**
 * Read an account's ERC-20 balances for a set of tokens. Used to cross-reference
 * the Uniswap whitelist against what a Safe actually holds, so the delegation
 * picker only offers vetted tokens the Safe can pay from.
 *
 * Balances are read in one multicall (the whitelist can be hundreds of tokens on
 * mainnet/Base); a token whose read fails is treated as a zero balance, not an
 * error — a single bad token must not blank the whole picker.
 */

/** A whitelisted token the account holds, with its raw balance. */
export interface HeldToken extends WhitelistedToken {
  balance: bigint
}

/**
 * Return the subset of `tokens` the `account` holds a non-zero balance of.
 * Order follows the input list. Reads fail-soft to zero (dropped from output).
 */
export async function readHeldTokens(
  client: PublicClient,
  account: Address,
  tokens: readonly WhitelistedToken[],
): Promise<HeldToken[]> {
  if (tokens.length === 0) return []
  const balances = await client.multicall({
    allowFailure: true,
    contracts: tokens.map((t) => ({
      address: t.address,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: [account] as const,
    })),
  })
  const held: HeldToken[] = []
  balances.forEach((result, i) => {
    if (result.status === 'success' && result.result > 0n) {
      held.push({ ...tokens[i], balance: result.result })
    }
  })
  return held
}

/** Read one token's balance for an account (0n if the read fails). */
export async function readTokenBalance(
  client: PublicClient,
  account: Address,
  token: Address,
): Promise<bigint> {
  try {
    return await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] })
  } catch {
    return 0n
  }
}
