/**
 * Unit tests for recovering a delegation from a finalized Safe message (ADR 0005).
 * The message's EIP-712 typed data IS the delegation struct, so a round-trip
 * (build typed data -> wrap as a tx-service message -> decode) must reproduce the
 * exact signed struct, independently of the proposing session. Salt normalization
 * (uint256 hex OR decimal in the typed data -> bytes32) is covered.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { concatHex, pad, numberToHex, getAddress, hashTypedData, type Address, type Hex } from 'viem'
import { buildDelegationTypedData, type DelegationStruct } from '../../src/lib/delegations'
import { getAddresses } from '../../src/config/addresses'
import {
  delegationFromMessage,
  detailsFromDelegation,
  typedDataHashFromMessage,
} from '../../src/lib/intuition/from-message'
import type { SafeMessage } from '../../src/lib/safe-messages'

const CHAIN = 84532 // Base Sepolia
const addrs = getAddresses(CHAIN)

const SAFE = getAddress('0x00000000000000000000000000000000000000aa')
const ORG = getAddress('0x00000000000000000000000000000000000000bb')
const TOKEN = getAddress('0x00000000000000000000000000000000000000cc')
const SALT = ('0x' + '00'.repeat(31) + '2a') as Hex // = 42

function periodTransferTerms(token: Address, periodAmount: bigint, periodDuration: bigint, startDate: bigint): Hex {
  return concatHex([
    token,
    pad(numberToHex(periodAmount), { size: 32 }),
    pad(numberToHex(periodDuration), { size: 32 }),
    pad(numberToHex(startDate), { size: 32 }),
  ])
}

function makeDelegation(salt: Hex = SALT): DelegationStruct {
  return {
    delegate: ORG,
    delegator: SAFE,
    authority: ('0x' + 'ff'.repeat(32)) as Hex,
    caveats: [
      {
        enforcer: getAddress(addrs.erc20PeriodTransferEnforcer),
        terms: periodTransferTerms(TOKEN, 100_000_000n, 2_592_000n, 1_800_000_000n),
      },
    ],
    salt,
    signature: ('0x' + 'ab'.repeat(65)) as Hex,
  }
}

function wrapAsMessage(delegation: DelegationStruct, opts: { saltInMessage?: string | number; verifyingContract?: string } = {}): SafeMessage {
  const typed = buildDelegationTypedData(delegation, CHAIN)
  const message = {
    ...typed,
    domain: { ...typed.domain, verifyingContract: opts.verifyingContract ?? typed.domain.verifyingContract },
    message: { ...typed.message, salt: opts.saltInMessage ?? typed.message.salt },
  }
  return {
    messageHash: ('0x' + '11'.repeat(32)) as Hex,
    safe: SAFE,
    message,
    confirmations: [],
    preparedSignature: delegation.signature,
  }
}

describe('delegationFromMessage — recover the signed struct', () => {
  test('round-trips the delegation exactly', () => {
    const d = makeDelegation()
    const recovered = delegationFromMessage(wrapAsMessage(d), CHAIN)
    expect(recovered).not.toBeNull()
    expect(recovered!.delegate).toBe(d.delegate)
    expect(recovered!.delegator).toBe(d.delegator)
    expect(recovered!.authority).toBe(d.authority)
    expect(recovered!.salt).toBe(d.salt)
    expect(recovered!.signature).toBe(d.signature)
    expect(recovered!.caveats[0].enforcer).toBe(d.caveats[0].enforcer)
    expect(recovered!.caveats[0].terms).toBe(d.caveats[0].terms)
  })

  test('normalizes a decimal-string salt to bytes32', () => {
    const d = makeDelegation()
    const recovered = delegationFromMessage(wrapAsMessage(d, { saltInMessage: '42' }), CHAIN)
    expect(recovered!.salt).toBe(SALT)
  })

  test('accepts the message as a JSON string too', () => {
    const msg = wrapAsMessage(makeDelegation())
    const asString: SafeMessage = { ...msg, message: JSON.stringify(msg.message) }
    expect(delegationFromMessage(asString, CHAIN)).not.toBeNull()
  })

  test('rejects a wrong verifying contract (not our DelegationManager)', () => {
    const msg = wrapAsMessage(makeDelegation(), { verifyingContract: '0x000000000000000000000000000000000000dEaD' })
    expect(delegationFromMessage(msg, CHAIN)).toBeNull()
  })

  test('rejects an unfinalized message (no preparedSignature)', () => {
    const msg = { ...wrapAsMessage(makeDelegation()), preparedSignature: null }
    expect(delegationFromMessage(msg, CHAIN)).toBeNull()
  })
})

describe('typedDataHashFromMessage — the hash EIP-1271 expects', () => {
  test('equals the EIP-712 hash of the delegation typed data', () => {
    const d = makeDelegation()
    const expected = hashTypedData({
      domain: buildDelegationTypedData(d, CHAIN).domain,
      types: { Delegation: buildDelegationTypedData(d, CHAIN).types.Delegation, Caveat: buildDelegationTypedData(d, CHAIN).types.Caveat },
      primaryType: 'Delegation',
      message: buildDelegationTypedData(d, CHAIN).message,
    } as never)
    expect(typedDataHashFromMessage(wrapAsMessage(d))).toBe(expected)
  })

  test('is NOT the tx-service messageHash (the wrapped SafeMessage hash)', () => {
    // Regression: passing the tx-service messageHash to isValidSignature double-wraps
    // it (the Safe re-wraps _dataHash into SafeMessage) and verification always fails.
    const msg = wrapAsMessage(makeDelegation())
    expect(typedDataHashFromMessage(msg)).not.toBe(msg.messageHash)
  })

  test('null when the message carries no types', () => {
    const msg = wrapAsMessage(makeDelegation())
    expect(typedDataHashFromMessage({ ...msg, message: { domain: {}, message: {} } })).toBeNull()
  })
})

describe('detailsFromDelegation — build display details from the caveat', () => {
  test('decodes a subscription (erc20PeriodTransfer)', () => {
    const details = detailsFromDelegation(makeDelegation(), CHAIN, { symbol: 'USDC', decimals: 6 })
    expect(details).toEqual({ kind: 'subscription', amount: '100', tokenSymbol: 'USDC', period: 'month' })
  })

  test('returns null for a delegation with no known caveat', () => {
    const d = makeDelegation()
    d.caveats = [{ enforcer: TOKEN, terms: '0x' as Hex }]
    expect(detailsFromDelegation(d, CHAIN, { symbol: 'USDC', decimals: 6 })).toBeNull()
  })
})
