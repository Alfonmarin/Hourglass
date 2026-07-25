import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem'
import { UniswapV3PositionManagerABI } from '../config/abis'
import { TICK_SPACING, UNISWAP_V3_POSITION_MANAGER } from '../config/uniswap'
import type { PoolInfo } from './uniswapDiscovery'

/** A single call this app is allowed to make — pinned exactly by a caveat later. */
export interface Execution {
  target: Address
  value: bigint
  callData: Hex
}

export interface DepositPlan {
  pool: PoolInfo
  amount0: bigint
  amount1: bigint
  recipient: Address
  deadline: bigint
  /** [approve token0, approve token1, mint] — in the order they must be redeemed. */
  executions: [Execution, Execution, Execution]
}

// Uniswap v3's global tick bounds. A "full range" position uses the widest
// range the tick spacing allows, so it never needs rebalancing.
const MIN_TICK = -887272
const MAX_TICK = 887272

/** Widest valid [tickLower, tickUpper] for a fee tier's tick spacing. */
export function fullRangeTicks(fee: number): { tickLower: number; tickUpper: number } {
  const spacing = TICK_SPACING[fee]
  if (!spacing) throw new Error(`Unknown fee tier: ${fee}`)
  return {
    tickLower: Math.ceil(MIN_TICK / spacing) * spacing,
    tickUpper: Math.floor(MAX_TICK / spacing) * spacing,
  }
}

// This POC doesn't implement Uniswap's liquidity math (converting desired
// amounts + current price into the amount actually consumable at a given
// tick range), so it can't compute a precise expected-consumption minimum.
// A flat, generous tolerance is used instead of a tight one — acceptable for
// a $1-scale testnet deposit, not a substitute for real slippage protection.
const SLIPPAGE_BPS = 500n // 5%
const withSlippage = (amount: bigint): bigint => amount - (amount * SLIPPAGE_BPS) / 10_000n

/**
 * Builds the exact 3 calls (approve token0, approve token1, mint a full-range
 * position) needed to deposit into `pool`. Every value here — target,
 * calldata, amounts — is fixed once and pinned byte-for-byte into the
 * delegations built from this plan; nothing about it is decided later by
 * whoever redeems.
 */
export function buildDepositPlan(params: {
  pool: PoolInfo
  amount0: bigint
  amount1: bigint
  recipient: Address
  chainId: number
  deadlineSeconds: number
}): DepositPlan {
  const { pool, amount0, amount1, recipient, chainId, deadlineSeconds } = params
  if (amount0 <= 0n || amount1 <= 0n) throw new Error('Both deposit amounts must be positive')

  const positionManager = UNISWAP_V3_POSITION_MANAGER[chainId]
  if (!positionManager) throw new Error(`Uniswap PositionManager not configured for chain ${chainId}`)

  const { tickLower, tickUpper } = fullRangeTicks(pool.fee)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds)

  const approve0: Execution = {
    target: pool.token0.address,
    value: 0n,
    callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [positionManager, amount0] }),
  }
  const approve1: Execution = {
    target: pool.token1.address,
    value: 0n,
    callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [positionManager, amount1] }),
  }
  const mint: Execution = {
    target: positionManager,
    value: 0n,
    callData: encodeFunctionData({
      abi: UniswapV3PositionManagerABI,
      functionName: 'mint',
      args: [
        {
          token0: pool.token0.address,
          token1: pool.token1.address,
          fee: pool.fee,
          tickLower,
          tickUpper,
          amount0Desired: amount0,
          amount1Desired: amount1,
          amount0Min: withSlippage(amount0),
          amount1Min: withSlippage(amount1),
          recipient,
          deadline,
        },
      ],
    }),
  }

  return { pool, amount0, amount1, recipient, deadline, executions: [approve0, approve1, mint] }
}
