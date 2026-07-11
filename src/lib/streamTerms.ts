import { keccak256, toBytes, type Address, type Hex } from 'viem'
import { canonicalize, type PinResult } from './subscriptionTerms'

/**
 * Streaming payroll contract: a human-readable agreement pinned to IPFS, with its
 * keccak256 hash used as the delegation salt so the subscriber's signature commits
 * on-chain to the exact terms — same binding as the subscription agreement, but for
 * the accumulating `erc20Streaming` caveat.
 *
 * Where the subscription caps a per-period amount that does NOT accumulate, the
 * stream accrues linearly and is claimable at any time:
 *   available(t) = min(maxAmount, initialAmount + amountPerSecond * (t - startTime))
 */

export interface StreamTerms {
  organization: { name: string; recipient: Address; delegate: Address }
  subscriber: { label: string; account: Address }
  token: { address: Address; symbol: string; decimals: number }
  // Display rate the beneficiary signed up for (e.g. "1000" over `ratePeriodSeconds`).
  ratePerPeriod: string
  ratePeriodSeconds: number
  // On-chain caveat parameters, raw wei strings.
  amountPerSecondRaw: string
  initialAmountRaw: string
  maxAmountRaw: string
  startTime: number
  cancellation: string
}

export interface StreamAgreementDocument {
  schema: 'ourglass/stream-agreement@1'
  id: string
  createdAt: string
  chainId: number
  termsHash: Hex
  terms: StreamTerms
}

export function hashStreamTerms(terms: StreamTerms): Hex {
  return keccak256(toBytes(canonicalize(terms)))
}

export function buildStreamTerms(params: {
  organization: { name: string; recipient: Address; delegate: Address }
  subscriber: { label: string; account: Address }
  token: { address: Address; symbol: string; decimals: number }
  // Display rate (e.g. "1000" over `ratePeriodSeconds`).
  ratePerPeriod: string
  ratePeriodSeconds: number
  // On-chain caveat parameters, already raw (wei strings). maxAmountRaw may be
  // MAX_UINT256 for an unbounded stream (rate-limited, runs until revoked).
  amountPerSecondRaw: string
  initialAmountRaw: string
  maxAmountRaw: string
  startTime?: number
  cancellation?: string
}): StreamTerms {
  const startTime = params.startTime ?? Math.floor(Date.now() / 1000)
  return {
    organization: params.organization,
    subscriber: params.subscriber,
    token: params.token,
    ratePerPeriod: params.ratePerPeriod,
    ratePeriodSeconds: params.ratePeriodSeconds,
    amountPerSecondRaw: params.amountPerSecondRaw,
    initialAmountRaw: params.initialAmountRaw,
    maxAmountRaw: params.maxAmountRaw,
    startTime,
    cancellation:
      params.cancellation ?? 'Cancellable anytime by the subscriber via disableDelegation. Accrued-but-unclaimed balance is forfeited on cancellation.',
  }
}

export function buildStreamAgreement(params: {
  id: string
  chainId: number
  terms: StreamTerms
  createdAt?: string
}): StreamAgreementDocument {
  return {
    schema: 'ourglass/stream-agreement@1',
    id: params.id,
    createdAt: params.createdAt ?? new Date().toISOString(),
    chainId: params.chainId,
    termsHash: hashStreamTerms(params.terms),
    terms: params.terms,
  }
}

/** Pin the stream agreement to IPFS via Pinata (JWT from VITE_PINATA_JWT). */
export async function pinStreamAgreement(doc: StreamAgreementDocument, jwt: string): Promise<PinResult> {
  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      pinataContent: doc,
      pinataMetadata: { name: `stream-agreement-${doc.id}` },
    }),
  })
  if (!res.ok) throw new Error(`Pinata pin failed (${res.status}): ${await res.text()}`)
  const json = (await res.json()) as { IpfsHash: string }
  return { cid: json.IpfsHash, uri: `ipfs://${json.IpfsHash}` }
}

/** Offline fallback when no Pinata JWT is configured. */
export function offlinePinStream(doc: StreamAgreementDocument): PinResult {
  const cid = `local-${doc.termsHash.slice(2, 18)}`
  return { cid, uri: `ipfs://${cid}` }
}

/** Linearly-accrued balance unlocked by the stream at time `nowSeconds`. */
export function streamedAvailable(params: {
  amountPerSecondRaw: string
  initialAmountRaw: string
  maxAmountRaw: string
  startTime: number
  nowSeconds: number
}): bigint {
  const { amountPerSecondRaw, initialAmountRaw, maxAmountRaw, startTime, nowSeconds } = params
  // Before startTime the enforcer unlocks nothing — not even the upfront (matches
  // ERC20StreamingEnforcer: `block.timestamp < startTime` returns 0).
  if (nowSeconds < startTime) return 0n
  const elapsed = BigInt(nowSeconds - startTime)
  const accrued = BigInt(initialAmountRaw) + BigInt(amountPerSecondRaw) * elapsed
  const max = BigInt(maxAmountRaw)
  return accrued > max ? max : accrued
}
