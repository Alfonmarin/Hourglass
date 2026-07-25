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
  /**
   * The Safe's current allowance to Aqua for this token, read immediately
   * before building. Required, because the allowance is shared.
   */
  currentAllowance: bigint
}

export interface ShipParams {
  aqua: Address
  app: Address
  order: AquaOrder
  legs: ShipLeg[]
}

/** What a token's allowance must become to cover an existing position plus a new leg. */
export function allowanceAfterShip(currentAllowance: bigint, amount: bigint): bigint {
  return currentAllowance + amount
}

/**
 * Approve each leg, then ship.
 *
 * The approval **accumulates**: one Safe holds one allowance to Aqua, shared by
 * every strategy it has shipped. Approving the bare leg amount would overwrite
 * that shared value and silently un-back every earlier strategy over the same
 * token — the allowance is per (owner, spender), not per strategy.
 *
 * Amounts are still exact, never `type(uint256).max`. The trade-off is real and
 * deliberate: as swaps run, `push()` can grow a token's virtual balance above
 * what was shipped, and a later `pull()` needs allowance to cover it — so a
 * strategy that trades heavily can stall until the Safe tops it up. A stalled
 * strategy is a recoverable inconvenience; a standing unlimited allowance on a
 * treasury is not.
 */
export function buildShipTxs({ aqua, app, order, legs }: ShipParams): SafeTx[] {
  if (legs.length < 2) throw new Error('a strategy needs at least two tokens')
  if (legs.some((leg) => leg.amount <= 0n)) throw new Error('every leg needs a non-zero amount')
  if (legs.some((leg) => leg.currentAllowance < 0n)) throw new Error('allowance cannot be negative')
  if (new Set(legs.map((leg) => leg.address.toLowerCase())).size !== legs.length) {
    throw new Error('duplicate token in strategy legs')
  }

  const approvals: SafeTx[] = legs.map((leg) => ({
    to: leg.address,
    value: '0',
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [aqua, allowanceAfterShip(leg.currentAllowance, leg.amount)],
    }),
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

export interface DockLeg {
  address: Address
  /** The Safe's current allowance to Aqua for this token. */
  currentAllowance: bigint
  /** This strategy's remaining virtual balance — the share of the allowance it holds. */
  virtual: bigint
}

export interface DockParams {
  aqua: Address
  app: Address
  strategyHash: Hex
  /**
   * Every token in the strategy. A partial dock reverts
   * (`DockingShouldCloseAllTokens`).
   */
  legs: DockLeg[]
  /** Release this strategy's share of the shared allowance. */
  releaseAllowance: boolean
}

/**
 * What a token's allowance should drop to once one strategy stops needing it.
 *
 * Not zero: the allowance is shared across every strategy the Safe has shipped,
 * so zeroing it on a dock would un-back all the others. Only this strategy's
 * own share comes off.
 */
export function allowanceAfterDock(currentAllowance: bigint, virtual: bigint): bigint {
  return currentAllowance > virtual ? currentAllowance - virtual : 0n
}

/**
 * Dock, optionally releasing this strategy's share of the allowance.
 *
 * `dock()` moves no tokens — it only closes the accounting — so the allowance it
 * leaves standing is the thing worth cleaning up.
 */
export function buildDockTxs({ aqua, app, strategyHash, legs, releaseAllowance }: DockParams): SafeTx[] {
  if (legs.length === 0) throw new Error('dock needs the strategy tokens')

  const dock: SafeTx = {
    to: aqua,
    value: '0',
    data: encodeFunctionData({
      abi: AquaABI,
      functionName: 'dock',
      args: [app, strategyHash, legs.map((leg) => leg.address)],
    }),
  }
  if (!releaseAllowance) return [dock]

  // Skip a token whose allowance would not move: a no-op approve is pure gas.
  const releases: SafeTx[] = legs
    .filter((leg) => allowanceAfterDock(leg.currentAllowance, leg.virtual) !== leg.currentAllowance)
    .map((leg) => ({
      to: leg.address,
      value: '0',
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [aqua, allowanceAfterDock(leg.currentAllowance, leg.virtual)],
      }),
    }))

  return [dock, ...releases]
}

export interface TopUpLeg {
  address: Address
  currentAllowance: bigint
  /** What the allowance needs to be for every active strategy to stay pullable. */
  required: bigint
}

/**
 * Raise the allowance back to what the Safe's active strategies need.
 *
 * The remedy for an under-backed position — whether from a dock that released
 * too much, a pull that consumed allowance, or tokens having moved out.
 */
export function buildTopUpTxs(aqua: Address, legs: TopUpLeg[]): SafeTx[] {
  return legs
    .filter((leg) => leg.required > leg.currentAllowance)
    .map((leg) => ({
      to: leg.address,
      value: '0',
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [aqua, leg.required] }),
    }))
}
