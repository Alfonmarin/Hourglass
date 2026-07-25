import { createDelegation, BalanceChangeType } from '@metamask/smart-accounts-kit'
import { keccak256, encodePacked, type Address, type Hex } from 'viem'
import type { DelegationStruct } from './delegations'
import type { Caveat } from './storage'

/**
 * Build a strategy mandate: one delegation the Safe signs once, letting an agent
 * swap on the Safe's behalf while an `erc20BalanceChange` caveat caps the loss per
 * swap. The scope is `functionCall` limited to the funding token + the swap router
 * (approve + execute), so the agent can only route swaps — never touch another
 * contract. Non-custodial: funds never leave the Safe (see ADR 0006, docs).
 *
 * Generic on purpose: DCA is one funding-token spend cap; range/index reuse the
 * same rail by adding caps (a distinct token per extra cap — same-token stacking
 * reverts, see docs/HOURGLASS_STRATEGIES.md).
 */

/**
 * A per-swap bound on one token's balance change, enforced by erc20BalanceChange.
 *
 * - `direction: 'decrease'` → the token may drop by at most `amount` (a max spend;
 *   the anti-drain cap on the funding token).
 * - `direction: 'increase'` → the token must rise by at least `amount` (a min
 *   received; the price floor on the bought token — swap only if the received
 *   amount clears it, i.e. the price is within bound).
 *
 * Distinct token per bound — same-token stacking reverts (see docs).
 */
export interface BalanceBound {
  tokenAddress: Address
  /** The account measured — the Safe (funds move here). */
  recipient: Address
  /** Raw bound in the token's smallest unit (parseUnits with its decimals). */
  amount: bigint
  direction: 'decrease' | 'increase'
}

export interface StrategyMandateParams {
  /** The Safe's DeleGator module (delegator) — from predictAddress. */
  moduleAddress: Address
  /** The agent allowed to redeem the mandate (delegate). */
  agentAddress: Address
  /** SmartAccountsEnvironment from getEnvironment(chainId) — see the `as never` note. */
  environment: unknown
  /** The Uniswap Universal Router the swaps go through. */
  swapRouter: Address
  /**
   * The per-swap balance bounds. A DCA passes a max-spend (decrease) on the
   * funding token, and optionally a min-received (increase) on the bought token —
   * the price floor. Distinct tokens.
   */
  bounds: BalanceBound[]
}

/** The 4-byte selectors the strategy rail whitelists: approve + the router's execute. */
const STRATEGY_SELECTORS = ['approve(address,uint256)', 'execute(bytes,bytes[],uint256)'] as const

/**
 * The salt binds the signature to these exact terms (project convention:
 * `salt = keccak256(terms)`; never '0x' — computeDelegationHash does BigInt(salt)).
 * Terms here = the router + each cap, so two mandates with different caps differ.
 */
function mandateSalt(swapRouter: Address, agentAddress: Address, bounds: BalanceBound[]): Hex {
  const parts: Hex[] = [
    encodePacked(['address', 'address'], [swapRouter, agentAddress]),
    ...bounds.map((b) => encodePacked(['address', 'address', 'uint256', 'bool'], [b.tokenAddress, b.recipient, b.amount, b.direction === 'decrease'])),
  ]
  return keccak256(`0x${parts.map((p) => p.slice(2)).join('')}`)
}

/** Build the unsigned strategy-mandate delegation (signature '0x' until signed). */
export function buildStrategyMandate(params: StrategyMandateParams): DelegationStruct {
  const { moduleAddress, agentAddress, environment, swapRouter, bounds } = params
  if (bounds.length === 0) throw new Error('a strategy mandate needs at least one balance bound')

  // Whitelist the router plus every bounded token (approve targets the token).
  const targets = [swapRouter, ...bounds.map((b) => b.tokenAddress)]

  const sdkDelegation = createDelegation({
    to: agentAddress,
    from: moduleAddress,
    environment: environment as never,
    scope: {
      type: 'functionCall',
      targets,
      selectors: STRATEGY_SELECTORS,
    } as never,
    caveats: bounds.map((b) => ({
      type: 'erc20BalanceChange',
      tokenAddress: b.tokenAddress,
      recipient: b.recipient,
      balance: b.amount,
      changeType: b.direction === 'decrease' ? BalanceChangeType.Decrease : BalanceChangeType.Increase,
    })) as never,
    salt: mandateSalt(swapRouter, agentAddress, bounds),
  }) as { delegate: Address; delegator: Address; authority: Hex; caveats: Caveat[]; salt: Hex }

  return {
    delegate: sdkDelegation.delegate,
    delegator: sdkDelegation.delegator,
    authority: sdkDelegation.authority,
    caveats: sdkDelegation.caveats,
    salt: sdkDelegation.salt,
    signature: '0x',
  }
}
