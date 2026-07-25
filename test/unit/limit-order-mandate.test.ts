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
  test('delegate/delegator/unsigned are set', () => {
    const m = order()
    expect(getAddress(m.delegate)).toBe(AGENT)
    expect(getAddress(m.delegator)).toBe(MODULE)
    expect(m.signature).toBe('0x')
    expect(m.salt).not.toBe('0x')
  })

  test('carries two balance-change bounds + a limitedCalls cap', () => {
    const m = order()
    // The whole mandate routes through the HourGlass enforcer instances (see
    // environment.ts) so every caveat is attributable to HourGlass.
    const bcEnforcer = getAddress(getAddresses(CHAIN).hourglass!.erc20BalanceChangeEnforcer)
    const limitedEnforcer = getAddress(getAddresses(CHAIN).hourglass!.limitedCallsEnforcer)
    const balanceChanges = m.caveats.filter((c) => getAddress(c.enforcer) === bcEnforcer)
    const limited = m.caveats.filter((c) => getAddress(c.enforcer) === limitedEnforcer)
    expect(balanceChanges).toHaveLength(2)
    expect(limited).toHaveLength(1)
  })

  test('the max-spend (Decrease) bound round-trips to the funding token', () => {
    const m = order()
    const found = findBalanceChangeCaveat(m, CHAIN)!
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
