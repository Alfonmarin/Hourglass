import type { Address, Chain } from 'viem';
import { mainnet, base } from 'viem/chains';

/**
 * Analytics reads on-chain events directly from HourGlass's own (self-deployed,
 * audited-bytecode) caveat enforcer instances — attribution by emitter address,
 * no backend, no central registry. See /docs/analytics and ADR 0002.
 *
 * The instances live on Ethereum mainnet and Base at identical addresses (CREATE2
 * under the same salt — see the Vite app's `src/config/addresses.ts` → `hourglass`,
 * and /docs/deployments for the full per-chain list). Only charges routed to these
 * instances are attributable to HourGlass.
 */

// Addresses are checksummed literals copied from the Vite app's addresses.ts; the
// `as Address` cast is the standard viem narrowing for a known-good hex string.
// CREATE2 under the OURGLASS salt makes them identical on every chain below.
export const HOURGLASS_ENFORCERS = {
  /** ERC20PeriodTransferEnforcer — emits TransferredInPeriod on every subscription charge. */
  period: '0x11262E3116a50654547AB0A417BE77eB14b9F339' as Address,
  /** ERC20StreamingEnforcer — emits IncreasedSpentMap on every stream claim. */
  stream: '0xE475D14d61756D6e940B74C20d2E44EB70c71a8D' as Address,
} as const;

/** A chain the scanner sweeps for attributable events. */
export interface AnalyticsChain {
  chain: Chain;
  /** Short label for the UI. */
  name: string;
  /** Must serve historical `eth_getLogs` without an API key. */
  rpcUrl: string;
  /** How far back to sweep. Tuned per chain: block times differ by ~6x. */
  lookbackBlocks: bigint;
  /** Starting window size, halved adaptively when a provider rejects the range. */
  chunkBlocks: bigint;
}

// Tenderly's public gateways are the defaults because they serve historical logs
// with no key and accept wide ranges (probed: 1M blocks on Base). publicnode gates
// archive log queries behind a token, and mainnet.base.org caps ranges at 10k.
// Override either with a keyed endpoint (e.g. Alchemy); NEXT_PUBLIC_* is inlined at
// build time under static export.
export const ANALYTICS_CHAINS: AnalyticsChain[] = [
  {
    chain: mainnet,
    name: 'Ethereum',
    rpcUrl: process.env.NEXT_PUBLIC_ANALYTICS_RPC_URL ?? 'https://gateway.tenderly.co/public/mainnet',
    // ~12s blocks: 150k ≈ 3 weeks.
    lookbackBlocks: 150_000n,
    chunkBlocks: 40_000n,
  },
  {
    chain: base,
    name: 'Base',
    rpcUrl: process.env.NEXT_PUBLIC_ANALYTICS_BASE_RPC_URL ?? 'https://gateway.tenderly.co/public/base',
    // ~2s blocks: 2M ≈ 6 weeks, so the window covers a comparable span of time.
    lookbackBlocks: 2_000_000n,
    chunkBlocks: 500_000n,
  },
];

/**
 * Known tokens for fast symbol/decimals resolution (skips an on-chain read).
 * Keyed by `chainId:address` — the same symbol lives at different addresses per
 * chain, and an address-only key would collide across them.
 */
export const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
};

/** Metadata cache / grouping key. Amounts are only comparable within one of these. */
export function tokenKey(chainId: number, token: string): string {
  return `${chainId}:${token.toLowerCase()}`;
}
