import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem'

/**
 * A SwapVM order, and the bytes Aqua stores for it.
 *
 * When the `useAquaInsteadOfSignature` bit is set, SwapVM skips EIP-712 entirely
 * and identifies the strategy as `keccak256(abi.encode(order))` — which is
 * exactly what Aqua computes from the `bytes strategy` handed to `ship()`. That
 * coincidence is the whole integration: shipping the encoded order *is*
 * authorising it, with no signature anywhere.
 */

/** Bit 254 of MakerTraits: authorise from Aqua balances instead of a signature. */
export const USE_AQUA_INSTEAD_OF_SIGNATURE = 1n << 254n

export interface AquaOrder {
  maker: Address
  traits: bigint
  data: Hex
}

const ORDER_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'maker', type: 'address' },
      { name: 'traits', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
  },
] as const

/**
 * Build the order for a program.
 *
 * `traits` is exactly one bit and nothing else, which is deliberate: a zero
 * receiver defaults to the maker, and zero slice indexes put the program at
 * offset 0 of `data`. SwapVM rejects Aqua orders that unwrap WETH or name a
 * receiver other than the maker, so the minimal traits value is also the only
 * one this page can safely produce.
 */
export function buildAquaOrder(maker: Address, program: Hex): AquaOrder {
  return { maker, traits: USE_AQUA_INSTEAD_OF_SIGNATURE, data: program }
}

/** The `bytes strategy` argument to `Aqua.ship()`. */
export function encodeStrategy(order: AquaOrder): Hex {
  return encodeAbiParameters(ORDER_ABI, [order])
}

/** The strategy's identity. Equals on-chain `SwapVM.hash(order)` for Aqua orders. */
export function strategyHash(order: AquaOrder): Hex {
  return keccak256(encodeStrategy(order))
}
