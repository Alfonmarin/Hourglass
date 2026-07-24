import { getAddress, stringToHex, type Address, type Hex } from 'viem'
import { pinThing as sdkPinThing, PIN_API_URL } from '@0xintuition/sdk'
import type { OrganizationMeta, ThingMeta } from './network'

/**
 * Atom data encoding + IPFS pinning for the Intuition write path.
 *
 * Accounts are encoded as CAIP-10 URIs (no IPFS); concepts/orgs are pinned to
 * IPFS first. The `DelegationJson` atom reuses the agreement URI OurGlass
 * already pins, so it is not re-pinned here.
 */

/** The Intuition recipient by kind (see spec/intuition/README.md). */
export type RecipientAtom =
  | { kind: 'caip10'; address: Address; chainId: number }
  // The Account Wallet derived from an atom (computeAtomWalletAddr). The caller
  // supplies the already-computed wallet address; it lives on the Intuition L3.
  | { kind: 'atomWallet'; walletAddress: Address }

/** CAIP-10 account URI. Address is EIP-55 checksummed to match the canonical encoding. */
export function caip10Uri(chainId: number, address: Address): string {
  return `caip10:eip155:${chainId}:${getAddress(address)}`
}

export function recipientUri(recipient: RecipientAtom, intuitionChainId: number): string {
  return recipient.kind === 'caip10'
    ? caip10Uri(recipient.chainId, recipient.address)
    : caip10Uri(intuitionChainId, recipient.walletAddress)
}

/** Encode an atom URI (ipfs:// or caip10:) as the bytes passed to createAtoms. */
export function atomDataFromUri(uri: string): Hex {
  return stringToHex(uri)
}

/** Pins structured atom metadata to IPFS and returns an `ipfs://` URI. */
export interface IntuitionPinner {
  pinThing(thing: ThingMeta): Promise<string>
  pinOrganization(org: OrganizationMeta): Promise<string>
}

function assertIpfsUri(uri: string | undefined, name: string): string {
  if (!uri || !uri.startsWith('ipfs://')) {
    throw new Error(`Pin failed — no valid IPFS URI for "${name}"`)
  }
  return uri
}

const PIN_ORGANIZATION = `mutation pinOrganization($name: String!, $description: String!, $image: String!, $url: String!, $email: String!) {
  pinOrganization(organization: { name: $name, description: $description, image: $image, url: $url, email: $email }) { uri }
}`

interface PinOrganizationResponse {
  data?: { pinOrganization?: { uri?: string } }
  errors?: { message: string }[]
}

/**
 * Pin an Organization to keep its atom typed `Organization` in the graph. The
 * SDK wraps only `pinThing`, so this hits the same pin endpoint + `apikey`
 * header directly with the schema's `pinOrganization` mutation.
 */
async function pinOrganizationDirect(
  org: OrganizationMeta,
  pinApiKey: string,
  pinApiUrl: string,
): Promise<string> {
  if (!org.name) throw new Error('Pin failed — name is required')
  const res = await fetch(pinApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: pinApiKey },
    body: JSON.stringify({ query: PIN_ORGANIZATION, variables: org }),
  })
  if (!res.ok) throw new Error(`Pin failed — HTTP ${res.status}`)
  const body = (await res.json()) as PinOrganizationResponse
  if (body.errors?.length) {
    throw new Error(`Pin failed — GraphQL errors: ${JSON.stringify(body.errors)}`)
  }
  return assertIpfsUri(body.data?.pinOrganization?.uri, org.name)
}

/**
 * Pinner backed by the Intuition pin API (pin.intuition.systems), which the read
 * GraphQL endpoint does not serve — it has no mutations. `pinThing` uses the SDK
 * wrapper; `pinOrganization` calls the schema mutation directly (no SDK wrapper).
 *
 * @param pinApiKey Intuition pin API key (server-side; see INTUITION_PIN_API_KEY).
 * @param pinApiUrl Override the pin endpoint; defaults to the SDK's PIN_API_URL.
 */
export function createGraphqlPinner(pinApiKey: string, pinApiUrl: string = PIN_API_URL): IntuitionPinner {
  return {
    async pinThing(thing) {
      if (!thing.name) throw new Error('Pin failed — name is required')
      const uri = await sdkPinThing(thing, { pinApiKey, pinApiUrl })
      return assertIpfsUri(uri, thing.name)
    },
    pinOrganization: (org) => pinOrganizationDirect(org, pinApiKey, pinApiUrl),
  }
}
