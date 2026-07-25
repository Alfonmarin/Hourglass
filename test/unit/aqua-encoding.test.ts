/**
 * The strategy encoding is the whole integration: `ship()` stores opaque bytes
 * and validates nothing, so a wrong program ships successfully and only fails
 * later, at swap time, for whoever tries to trade against it. These tests pin
 * the encoding to fixtures captured from a live Anvil fork of Base, where the
 * hashes were confirmed against on-chain `SwapVM.hash()` and the programs were
 * confirmed by quoting real swaps (see spec/aqua/encoding.md).
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { getAddress, type Hex } from 'viem'
import {
  encodeInstruction,
  encodeProgram,
  buildAmmProgram,
  flatFeeInstruction,
  saltInstruction,
  randomSalt,
  XYC_SWAP_INSTRUCTION,
} from '../../src/lib/aqua/program'
import { buildAquaOrder, encodeStrategy, strategyHash, USE_AQUA_INSTEAD_OF_SIGNATURE } from '../../src/lib/aqua/order'
import { FEE_DENOMINATOR } from '../../src/config/aqua'

// Anvil account 0 — the maker in every spike fixture.
const MAKER = getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')

// Verified on-chain: flat fee 0.3% then constant-product swap.
const PROGRAM_UNSALTED: Hex = '0x1604002dc6c01100'
const HASH_UNSALTED: Hex = '0x384198e952a30e4cf5e4979d8728f1ff468bb84dcea648899191781ce04ecf1a'

// Same terms plus a salt of 0x00000001 — a different, shippable strategy.
const PROGRAM_SALTED: Hex = '0x1504000000011604002dc6c01100'
const HASH_SALTED: Hex = '0x53dcff873f084f81fa779a149cf52a9f50b5dc08605795d610a6558b5bef76c9'

describe('program encoding', () => {
  test('an instruction is [opcode][argsLength][args]', () => {
    expect(encodeInstruction({ opcode: 0x16, args: '0x002dc6c0' })).toBe('0x1604002dc6c0')
    expect(encodeInstruction({ opcode: 0x11, args: '0x' })).toBe('0x1100')
  })

  test('0.3% fee then swap matches the fixture quoted on-chain', () => {
    expect(encodeProgram([flatFeeInstruction(3_000_000), XYC_SWAP_INSTRUCTION])).toBe(PROGRAM_UNSALTED)
  })

  test('buildAmmProgram matches the salted fixture', () => {
    expect(buildAmmProgram({ feeBps: 3_000_000, salt: '0x00000001' })).toBe(PROGRAM_SALTED)
  })

  test('the salt lands first and changes the bytes', () => {
    const a = buildAmmProgram({ feeBps: 3_000_000, salt: '0x00000001' })
    const b = buildAmmProgram({ feeBps: 3_000_000, salt: '0x00000002' })
    expect(a).not.toBe(b)
    expect(a.slice(0, 4)).toBe('0x15')
  })

  test('rejects a fee at or above 100%', () => {
    expect(() => flatFeeInstruction(FEE_DENOMINATOR)).toThrow()
    expect(() => flatFeeInstruction(-1)).toThrow()
    expect(flatFeeInstruction(FEE_DENOMINATOR - 1)).toBeTruthy()
  })

  test('rejects args longer than the single length byte can describe', () => {
    expect(() => encodeInstruction(saltInstruction(`0x${'ab'.repeat(256)}`))).toThrow()
    expect(encodeInstruction(saltInstruction(`0x${'ab'.repeat(255)}`))).toBeTruthy()
  })

  test('rejects an opcode outside a byte', () => {
    expect(() => encodeInstruction({ opcode: 256, args: '0x' })).toThrow()
    expect(() => encodeInstruction({ opcode: -1, args: '0x' })).toThrow()
  })

  test('rejects an empty program', () => {
    expect(() => encodeProgram([])).toThrow()
  })

  test('randomSalt is four bytes and varies', () => {
    const salts = new Set(Array.from({ length: 32 }, randomSalt))
    for (const salt of salts) expect(salt).toMatch(/^0x[0-9a-f]{8}$/)
    // 32 draws from a 2^32 space colliding would mean the generator is broken.
    expect(salts.size).toBe(32)
  })
})

describe('order encoding', () => {
  test('traits is exactly the Aqua bit', () => {
    const order = buildAquaOrder(MAKER, PROGRAM_UNSALTED)
    expect(order.traits).toBe(USE_AQUA_INSTEAD_OF_SIGNATURE)
    expect(order.traits).toBe(1n << 254n)
  })

  test('strategyHash matches on-chain SwapVM.hash()', () => {
    expect(strategyHash(buildAquaOrder(MAKER, PROGRAM_UNSALTED))).toBe(HASH_UNSALTED)
    expect(strategyHash(buildAquaOrder(MAKER, PROGRAM_SALTED))).toBe(HASH_SALTED)
  })

  test('the encoded strategy is a dynamic tuple, so it opens with the 0x20 offset', () => {
    const encoded = encodeStrategy(buildAquaOrder(MAKER, PROGRAM_UNSALTED))
    expect(encoded.slice(0, 66)).toBe(`0x${'00'.repeat(31)}20`)
    expect(encoded.toLowerCase()).toContain(MAKER.slice(2).toLowerCase())
  })

  test('a different maker is a different strategy', () => {
    const other = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')
    expect(strategyHash(buildAquaOrder(other, PROGRAM_UNSALTED))).not.toBe(HASH_UNSALTED)
  })
})
