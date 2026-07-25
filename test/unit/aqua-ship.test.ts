/**
 * The ship batch is what the Safe actually signs, so the tests decode it back
 * rather than comparing opaque calldata strings. The approval amounts matter as
 * much as the ship itself — an over-broad approval on a treasury is the failure
 * mode worth guarding against.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { decodeFunctionData, erc20Abi, getAddress, type Hex } from 'viem'
import { AquaABI } from '../../src/config/abis'
import { buildShipTxs, buildDockTxs, buildTopUpTxs, allowanceAfterShip, allowanceAfterDock } from '../../src/lib/aqua/ship'
import { buildAquaOrder, encodeStrategy } from '../../src/lib/aqua/order'
import { buildAmmProgram } from '../../src/lib/aqua/program'
import { withHeadroom, APPROVAL_HEADROOM_MULTIPLIER } from '../../src/config/aqua'

const AQUA = getAddress('0x499943e74fb0ce105688beee8ef2abec5d936d31')
const APP = getAddress('0x8fDD04Dbf6111437B44bbca99C28882434e0958f')
const SAFE = getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
const WETH = getAddress('0x4200000000000000000000000000000000000006')
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const HASH: Hex = '0x384198e952a30e4cf5e4979d8728f1ff468bb84dcea648899191781ce04ecf1a'

const order = buildAquaOrder(SAFE, buildAmmProgram({ feeBps: 3_000_000, salt: '0x00000001' }))
const legs = [
  { address: WETH, amount: 1_000_000_000_000_000_000n, currentAllowance: 0n },
  { address: USDC, amount: 2_000_000_000n, currentAllowance: 0n },
]

describe('buildShipTxs', () => {
  const txs = buildShipTxs({ aqua: AQUA, app: APP, order, legs })

  test('is one approval per leg, then the ship', () => {
    expect(txs).toHaveLength(3)
    expect(txs[0].to).toBe(WETH)
    expect(txs[1].to).toBe(USDC)
    expect(txs[2].to).toBe(AQUA)
    for (const tx of txs) expect(tx.value).toBe('0')
  })

  test('approves the exact shipped amount, never unlimited', () => {
    const max = 2n ** 256n - 1n
    for (const [i, leg] of legs.entries()) {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: txs[i].data as Hex })
      expect(functionName).toBe('approve')
      expect(args?.[0]).toBe(AQUA)
      expect(args?.[1]).toBe(leg.amount)
      expect(args?.[1]).not.toBe(max)
    }
  })

  test('approves headroom above the shipped amount when asked', () => {
    const txs = buildShipTxs({
      aqua: AQUA,
      app: APP,
      order,
      legs: [
        { address: WETH, amount: 1_000_000n, currentAllowance: 0n, approve: 10_000_000n },
        { address: USDC, amount: 2_000_000n, currentAllowance: 5n, approve: 20_000_000n },
      ],
    })
    const { args: weth } = decodeFunctionData({ abi: erc20Abi, data: txs[0].data as Hex })
    const { args: usdc } = decodeFunctionData({ abi: erc20Abi, data: txs[1].data as Hex })
    expect(weth?.[1]).toBe(10_000_000n)
    expect(usdc?.[1]).toBe(20_000_005n)
    // The shipped amounts are untouched by headroom — only the approval grows.
    const { args: ship } = decodeFunctionData({ abi: AquaABI, data: txs[2].data as Hex })
    expect(ship?.[3]).toEqual([1_000_000n, 2_000_000n])
  })

  test('rejects an approval below the shipped amount', () => {
    expect(() =>
      buildShipTxs({
        aqua: AQUA,
        app: APP,
        order,
        legs: [
          { address: WETH, amount: 1_000_000n, currentAllowance: 0n, approve: 999_999n },
          { address: USDC, amount: 2_000_000n, currentAllowance: 0n },
        ],
      }),
    ).toThrow()
  })

  test('adds to an existing allowance instead of overwriting it', () => {
    // The regression this guards: one Safe holds one allowance to Aqua, shared
    // by every strategy. Approving the bare leg amount on a second ship would
    // silently un-back the first.
    const withExisting = buildShipTxs({
      aqua: AQUA,
      app: APP,
      order,
      legs: [
        { address: WETH, amount: 1_000_000_000_000_000_000n, currentAllowance: 500_000_000_000_000_000n },
        { address: USDC, amount: 2_000_000_000n, currentAllowance: 4_000_000n },
      ],
    })
    const { args: weth } = decodeFunctionData({ abi: erc20Abi, data: withExisting[0].data as Hex })
    const { args: usdc } = decodeFunctionData({ abi: erc20Abi, data: withExisting[1].data as Hex })
    expect(weth?.[1]).toBe(1_500_000_000_000_000_000n)
    expect(usdc?.[1]).toBe(2_004_000_000n)
  })

  test('ships the encoded order with tokens and amounts in the same order', () => {
    const { functionName, args } = decodeFunctionData({ abi: AquaABI, data: txs[2].data as Hex })
    expect(functionName).toBe('ship')
    expect(args?.[0]).toBe(APP)
    expect(args?.[1]).toBe(encodeStrategy(order))
    expect(args?.[2]).toEqual([WETH, USDC])
    expect(args?.[3]).toEqual([legs[0].amount, legs[1].amount])
  })

  test('rejects malformed strategies', () => {
    expect(() => buildShipTxs({ aqua: AQUA, app: APP, order, legs: [legs[0]] })).toThrow()
    expect(() =>
      buildShipTxs({
        aqua: AQUA,
        app: APP,
        order,
        legs: [legs[0], { address: WETH, amount: 1n, currentAllowance: 0n }],
      }),
    ).toThrow()
    expect(() =>
      buildShipTxs({
        aqua: AQUA,
        app: APP,
        order,
        legs: [legs[0], { address: USDC, amount: 0n, currentAllowance: 0n }],
      }),
    ).toThrow()
  })
})

describe('allowance arithmetic', () => {
  test('a ship adds to what is already approved', () => {
    expect(allowanceAfterShip(0n, 100n)).toBe(100n)
    expect(allowanceAfterShip(40n, 100n)).toBe(140n)
  })

  test('a dock releases only this strategy’s share, and never underflows', () => {
    expect(allowanceAfterDock(140n, 100n)).toBe(40n)
    expect(allowanceAfterDock(100n, 100n)).toBe(0n)
    // A pull can consume allowance, leaving less than the strategy's own share.
    expect(allowanceAfterDock(30n, 100n)).toBe(0n)
  })
})

describe('buildDockTxs', () => {
  const legsFor = (currentAllowance: bigint, release: bigint) => [
    { address: WETH, currentAllowance, release },
    { address: USDC, currentAllowance, release },
  ]

  test('docks with every token, since a partial dock reverts on-chain', () => {
    const [dock] = buildDockTxs({
      aqua: AQUA,
      app: APP,
      strategyHash: HASH,
      legs: legsFor(100n, 100n),
      releaseAllowance: false,
    })
    const { functionName, args } = decodeFunctionData({ abi: AquaABI, data: dock.data as Hex })
    expect(functionName).toBe('dock')
    expect(args?.[1]).toBe(HASH)
    expect(args?.[2]).toEqual([WETH, USDC])
  })

  test('releases only this strategy’s share, leaving the other strategies backed', () => {
    // 300 approved across three strategies of 100 each; docking one must leave 200.
    const txs = buildDockTxs({
      aqua: AQUA,
      app: APP,
      strategyHash: HASH,
      legs: legsFor(300n, 100n),
      releaseAllowance: true,
    })
    expect(txs).toHaveLength(3)
    for (const tx of txs.slice(1)) {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex })
      expect(functionName).toBe('approve')
      expect(args?.[1]).toBe(200n)
    }
  })

  test('zeroes the allowance only when this is the last strategy claiming it', () => {
    const txs = buildDockTxs({
      aqua: AQUA,
      app: APP,
      strategyHash: HASH,
      legs: legsFor(100n, 100n),
      releaseAllowance: true,
    })
    for (const tx of txs.slice(1)) {
      const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex })
      expect(args?.[1]).toBe(0n)
    }
  })

  test('skips a no-op approve when nothing is left to release', () => {
    const txs = buildDockTxs({
      aqua: AQUA,
      app: APP,
      strategyHash: HASH,
      legs: legsFor(0n, 0n),
      releaseAllowance: true,
    })
    expect(txs).toHaveLength(1)
  })
})

describe('buildTopUpTxs', () => {
  test('raises only the tokens that are short', () => {
    const txs = buildTopUpTxs(AQUA, [
      { address: WETH, currentAllowance: 0n, required: 100n },
      { address: USDC, currentAllowance: 500n, required: 500n },
    ])
    expect(txs).toHaveLength(1)
    expect(txs[0].to).toBe(WETH)
    const { args } = decodeFunctionData({ abi: erc20Abi, data: txs[0].data as Hex })
    expect(args?.[1]).toBe(100n)
  })

  test('is a no-op when everything is covered', () => {
    expect(buildTopUpTxs(AQUA, [{ address: WETH, currentAllowance: 100n, required: 100n }])).toHaveLength(0)
  })
})

describe('withHeadroom', () => {
  test('multiplies when on, passes through when off', () => {
    expect(withHeadroom(100n, false)).toBe(100n)
    expect(withHeadroom(100n, true)).toBe(100n * APPROVAL_HEADROOM_MULTIPLIER)
  })

  test('a docked strategy releases its headroom, not just its balance', () => {
    // 10x headroom on a 100 position: docking must free all 1000, or the
    // allowance would be stranded above what the remaining strategies need.
    const approved = withHeadroom(100n, true)
    expect(allowanceAfterDock(approved, approved)).toBe(0n)
    expect(allowanceAfterDock(approved + 500n, approved)).toBe(500n)
  })
})
