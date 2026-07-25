import { type Address, type Hex } from 'viem'

/**
 * Local record of the strategies this browser shipped.
 *
 * An index, never the source of truth. Aqua's events are unindexed
 * (`event Shipped(address maker, …)` — no `indexed` anywhere), so there is no
 * way to filter the chain by maker without pulling every Aqua log and sifting
 * client-side. We keep what we shipped and reconcile each record against
 * `rawBalances()`, which is authoritative for both balance and docked state.
 *
 * Losing this store loses the list, not the position: the strategy stays live
 * on-chain and can be reconstructed from its order.
 */

export interface AquaStrategyToken {
  address: Address
  symbol: string
  decimals: number
  /** Raw amount shipped, as a decimal string (bigint is not JSON-safe). */
  shipped: string
  /**
   * Allowance this strategy added when shipped, including headroom. Dock
   * releases exactly this, so headroom is not stranded. Absent on records
   * written before headroom existed — callers fall back to `shipped`.
   */
  approved?: string
}

export interface StoredAquaStrategy {
  chainId: number
  safeAddress: Address
  app: Address
  strategyHash: Hex
  /** Enough to rebuild the exact order for a `dock()` or a quote. */
  order: {
    maker: Address
    /** uint256 as a decimal string. */
    traits: string
    data: Hex
  }
  tokens: AquaStrategyToken[]
  feeBps: number
  createdAt: string
  status: 'shipped' | 'docked'
}

const STORAGE_KEY = 'hourglass-aqua-strategies'

export function getAquaStrategies(): StoredAquaStrategy[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

/** Strategies for one Safe on one chain, newest first. */
export function getAquaStrategiesFor(safeAddress: Address, chainId: number): StoredAquaStrategy[] {
  const safe = safeAddress.toLowerCase()
  return getAquaStrategies()
    .filter((s) => s.chainId === chainId && s.safeAddress.toLowerCase() === safe)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function saveAquaStrategy(strategy: StoredAquaStrategy): void {
  const existing = getAquaStrategies().filter((s) => s.strategyHash !== strategy.strategyHash)
  existing.push(strategy)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(existing))
}

export function setAquaStrategyStatus(strategyHash: Hex, status: StoredAquaStrategy['status']): void {
  const updated = getAquaStrategies().map((s) => (s.strategyHash === strategyHash ? { ...s, status } : s))
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
}
