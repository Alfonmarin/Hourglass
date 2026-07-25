import { createDelegation, BalanceChangeType } from '@metamask/smart-accounts-kit'
import { keccak256, encodePacked, type Address, type Hex } from 'viem'
import type { DelegationStruct } from './delegations'
import type { Caveat } from './storage'

/**
 * Build a limit-order mandate: one delegation the Safe signs once, letting an agent
 * make a SINGLE buy-the-dip swap that only clears at or below a target price —
 * non-custodial, everything enforced on-chain:
 *
 *   - `functionCall` scope → execute on the Universal Router.
 *   - `erc20BalanceChange` Decrease on the funding token → the max spent.
 *   - `erc20BalanceChange` Increase on the bought token → the min received. A lower
 *     price returns MORE of the bought token, so a minimum received is equivalent to
 *     "only if the price is at or below the trigger".
 *   - `limitedCalls(1)` → the order fires exactly once.
 *
 * The swap pulls the funding token through Permit2 (Universal Router 2.0), so the
 * Safe must have a standing Permit2 allowance for the router — a one-time setup per
 * Safe, independent of any single order (see the Permit2 setup flow). The delegation
 * itself only authorises the price-bounded swap.
 */

export interface LimitOrderParams {
  /** The Safe's DeleGator module (delegator) — from predictAddress. */
  moduleAddress: Address
  /** The agent allowed to redeem the order (delegate). */
  agentAddress: Address
  /** SmartAccountsEnvironment from getEnvironment(chainId) — see the `as never` note. */
  environment: unknown
  /** The Uniswap Universal Router the swap goes through. */
  swapRouter: Address
  /** The account measured by the balance-change caveats — the Safe. */
  recipient: Address
  /** The token spent (e.g. USDC). */
  fundingToken: Address
  /** The token bought (e.g. WETH). */
  targetToken: Address
  /** Max spend, raw units of the funding token — the Decrease cap. */
  maxSpend: bigint
  /** Min received, raw units of the target token — the price trigger. */
  minReceived: bigint
}

const SWAP_SELECTOR = 'execute(bytes,bytes[],uint256)'

/** salt = keccak256(terms) (project convention; never '0x' — computeDelegationHash does BigInt(salt)). */
function orderSalt(p: LimitOrderParams): Hex {
  const packed = encodePacked(
    ['address', 'address', 'address', 'address', 'uint256', 'uint256'],
    [p.swapRouter, p.agentAddress, p.fundingToken, p.targetToken, p.maxSpend, p.minReceived],
  )
  return keccak256(packed)
}

/** Build the unsigned limit-order delegation (signature '0x' until signed). */
export function buildLimitOrderMandate(p: LimitOrderParams): DelegationStruct {
  if (p.maxSpend <= 0n) throw new Error('a limit order needs a positive max spend')
  if (p.minReceived <= 0n) throw new Error('a limit order needs a positive min received (the price trigger)')

  const sdkDelegation = createDelegation({
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
    salt: orderSalt(p),
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
