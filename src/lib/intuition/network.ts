import { defineChain, parseAbi, type Address, type Chain, type Hex } from 'viem'

/**
 * Intuition L3 network metadata + the predicate vocabulary OurGlass reuses.
 *
 * Predicate term_ids are network-specific (content-addressed ids differ per
 * chain). The testnet ids below were verified on-chain (see
 * .claude/choices/0003-intuition-testnet-predicate-reuse.md). Mainnet ids are
 * NOT yet verified — they resolve via the pin-create path until confirmed.
 */

export type IntuitionNetwork = 'testnet' | 'mainnet'

export interface ThingMeta {
  name: string
  description: string
  image: string
  url: string
}

export interface OrganizationMeta {
  name: string
  description: string
  image: string
  url: string
  email: string
}

/**
 * A predicate is either reused by its on-chain term_id (preferred — keeps the
 * vocabulary canonical) or created from a fixed `pin` payload. The payload is a
 * constant so the IPFS CID — and therefore the atom id — is deterministic
 * across runs, making creation idempotent.
 */
export type PredicateRef =
  | { label: string; termId: Hex }
  | { label: string; termId: null; pin: ThingMeta }

export interface IntuitionNetworkConfig {
  network: IntuitionNetwork
  chainId: number
  multiVault: Address
  rpcUrl: string
  graphqlUrl: string
  explorerUrl: string
  chain: Chain
  predicates: {
    owns: PredicateRef
    delegateTo: PredicateRef
    inContextOf: PredicateRef
  }
}

export const intuitionTestnet: Chain = defineChain({
  id: 13579,
  name: 'Intuition Testnet',
  nativeCurrency: { decimals: 18, name: 'Test Trust', symbol: 'tTRUST' },
  rpcUrls: { default: { http: ['https://testnet.rpc.intuition.systems/http'] } },
  blockExplorers: {
    default: {
      name: 'Intuition Testnet Explorer',
      url: 'https://testnet.explorer.intuition.systems',
    },
  },
})

export const intuitionMainnet: Chain = defineChain({
  id: 1155,
  name: 'Intuition',
  nativeCurrency: { decimals: 18, name: 'Intuition', symbol: 'TRUST' },
  rpcUrls: { default: { http: ['https://rpc.intuition.systems/http'] } },
  blockExplorers: {
    default: { name: 'Intuition Explorer', url: 'https://explorer.intuition.systems' },
  },
})

const delegateToPin: ThingMeta = {
  name: 'delegate to',
  description:
    'Predicate: the subject account grants the object account a delegated, capped authority to pull funds on its behalf.',
  image: '',
  url: 'https://hourglass.box/',
}

export const INTUITION_NETWORKS: Record<IntuitionNetwork, IntuitionNetworkConfig> = {
  testnet: {
    network: 'testnet',
    chainId: 13579,
    multiVault: '0x2Ece8D4dEdcB9918A398528f3fa4688b1d2CAB91',
    rpcUrl: 'https://testnet.rpc.intuition.systems/http',
    graphqlUrl: 'https://testnet.intuition.sh/v1/graphql',
    explorerUrl: 'https://testnet.explorer.intuition.systems',
    chain: intuitionTestnet,
    predicates: {
      owns: {
        label: 'owns',
        termId: '0xdd3eb9326e013e0ffecb067709bbf6cb6352122e025faede9c887b7c9ac4b773',
      },
      inContextOf: {
        label: 'in context of',
        termId: '0x61a88b9c372c0d164d2caf66947b67ed0fcb4c457178a271b6b3dc39fb1f8862',
      },
      // Created by an earlier publish (type Thing, 5 triples). Pinned here rather
      // than re-derived: Intuition removed the pinThing GraphQL mutation, so the
      // pin path is unavailable — and the canonical atom already exists.
      delegateTo: {
        label: 'delegate to',
        termId: '0xb56980d42a3b03455bf41ea20fe04ae223fca0b9e688994dc661414e81e6433b',
      },
    },
  },
  mainnet: {
    network: 'mainnet',
    chainId: 1155,
    multiVault: '0x6E35cF57A41fA15eA0EaE9C33e751b01A784Fe7e',
    rpcUrl: 'https://rpc.intuition.systems/http',
    graphqlUrl: 'https://mainnet.intuition.sh/v1/graphql',
    explorerUrl: 'https://explorer.intuition.systems',
    chain: intuitionMainnet,
    // Mainnet predicates verified 2026-06-29 (ADR 0003): owns + in context of
    // reuse established atoms; delegate to is created on first publish (its id is
    // deterministic from the pin payload — same as testnet).
    predicates: {
      owns: {
        label: 'owns',
        termId: '0xdd3eb9326e013e0ffecb067709bbf6cb6352122e025faede9c887b7c9ac4b773',
      },
      inContextOf: {
        label: 'in context of',
        termId: '0x892054b01d389bfe566166120470f572a56e3d4cd88c599b52c4708949625390',
      },
      delegateTo: { label: 'delegate to', termId: null, pin: delegateToPin },
    },
  },
}

export function getIntuitionNetwork(network: IntuitionNetwork): IntuitionNetworkConfig {
  return INTUITION_NETWORKS[network]
}

/**
 * The Intuition network the Safe App reads from.
 *
 * Resolved at runtime from `window.__OG__.network`, which the container
 * entrypoint writes into `/safe-app/env.js` from the runtime
 * `INTUITION_NETWORK` env var. Falls back to the build-time
 * `VITE_INTUITION_NETWORK` (dev + when no runtime config is injected). Anything
 * other than the literal `'mainnet'` resolves to testnet.
 *
 * Runtime resolution is deliberate: the static bundle would otherwise bake the
 * network at `vite build` time, forcing a rebuild to switch testnet <-> mainnet.
 */
export function resolveIntuitionNetwork(): IntuitionNetwork {
  const runtime = typeof window !== 'undefined' ? window.__OG__?.network : undefined
  const value = runtime ?? import.meta.env.VITE_INTUITION_NETWORK
  return value === 'mainnet' ? 'mainnet' : 'testnet'
}

/** Link to an atom on the Intuition portal (dev portal for testnet). */
export function portalAtomUrl(atomId: Hex, network: IntuitionNetwork): string {
  const base = network === 'mainnet'
    ? 'https://portal.intuition.systems'
    : 'https://dev.portal.intuition.systems'
  return `${base}/explore/atom/${atomId}?tab=overview`
}

/** MultiVault surface used by the write service. */
export const multiVaultAbi = parseAbi([
  'function getAtomCost() view returns (uint256)',
  'function getTripleCost() view returns (uint256)',
  'function calculateAtomId(bytes data) view returns (bytes32)',
  'function calculateTripleId(bytes32 subjectId, bytes32 predicateId, bytes32 objectId) view returns (bytes32)',
  'function isTermCreated(bytes32 termId) view returns (bool)',
  'function previewAtomCreate(bytes32 atomId, uint256 assets) view returns (uint256 shares, uint256 assetsAfterFixedFees, uint256 assetsAfterFees)',
  'function previewTripleCreate(bytes32 tripleId, uint256 assets) view returns (uint256 shares, uint256 assetsAfterFixedFees, uint256 assetsAfterFees)',
  'function createAtoms(bytes[] atomDatas, uint256[] assets) payable returns (bytes32[])',
  'function createTriples(bytes32[] subjectIds, bytes32[] predicateIds, bytes32[] objectIds, uint256[] assets) payable returns (bytes32[])',
])
