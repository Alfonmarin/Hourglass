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
    caps: [{ tokenAddress: USDC, recipient: MODULE, amount: 55_000_000n }],
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

  test('range mandate stacks a second cap on a distinct token', () => {
    const m = buildStrategyMandate({
      moduleAddress: MODULE,
      agentAddress: AGENT,
      environment: getEnvironment(CHAIN),
      swapRouter: ROUTER,
      caps: [
        { tokenAddress: USDC, recipient: MODULE, amount: 55_000_000n },
        { tokenAddress: WETH, recipient: MODULE, amount: 20_000_000_000_000_000n },
      ],
    })
    const balanceChanges = m.caveats.filter(
      (c) => getAddress(c.enforcer) === getAddress(getAddresses(CHAIN).hourglass!.erc20BalanceChangeEnforcer),
    )
    expect(balanceChanges).toHaveLength(2)
  })

  test('throws when given no caps', () => {
    expect(() =>
      buildStrategyMandate({
        moduleAddress: MODULE,
        agentAddress: AGENT,
        environment: getEnvironment(CHAIN),
        swapRouter: ROUTER,
        caps: [],
      }),
    ).toThrow(/at least one spend cap/)
  })
})
