import { createDelegation, BalanceChangeType } from '@metamask/smart-accounts-kit'
import { keccak256, encodePacked, encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem'
import type { DelegationStruct } from './delegations'
import type { Caveat } from './storage'

/**
 * Build a limit-order mandate as a PAIR of delegations the Safe signs (two
 * signatures), which together let an agent make a SINGLE buy-the-dip swap:
 *
 *   1. `approve` delegation — scope: approve on the funding token. The exact
 *      calldata is pinned (approve(router, maxSpend)), so the agent can only grant
 *      the router an allowance of exactly the max spend, nothing else.
 *   2. `swap` delegation — scope: execute on the router, bounded by:
 *        - erc20BalanceChange Decrease on the funding token → the max spent.
 *        - erc20BalanceChange Increase on the bought token → the min received; a
 *          lower price returns MORE, so a minimum received == "only at/below the
 *          trigger price".
 *        - limitedCalls(1) → fires exactly once.
 *
 * WHY TWO DELEGATIONS. A single delegation redeemed as approve THEN swap runs its
 * full caveat chain around EACH execution: the approve moves no bought-token, so
 * the Increase bound reverts on it (insufficient-balance-increase); and
 * limitedCalls(1) counts per redemption, so the second call exceeds the limit.
 * Splitting them gives each its own delegationHash: the Increase bound lives only
 * on the swap, and each limitedCalls counter is independent. The agent redeems both
 * in one redeemDelegations call (two SingleDefault entries).
 *
 * The two share the same salt-derived pairing so discovery can re-associate them.
 */

export interface LimitOrderParams {
  /** The Safe's DeleGator module (delegator) — from predictAddress. */
  moduleAddress: Address
  /** The agent allowed to redeem the order (delegate). */
  agentAddress: Address
  /** SmartAccountsEnvironment from getEnvironment(chainId) — see the `as never` note. */
  environment: unknown
  /** The Uniswap Universal Router the swap goes through (also the approve spender). */
  swapRouter: Address
  /** The account measured by the balance-change caveats — the Safe. */
  recipient: Address
  /** The token spent (e.g. USDC). */
  fundingToken: Address
  /** The token bought (e.g. WETH). */
  targetToken: Address
  /** Max spend, raw units of the funding token — the approve amount and the Decrease cap. */
  maxSpend: bigint
  /** Min received, raw units of the target token — the price trigger. */
  minReceived: bigint
}

/** The signed (or unsigned) pair that forms one limit order. */
export interface LimitOrderPair {
  /** Grants approve(router, maxSpend) on the funding token. */
  approve: DelegationStruct
  /** Grants the router swap, bounded by spend cap + price trigger + one-shot. */
  swap: DelegationStruct
}

const SWAP_SELECTOR = 'execute(bytes,bytes[],uint256)'
const APPROVE_SELECTOR = 'approve(address,uint256)'

/** salt = keccak256(terms) (project convention; never '0x'). The `tag` keeps the two
 * delegations of one order distinct while both derive from the same order inputs. */
function orderSalt(p: LimitOrderParams, tag: 'approve' | 'swap'): Hex {
  const packed = encodePacked(
    ['string', 'address', 'address', 'address', 'address', 'uint256', 'uint256'],
    [tag, p.swapRouter, p.agentAddress, p.fundingToken, p.targetToken, p.maxSpend, p.minReceived],
  )
  return keccak256(packed)
}

function toStruct(sdk: { delegate: Address; delegator: Address; authority: Hex; caveats: Caveat[]; salt: Hex }): DelegationStruct {
  return { delegate: sdk.delegate, delegator: sdk.delegator, authority: sdk.authority, caveats: sdk.caveats, salt: sdk.salt, signature: '0x' }
}

/** The approve delegation: exactly approve(router, maxSpend) on the funding token. */
function buildApproveDelegation(p: LimitOrderParams): DelegationStruct {
  // Pin the exact calldata so the agent can only approve the router for maxSpend.
  const approveCalldata = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [p.swapRouter, p.maxSpend],
  })
  const sdk = createDelegation({
    to: p.agentAddress,
    from: p.moduleAddress,
    environment: p.environment as never,
    scope: {
      type: 'functionCall',
      targets: [p.fundingToken],
      selectors: [APPROVE_SELECTOR],
    } as never,
    caveats: [
      { type: 'exactCalldata', calldata: approveCalldata },
    ] as never,
    salt: orderSalt(p, 'approve'),
  }) as { delegate: Address; delegator: Address; authority: Hex; caveats: Caveat[]; salt: Hex }
  return toStruct(sdk)
}

/** The swap delegation: router execute, bounded by spend cap + price trigger + one-shot. */
function buildSwapDelegation(p: LimitOrderParams): DelegationStruct {
  const sdk = createDelegation({
    to: p.agentAddress,
    from: p.moduleAddress,
    environment: p.environment as never,
    scope: {
      type: 'functionCall',
      targets: [p.swapRouter],
      selectors: [SWAP_SELECTOR],
    } as never,
    caveats: [
      // Max spent — the anti-drain cap (measured on the Safe, which spends).
      { type: 'erc20BalanceChange', tokenAddress: p.fundingToken, recipient: p.recipient, balance: p.maxSpend, changeType: BalanceChangeType.Decrease },
      // Min received — the price trigger (only clears at/below the target price).
      { type: 'erc20BalanceChange', tokenAddress: p.targetToken, recipient: p.recipient, balance: p.minReceived, changeType: BalanceChangeType.Increase },
      // Fire exactly once.
      { type: 'limitedCalls', limit: 1 },
    ] as never,
    salt: orderSalt(p, 'swap'),
  }) as { delegate: Address; delegator: Address; authority: Hex; caveats: Caveat[]; salt: Hex }
  return toStruct(sdk)
}

/** Build the unsigned limit-order delegation pair (signatures '0x' until signed). */
export function buildLimitOrderMandate(p: LimitOrderParams): LimitOrderPair {
  if (p.maxSpend <= 0n) throw new Error('a limit order needs a positive max spend')
  if (p.minReceived <= 0n) throw new Error('a limit order needs a positive min received (the price trigger)')
  return {
    approve: buildApproveDelegation(p),
    swap: buildSwapDelegation(p),
  }
}
