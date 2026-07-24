import type { Address } from 'viem'
import { cleanDisplayText } from './sanitize-text'

/**
 * Token metadata (`symbol`/`name`/`decimals`) is read from an arbitrary,
 * attacker-deployable ERC-20 contract, so it is hostile input: an unbounded or
 * control-laden `symbol` can inject markup into the pinned document and every UI
 * that renders the graph, or bloat the document past IPFS's single-block limit
 * and break the precomputed CID; an absurd `decimals` produces garbage display
 * amounts.
 *
 * `sanitizeTokenMeta` normalizes these into a bounded, printable, deterministic
 * shape. It MUST be applied identically wherever terms are built (the browser at
 * proposal, the backend at reconstruction) — both sides derive the same
 * sanitized value, so the salt stays reconstructible.
 */

export interface RawTokenMeta {
  address: Address
  symbol: string
  name: string
  decimals: number
}

export const SYMBOL_MAX_CHARS = 32
export const NAME_MAX_CHARS = 64
export const DECIMALS_MAX = 36

function clampDecimals(decimals: number): number {
  const d = Number.isFinite(decimals) ? Math.trunc(decimals) : 0
  return Math.min(Math.max(d, 0), DECIMALS_MAX)
}

/** Normalize hostile token metadata into a bounded, printable, deterministic shape. */
export function sanitizeTokenMeta(raw: RawTokenMeta): RawTokenMeta {
  return {
    address: raw.address,
    symbol: cleanDisplayText(raw.symbol, SYMBOL_MAX_CHARS),
    name: cleanDisplayText(raw.name, NAME_MAX_CHARS),
    decimals: clampDecimals(raw.decimals),
  }
}
