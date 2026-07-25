import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem'
import { AquaABI } from '../../config/abis'
import { encodeStrategy, type AquaOrder } from './order'

/**
 * The transactions that put a strategy live, and take it back down.
 *
 * Pure: these build calldata and return it. Sending is the caller's job, which
 * keeps the whole thing unit-testable without a Safe or a chain.
 */

/** The Safe Apps SDK transaction shape. */
export interface SafeTx {
  to: string
  value: string
  data: string
}

export interface ShipLeg {
  address: Address
  /** Raw amount in the token's smallest unit. */
  amount: bigint
}

export interface ShipParams {
  aqua: Address
  app: Address
  order: AquaOrder
  legs: ShipLeg[]
}

/**
 * Approve each leg, then ship.
 *
 * Approvals are for the exact shipped amount, never `type(uint256).max`. The
 * trade-off is real and deliberate: as swaps run, `push()` can grow a token's
 * virtual balance above what was shipped, and a later `pull()` needs allowance
 * to cover it — so a strategy that trades heavily can stall until the Safe
 * re-approves. A stalled strategy is a recoverable inconvenience; a standing
 * unlimited allowance on a treasury is not.
 */
export function buildShipTxs({ aqua, app, order, legs }: ShipParams): SafeTx[] {
  if (legs.length < 2) throw new Error('a strategy needs at least two tokens')
  if (legs.some((leg) => leg.amount <= 0n)) throw new Error('every leg needs a non-zero amount')
  if (new Set(legs.map((leg) => leg.address.toLowerCase())).size !== legs.length) {
    throw new Error('duplicate token in strategy legs')
  }

  const approvals: SafeTx[] = legs.map((leg) => ({
    to: leg.address,
    value: '0',
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [aqua, leg.amount] }),
  }))

  const ship: SafeTx = {
    to: aqua,
    value: '0',
    data: encodeFunctionData({
      abi: AquaABI,
      functionName: 'ship',
      args: [app, encodeStrategy(order), legs.map((leg) => leg.address), legs.map((leg) => leg.amount)],
    }),
  }

  return [...approvals, ship]
}

export interface DockParams {
  aqua: Address
  app: Address
  strategyHash: Hex
  tokens: Address[]
  /** Also zero the allowances. `dock()` alone leaves them standing. */
  revokeApprovals: boolean
}

/**
 * Dock, optionally revoking the approvals.
 *
 * `dock()` must name every token in the strategy or it reverts
 * (`DockingShouldCloseAllTokens`), and it moves no tokens — it only closes the
 * accounting. The approvals it leaves behind are why revocation is offered.
 */
export function buildDockTxs({ aqua, app, strategyHash, tokens, revokeApprovals }: DockParams): SafeTx[] {
  if (tokens.length === 0) throw new Error('dock needs the strategy tokens')

  const dock: SafeTx = {
    to: aqua,
    value: '0',
    data: encodeFunctionData({ abi: AquaABI, functionName: 'dock', args: [app, strategyHash, tokens] }),
  }
  if (!revokeApprovals) return [dock]

  const revocations: SafeTx[] = tokens.map((token) => ({
    to: token,
    value: '0',
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [aqua, 0n] }),
  }))

  return [dock, ...revocations]
}
