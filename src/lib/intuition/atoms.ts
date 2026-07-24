import { getAddress, stringToHex, type Address, type Hex } from 'viem'
import { pinThing as sdkPinThing, PIN_API_URL } from '@0xintuition/sdk'
import { executeGraphQLRequest } from '@0xintuition/graphql'
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

// $organization is a nested PinOrganizationInput wrapper, not flat args.
// See docs.intuition.systems/docs/graphql-api/writes#pinorganization-mutation.
const PIN_ORGANIZATION = `mutation PinOrganization($organization: PinOrganizationInput!) {
  pinOrganization(organization: $organization) { uri }
}`

/**
 * Pin an Organization so its atom stays typed `Organization` in the graph. The
 * SDK wraps only `pinThing`, so this runs the schema's `pinOrganization` through
 * the SDK's `executeGraphQLRequest`, which routes pin operations to the pin
 * endpoint and sends the `apikey` header.
 */
async function pinOrganizationDirect(
  org: OrganizationMeta,
  pinApiKey: string,
  pinApiUrl: string,
): Promise<string> {
  if (!org.name) throw new Error('Pin failed — name is required')
  const data = await executeGraphQLRequest<{ pinOrganization?: { uri?: string } }, unknown>(
    PIN_ORGANIZATION,
    { organization: org },
    undefined,
    { pinApiKey, pinApiUrl },
  )
  return assertIpfsUri(data.pinOrganization?.uri, org.name)
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
