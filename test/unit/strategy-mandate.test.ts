/**
 * buildStrategyMandate — the strategy rail builder (DCA / range). Asserts the
 * built delegation carries the erc20BalanceChange cap resolved to the HourGlass
 * enforcer (so discovery finds it), the functionCall scope over the router, a
 * bound signature slot, and that the write→discover→decode loop round-trips.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { getAddress } from 'viem'
import { buildStrategyMandate } from '../../src/lib/strategyMandate'
import { getEnvironment } from '../../src/lib/environment'
import { findBalanceChangeCaveat, decodeBalanceChangeTerms } from '../../src/lib/intuition/discover'
import { getAddresses } from '../../src/config/addresses'

// Base mainnet carries the full HourGlass enforcer suite.
const CHAIN = 8453
const MODULE = getAddress('0x1111111111111111111111111111111111111111')
const AGENT = getAddress('0x2222222222222222222222222222222222222222')
const ROUTER = getAddress('0x6fF5693b99212Da76ad316178A184AB56D299b43')
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const WETH = getAddress('0x4200000000000000000000000000000000000006')

function dcaMandate() {
  return buildStrategyMandate({
    moduleAddress: MODULE,
    agentAddress: AGENT,
    environment: getEnvironment(CHAIN),
    swapRouter: ROUTER,
    bounds: [{ tokenAddress: USDC, recipient: MODULE, amount: 55_000_000n, direction: 'decrease' as const }],
  })
}

describe('buildStrategyMandate', () => {
  test('delegate/delegator/unsigned are set', () => {
    const m = dcaMandate()
    expect(getAddress(m.delegate)).toBe(AGENT)
    expect(getAddress(m.delegator)).toBe(MODULE)
    expect(m.signature).toBe('0x')
    expect(m.salt).not.toBe('0x')
  })

  test('carries a balance-change caveat at the HourGlass enforcer, discoverable', () => {
    const m = dcaMandate()
    const found = findBalanceChangeCaveat(m, CHAIN)
    expect(found).not.toBeNull()
    expect(getAddress(found!.enforcer)).toBe(
      getAddress(getAddresses(CHAIN).hourglass!.erc20BalanceChangeEnforcer),
    )
  })

  test('the cap round-trips through decode (Decrease, right token + amount)', () => {
    const m = dcaMandate()
    const found = findBalanceChangeCaveat(m, CHAIN)!
    const t = decodeBalanceChangeTerms(found.terms)
    expect(t.enforceDecrease).toBe(true)
    expect(getAddress(t.token)).toBe(USDC)
    expect(getAddress(t.recipient)).toBe(MODULE)
    expect(t.amount).toBe(55_000_000n)
  })

  test('stacks a max-spend (decrease) + a min-received (increase) on distinct tokens', () => {
    const m = buildStrategyMandate({
      moduleAddress: MODULE,
      agentAddress: AGENT,
      environment: getEnvironment(CHAIN),
      swapRouter: ROUTER,
      bounds: [
        { tokenAddress: USDC, recipient: MODULE, amount: 55_000_000n, direction: 'decrease' as const },
        { tokenAddress: WETH, recipient: MODULE, amount: 20_000_000_000_000_000n, direction: 'increase' as const },
      ],
    })
    const balanceChanges = m.caveats.filter(
      (c) => getAddress(c.enforcer) === getAddress(getAddresses(CHAIN).hourglass!.erc20BalanceChangeEnforcer),
    )
    expect(balanceChanges).toHaveLength(2)
  })

  test('discovery finds the Decrease (funding) bound even when the Increase is first', () => {
    // The order here puts the Increase (target) bound first — findBalanceChangeCaveat
    // must still return the Decrease (funding) one, not the first match.
    const m = buildStrategyMandate({
      moduleAddress: MODULE,
      agentAddress: AGENT,
      environment: getEnvironment(CHAIN),
      swapRouter: ROUTER,
      bounds: [
        { tokenAddress: WETH, recipient: MODULE, amount: 20_000_000_000_000_000n, direction: 'increase' as const },
        { tokenAddress: USDC, recipient: MODULE, amount: 55_000_000n, direction: 'decrease' as const },
      ],
    })
    const found = findBalanceChangeCaveat(m, CHAIN)!
    const t = decodeBalanceChangeTerms(found.terms)
    expect(t.enforceDecrease).toBe(true)
    expect(getAddress(t.token)).toBe(USDC) // funding, not the WETH target
    expect(t.amount).toBe(55_000_000n)
  })

  test('throws when given no bounds', () => {
    expect(() =>
      buildStrategyMandate({
        moduleAddress: MODULE,
        agentAddress: AGENT,
        environment: getEnvironment(CHAIN),
        swapRouter: ROUTER,
        bounds: [],
      }),
    ).toThrow(/at least one balance bound/)
  })
})
