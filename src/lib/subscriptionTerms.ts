import { keccak256, parseUnits, toBytes, type Address, type Hex } from 'viem'

/**
 * Subscription contract: a human-readable agreement pinned to IPFS, with its
 * keccak256 hash used as the delegation salt so the subscriber's signature
 * commits on-chain to the exact terms. Ported from @safe-subscriptions/core.
 */

export const MONTHLY_SECONDS = 2_592_000

export interface SubscriptionTerms {
  organization: { name: string; recipient: Address; delegate: Address }
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
  schema: 'safe-subscriptions/agreement@1'
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
  organization: { name: string; recipient: Address; delegate: Address }
  subscriber: { label: string; account: Address }
  token: { address: Address; symbol: string; decimals: number }
  amountPerPeriod: string
  periodSeconds?: number
  startDate?: number
  endDate?: number | null
  cancellation?: string
}): SubscriptionTerms {
  const periodSeconds = params.periodSeconds ?? MONTHLY_SECONDS
  const startDate = params.startDate ?? Math.floor(Date.now() / 1000)
  return {
    organization: params.organization,
    subscriber: params.subscriber,
    token: params.token,
    amountPerPeriod: params.amountPerPeriod,
    amountPerPeriodRaw: parseUnits(params.amountPerPeriod, params.token.decimals).toString(),
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
    schema: 'safe-subscriptions/agreement@1',
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
