/**
 * buildLimitOrderMandate — a single, price-triggered swap (buy-the-dip). Asserts
 * the mandate carries both balance-change bounds (max-spend Decrease + min-received
 * Increase = the price trigger) at the HourGlass enforcer, a limitedCalls cap, and
 * that discovery resolves the funding token from the Decrease bound.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { getAddress } from 'viem'
import { buildLimitOrderMandate } from '../../src/lib/limitOrderMandate'
import { getEnvironment } from '../../src/lib/environment'
import { findBalanceChangeCaveat, decodeBalanceChangeTerms } from '../../src/lib/intuition/discover'
import { getAddresses } from '../../src/config/addresses'

const CHAIN = 8453
const MODULE = getAddress('0x1111111111111111111111111111111111111111')
const AGENT = getAddress('0x2222222222222222222222222222222222222222')
const ROUTER = getAddress('0x6fF5693b99212Da76ad316178A184AB56D299b43')
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const WETH = getAddress('0x4200000000000000000000000000000000000006')

function order() {
  return buildLimitOrderMandate({
    moduleAddress: MODULE,
    agentAddress: AGENT,
    environment: getEnvironment(CHAIN),
    swapRouter: ROUTER,
    recipient: MODULE,
    fundingToken: USDC,
    targetToken: WETH,
    maxSpend: 55_000_000n,
    minReceived: 18_000_000_000_000_000n,
  })
}

describe('buildLimitOrderMandate', () => {
  test('returns a pair: both unsigned, both to the agent from the module', () => {
    const { approve, swap } = order()
    for (const d of [approve, swap]) {
      expect(getAddress(d.delegate)).toBe(AGENT)
      expect(getAddress(d.delegator)).toBe(MODULE)
      expect(d.signature).toBe('0x')
      expect(d.salt).not.toBe('0x')
    }
    // Distinct delegations (distinct salts) so each has its own delegationHash.
    expect(approve.salt).not.toBe(swap.salt)
  })

  test('the swap carries two balance-change bounds + a limitedCalls cap', () => {
    const { swap } = order()
    // Every caveat routes through the HourGlass enforcer instances (environment.ts).
    const bcEnforcer = getAddress(getAddresses(CHAIN).hourglass!.erc20BalanceChangeEnforcer)
    const limitedEnforcer = getAddress(getAddresses(CHAIN).hourglass!.limitedCallsEnforcer)
    const balanceChanges = swap.caveats.filter((c) => getAddress(c.enforcer) === bcEnforcer)
    const limited = swap.caveats.filter((c) => getAddress(c.enforcer) === limitedEnforcer)
    expect(balanceChanges).toHaveLength(2)
    expect(limited).toHaveLength(1)
  })

  test('the approve carries NO balance-change bound (only the swap does)', () => {
    const { approve } = order()
    const bcEnforcer = getAddress(getAddresses(CHAIN).hourglass!.erc20BalanceChangeEnforcer)
    expect(approve.caveats.filter((c) => getAddress(c.enforcer) === bcEnforcer)).toHaveLength(0)
  })

  test('the swap max-spend (Decrease) bound round-trips to the funding token', () => {
    const { swap } = order()
    const found = findBalanceChangeCaveat(swap, CHAIN)!
    const t = decodeBalanceChangeTerms(found.terms)
    expect(t.enforceDecrease).toBe(true)
    expect(getAddress(t.token)).toBe(USDC)
    expect(t.amount).toBe(55_000_000n)
  })

  test('throws on a non-positive spend or min received', () => {
    const base = { moduleAddress: MODULE, agentAddress: AGENT, environment: getEnvironment(CHAIN), swapRouter: ROUTER, recipient: MODULE, fundingToken: USDC, targetToken: WETH }
    expect(() => buildLimitOrderMandate({ ...base, maxSpend: 0n, minReceived: 1n })).toThrow(/max spend/)
    expect(() => buildLimitOrderMandate({ ...base, maxSpend: 1n, minReceived: 0n })).toThrow(/min received/)
  })
})
