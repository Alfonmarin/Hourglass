import { type Address } from 'viem'
import { mainnet, base, baseSepolia } from 'viem/chains'
import { USDC_ADDRESS } from './supported-chains'

/** Uniswap v3 Factory, per chain. Only Base Sepolia is wired — the web app's chain. */
export const UNISWAP_V3_FACTORY: Record<number, Address> = {
  [baseSepolia.id]: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
}

/** Uniswap v3 NonfungiblePositionManager, per chain. */
export const UNISWAP_V3_POSITION_MANAGER: Record<number, Address> = {
  [baseSepolia.id]: '0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2',
}

/**
 * Uniswap Universal Router, per chain — the swap target a strategy mandate
 * whitelists (with the `execute(bytes,bytes[],uint256)` selector). The Trading
 * API returns this as `swap.to` under CLASSIC routing. Only prod chains are wired
 * (verified addresses); add a testnet router here once its address is confirmed.
 * Never use the deprecated v1 router 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD.
 */
export const UNIVERSAL_ROUTER: Record<number, Address> = {
  [mainnet.id]: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',
  [base.id]: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
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
