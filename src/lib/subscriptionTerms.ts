import { keccak256, formatUnits, toBytes, type Address, type Hex } from 'viem'
import { sanitizeTokenMeta } from './token-meta'

/**
 * Subscription contract: a human-readable agreement pinned to IPFS, with its
 * keccak256 hash used as the delegation salt so the subscriber's signature
 * commits on-chain to the exact terms. Ported from @safe-subscriptions/core.
 */

export const MONTHLY_SECONDS = 2_592_000

export interface SubscriptionTerms {
  // v2: no free-text org name in the salted terms — the delegation commits to
  // ADDRESSES (reconstructible from the on-chain struct), not to a label. The
  // org name is graph metadata resolved separately. See ADR 0005.
  organization: { recipient: Address; delegate: Address }
  subscriber: { label: string; account: Address }
  token: { address: Address; symbol: string; decimals: number }
  amountPerPeriod: string
  amountPerPeriodRaw: string
  periodSeconds: number
  startDate: number
  endDate: number | null
  cancellation: string
}

export interface AgreementDocument {
  schema: 'safe-subscriptions/agreement@2'
  id: string
  createdAt: string
  chainId: number
  termsHash: Hex
  terms: SubscriptionTerms
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortDeep((value as Record<string, unknown>)[k])]),
    )
  }
  return value
}

/** Deterministic JSON (sorted keys) for a stable hash. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

export function hashTerms(terms: SubscriptionTerms): Hex {
  return keccak256(toBytes(canonicalize(terms)))
}

export function buildTerms(params: {
  organization: { recipient: Address; delegate: Address }
  subscriber: { label: string; account: Address }
  token: { address: Address; symbol: string; decimals: number }
  // The on-chain caveat `periodAmount` (raw wei string). The display amount is
  // DERIVED from it, so buildTerms and the backend reconstruction do the exact
  // same computation from the same input — the salt matches by construction.
  amountPerPeriodRaw: string
  periodSeconds?: number
  startDate?: number
  endDate?: number | null
  cancellation?: string
}): SubscriptionTerms {
  // Token metadata is hostile input (attacker-deployable contract) — sanitize
  // identically here and in reconstruction so the salt stays reproducible.
  const token = sanitizeTokenMeta({ address: params.token.address, symbol: params.token.symbol, name: '', decimals: params.token.decimals })
  const periodSeconds = params.periodSeconds ?? MONTHLY_SECONDS
  const startDate = params.startDate ?? Math.floor(Date.now() / 1000)
  return {
    organization: params.organization,
    subscriber: params.subscriber,
    token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
    amountPerPeriod: formatUnits(BigInt(params.amountPerPeriodRaw), token.decimals),
    amountPerPeriodRaw: params.amountPerPeriodRaw,
    periodSeconds,
    startDate,
    endDate: params.endDate ?? null,
    cancellation:
      params.cancellation ?? 'Cancellable anytime by the subscriber via disableDelegation.',
  }
}

export function buildAgreementDocument(params: {
  id: string
  chainId: number
  terms: SubscriptionTerms
  createdAt?: string
}): AgreementDocument {
  return {
    schema: 'safe-subscriptions/agreement@2',
    id: params.id,
    createdAt: params.createdAt ?? new Date().toISOString(),
    chainId: params.chainId,
    termsHash: hashTerms(params.terms),
    terms: params.terms,
  }
}

export interface PinResult {
  cid: string
  uri: string
}

/** Pin the agreement to IPFS via Pinata (JWT from VITE_PINATA_JWT). */
export async function pinAgreement(doc: AgreementDocument, jwt: string): Promise<PinResult> {
  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      pinataContent: doc,
      pinataMetadata: { name: `subscription-agreement-${doc.id}` },
    }),
  })
  if (!res.ok) throw new Error(`Pinata pin failed (${res.status}): ${await res.text()}`)
  const json = (await res.json()) as { IpfsHash: string }
  return { cid: json.IpfsHash, uri: `ipfs://${json.IpfsHash}` }
}

/** Offline fallback when no Pinata JWT is configured. */
export function offlinePin(doc: AgreementDocument): PinResult {
  const cid = `local-${doc.termsHash.slice(2, 18)}`
  return { cid, uri: `ipfs://${cid}` }
}

export function ipfsToHttp(uri: string, gateway = 'https://gateway.pinata.cloud/ipfs/'): string {
  return uri.startsWith('ipfs://') ? gateway + uri.slice('ipfs://'.length) : uri
}
