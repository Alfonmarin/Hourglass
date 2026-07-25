import { concatHex, numberToHex, size, type Hex } from 'viem'
import { AQUA_OPCODE, FEE_DENOMINATOR } from '../../config/aqua'

/**
 * SwapVM program bytecode. A program is a flat sequence of instructions, each
 * `[opcode:1][argsLength:1][args:argsLength]`, executed in order by the router's
 * run loop. There is no jump table to fix up and no relocation — building one is
 * pure byte concatenation.
 *
 * See spec/aqua/encoding.md for how the opcode numbers were established.
 */

/** An `argsLength` byte caps every instruction's arguments at 255 bytes. */
const MAX_ARGS_BYTES = 0xff

export interface Instruction {
  opcode: number
  args: Hex
}

export function encodeInstruction({ opcode, args }: Instruction): Hex {
  if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0xff) {
    throw new Error(`opcode out of range: ${opcode}`)
  }
  const argsLength = size(args)
  if (argsLength > MAX_ARGS_BYTES) {
    throw new Error(`instruction args too long: ${argsLength} bytes (max ${MAX_ARGS_BYTES})`)
  }
  return concatHex([numberToHex(opcode, { size: 1 }), numberToHex(argsLength, { size: 1 }), args])
}

export function encodeProgram(instructions: Instruction[]): Hex {
  if (instructions.length === 0) throw new Error('a program needs at least one instruction')
  return concatHex(instructions.map(encodeInstruction))
}

/**
 * A no-op instruction whose only job is to perturb the program bytes, and
 * therefore the strategy hash.
 *
 * This is load-bearing, not decorative. Aqua burns a strategy hash permanently
 * on `dock()` (`ship()` requires `tokensCount == 0`, docking leaves `255`), so
 * without a salt a Safe that docks a position could never re-create it —
 * re-shipping identical parameters reverts `StrategiesMustBeImmutable` forever.
 */
export function saltInstruction(salt: Hex): Instruction {
  return { opcode: AQUA_OPCODE.salt, args: salt }
}

/** Takes a flat fee off `amountIn` before the curve is applied. */
export function flatFeeInstruction(feeBps: number): Instruction {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= FEE_DENOMINATOR) {
    throw new Error(`fee out of range: ${feeBps} (0 <= fee < ${FEE_DENOMINATOR})`)
  }
  return { opcode: AQUA_OPCODE.flatFeeAmountIn, args: numberToHex(feeBps, { size: 4 }) }
}

/** The constant-product swap itself. Takes no arguments — it reads the registers. */
export const XYC_SWAP_INSTRUCTION: Instruction = { opcode: AQUA_OPCODE.xycSwap, args: '0x' }

/** Four bytes of randomness: enough to make a re-ship of identical terms unique. */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * The one strategy shape the page offers: a constant-product AMM with a flat fee.
 *
 * Instruction order matters — the fee must be applied before the curve computes
 * the output, which is why it comes first. The salt is inert wherever it sits.
 */
export function buildAmmProgram({ feeBps, salt }: { feeBps: number; salt: Hex }): Hex {
  return encodeProgram([saltInstruction(salt), flatFeeInstruction(feeBps), XYC_SWAP_INSTRUCTION])
}
