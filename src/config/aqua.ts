import { type Address } from 'viem'
import { base } from 'viem/chains'

/**
 * Aqua (1inch's shared liquidity layer) and the SwapVM app strategies ship to.
 *
 * Base only, deliberately. Both contracts sit at the same address on twelve
 * mainnets, but the encoding below — the opcode table in particular — was
 * verified against the Base deployment only (see spec/aqua/encoding.md).
 * Opcodes are positions in a function table, not a stable enum, so a chain
 * running a different build would silently accept a program that ships fine and
 * reverts at swap time. Add a chain here only after re-running
 * scripts/aqua-spike.sh against it.
 */
export const AQUA_ADDRESS: Record<number, Address> = {
  [base.id]: '0x499943e74fb0ce105688beee8ef2abec5d936d31',
}

/** `AquaSwapVMRouter` — the Aqua app we ship to. Same caveat as above. */
export const AQUA_SWAPVM_ADDRESS: Record<number, Address> = {
  [base.id]: '0x8fDD04Dbf6111437B44bbca99C28882434e0958f',
}

/** True when Aqua is wired for a chain — drives the page's unsupported state. */
export function isAquaSupported(chainId: number | undefined): boolean {
  return chainId !== undefined && chainId in AQUA_ADDRESS
}

/**
 * SwapVM opcodes for the *deployed* AquaSwapVMRouter build.
 *
 * These are indices into the router's `_opcodes()` function table, which is
 * built with an assembly trick that drops the first entry — so opcode `i` is
 * `instructions[i+1]`. They have already shifted at least once between builds:
 * the orders shipped on Base in Nov 2025 use a different table and are not
 * executable. Never take these from the GitHub repo; they came from the
 * verified deployed source and were confirmed by execution.
 */
export const AQUA_OPCODE = {
  deadline: 0x0d,
  xycSwap: 0x11,
  salt: 0x15,
  flatFeeAmountIn: 0x16,
} as const

/**
 * SwapVM's fee scale: 1e9 is 100%. The instruction argument is named `feeBps` in
 * the contract, which is a misnomer worth keeping in sync with the source rather
 * than renaming here.
 */
export const FEE_DENOMINATOR = 1_000_000_000

/**
 * How much allowance to leave above the shipped amount, when headroom is on.
 *
 * A swap spends the allowance of the token it pulls *out* — Aqua calls
 * `transferFrom(maker, …)` for that leg — and leaves the incoming leg's
 * allowance alone, since `push()` spends the taker's allowance instead. So an
 * allowance only ever falls, and is consumed by a token's gross outflow rather
 * than its net flow: in a two-way market both legs drain even while the
 * balances hold steady. Tokens arriving from swaps, fees included, land outside
 * the approval entirely.
 *
 * An approval set to exactly the shipped size therefore runs out after roughly
 * one turnover, and the strategy stops filling until the Safe tops it up. A
 * multiple buys that many turnovers of unattended operation while keeping the
 * exposure bounded and legible, which `type(uint256).max` would not.
 *
 * Measured on a Base fork; asserted by `scripts/aqua-fork-check.ts`.
 */
export const APPROVAL_HEADROOM_MULTIPLIER = 10n

/** The allowance to request for a leg: the shipped amount, or a multiple of it. */
export function withHeadroom(amount: bigint, enabled: boolean): bigint {
  return enabled ? amount * APPROVAL_HEADROOM_MULTIPLIER : amount
}

export interface FeePreset {
  label: string
  feeBps: number
}

/** The fee tiers the page offers, mirroring the familiar Uniswap v3 tiers. */
export const FEE_PRESETS: readonly FeePreset[] = [
  { label: '0.05%', feeBps: 500_000 },
  { label: '0.30%', feeBps: 3_000_000 },
  { label: '1.00%', feeBps: 10_000_000 },
]
