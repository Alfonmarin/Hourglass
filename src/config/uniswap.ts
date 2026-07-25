import { type Address } from 'viem'
import { baseSepolia } from 'viem/chains'
import { USDC_ADDRESS } from './supported-chains'

/** Uniswap v3 Factory, per chain. Only Base Sepolia is wired — the web app's chain. */
export const UNISWAP_V3_FACTORY: Record<number, Address> = {
  [baseSepolia.id]: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
}

/** Uniswap v3 NonfungiblePositionManager, per chain. */
export const UNISWAP_V3_POSITION_MANAGER: Record<number, Address> = {
  [baseSepolia.id]: '0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2',
}

/** The three standard Uniswap v3 fee tiers, in hundredths of a bip. */
export const FEE_TIERS = [500, 3000, 10000] as const

/** Tick spacing per fee tier — fixed by the Uniswap v3 protocol. */
export const TICK_SPACING: Record<number, number> = {
  500: 10,
  3000: 60,
  10000: 200,
}

export interface CandidateToken {
  address: Address
  symbol: string
  decimals: number
}

/**
 * Tokens the discovery scan pairs up when looking for pools. Kept small and
 * explicit — Base Sepolia has near-zero real testnet liquidity outside these.
 */
export const CANDIDATE_TOKENS: Record<number, CandidateToken[]> = {
  [baseSepolia.id]: [
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    { address: USDC_ADDRESS[baseSepolia.id], symbol: 'USDC', decimals: 6 },
  ],
}
