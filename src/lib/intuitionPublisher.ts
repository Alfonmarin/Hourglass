import type { Address, Hex } from 'viem'
import type { IntuitionNetwork, OrganizationInput } from './intuition'

/**
 * Client for the Intuition publisher backend. The browser cannot hold the
 * attestor key, so writing the delegation onto the graph is delegated to a
 * node-side service (see server/intuition-publisher.ts). The client sends only
 * REFERENCES — the backend fetches the finalized Safe message itself, verifies it
 * on-chain (EIP-1271), and reconstructs the delegation. Configured via
 * VITE_INTUITION_PUBLISHER_URL; absent → publishing is simply disabled.
 */

export interface PokeRequest {
  chainId: number
  safeAddress: Address
  messageHash: Hex
  /** Optional org for the ownership edge — the proposer's OrgPicker selection. */
  organization?: OrganizationInput
}

export interface PublishResponse {
  uri: string
  // The publisher returns the full PublishResult; we only read these fields.
  result: { network: IntuitionNetwork; atoms: { delegationJson: Hex } }
}

export function intuitionPublisherUrl(): string | null {
  const url = import.meta.env.VITE_INTUITION_PUBLISHER_URL
  return typeof url === 'string' && url.length > 0 ? url.replace(/\/$/, '') : null
}

/** Poke the publisher to index a finalized delegation. References only — no payload. */
export async function pokePublish(req: PokeRequest): Promise<PublishResponse> {
  const base = intuitionPublisherUrl()
  if (!base) throw new Error('VITE_INTUITION_PUBLISHER_URL is not configured')
  const secret = import.meta.env.VITE_INTUITION_PUBLISHER_SECRET
  const res = await fetch(`${base}/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(typeof secret === 'string' && secret ? { 'x-publish-secret': secret } : {}),
    },
    body: JSON.stringify(req),
  })
  if (!res.ok) throw new Error(`publisher ${res.status}: ${await res.text()}`)
  // Network boundary: the backend returns exactly this shape (server/intuition-publisher.ts).
  return (await res.json()) as PublishResponse
}
