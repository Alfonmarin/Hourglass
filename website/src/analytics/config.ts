import type { Address } from 'viem';

/**
 * Analytics reads on-chain events directly from OurGlass's own (self-deployed,
 * audited-bytecode) caveat enforcer instances — attribution by emitter address,
 * no backend, no central registry. See /docs/analytics and ADR 0002.
 *
 * The instances live on Ethereum mainnet (see the Vite app's
 * `src/config/addresses.ts` → chain 1 `hourglass`). Only charges routed to these
 * instances are attributable to OurGlass.
 */
// Mainnet RPC for the log scan. Must serve historical `eth_getLogs` without a key:
// publicnode gates archive log queries behind a token, so the default is Tenderly's
// public gateway (historical logs, no key). Override with a keyed endpoint (e.g.
// Alchemy) via NEXT_PUBLIC_ANALYTICS_RPC_URL — inlined at build under static export.
export const ANALYTICS_RPC_URL =
  process.env.NEXT_PUBLIC_ANALYTICS_RPC_URL ?? 'https://gateway.tenderly.co/public/mainnet';

// Addresses are checksummed literals copied from the Vite app's addresses.ts; the
// `as Address` cast is the standard viem narrowing for a known-good hex string.
export const OURGLASS_ENFORCERS = {
  /** ERC20PeriodTransferEnforcer — emits TransferredInPeriod on every subscription charge. */
  period: '0x11262E3116a50654547AB0A417BE77eB14b9F339' as Address,
  /** ERC20StreamingEnforcer — emits IncreasedSpentMap on every stream claim. */
  stream: '0xE475D14d61756D6e940B74C20d2E44EB70c71a8D' as Address,
} as const;

/** Known tokens for fast symbol/decimals resolution (skips an on-chain read). */
export const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
};

// How far back to scan, and the per-request block window. The instances were
// deployed late June 2026, so a modest lookback covers all history cheaply; the
// scanner halves the window adaptively if an RPC rejects the range.
export const LOOKBACK_BLOCKS = 150_000n;
export const SCAN_CHUNK_BLOCKS = 40_000n;
