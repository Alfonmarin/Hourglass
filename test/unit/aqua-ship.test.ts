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
import { buildShipTxs, buildDockTxs } from '../../src/lib/aqua/ship'
import { buildAquaOrder, encodeStrategy } from '../../src/lib/aqua/order'
import { buildAmmProgram } from '../../src/lib/aqua/program'

const AQUA = getAddress('0x499943e74fb0ce105688beee8ef2abec5d936d31')
const APP = getAddress('0x8fDD04Dbf6111437B44bbca99C28882434e0958f')
const SAFE = getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
const WETH = getAddress('0x4200000000000000000000000000000000000006')
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const HASH: Hex = '0x384198e952a30e4cf5e4979d8728f1ff468bb84dcea648899191781ce04ecf1a'

const order = buildAquaOrder(SAFE, buildAmmProgram({ feeBps: 3_000_000, salt: '0x00000001' }))
const legs = [
  { address: WETH, amount: 1_000_000_000_000_000_000n },
  { address: USDC, amount: 2_000_000_000n },
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
      buildShipTxs({ aqua: AQUA, app: APP, order, legs: [legs[0], { address: WETH, amount: 1n }] }),
    ).toThrow()
    expect(() =>
      buildShipTxs({ aqua: AQUA, app: APP, order, legs: [legs[0], { address: USDC, amount: 0n }] }),
    ).toThrow()
  })
})

describe('buildDockTxs', () => {
  test('docks with every token, since a partial dock reverts on-chain', () => {
    const [dock] = buildDockTxs({ aqua: AQUA, app: APP, strategyHash: HASH, tokens: [WETH, USDC], revokeApprovals: false })
    const { functionName, args } = decodeFunctionData({ abi: AquaABI, data: dock.data as Hex })
    expect(functionName).toBe('dock')
    expect(args?.[1]).toBe(HASH)
    expect(args?.[2]).toEqual([WETH, USDC])
  })

  test('revoking adds a zero approval per token, because dock leaves them standing', () => {
    const txs = buildDockTxs({ aqua: AQUA, app: APP, strategyHash: HASH, tokens: [WETH, USDC], revokeApprovals: true })
    expect(txs).toHaveLength(3)
    for (const tx of txs.slice(1)) {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex })
      expect(functionName).toBe('approve')
      expect(args?.[1]).toBe(0n)
    }
  })
})
