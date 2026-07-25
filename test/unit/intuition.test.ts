/**
 * Unit tests for the Intuition write service (spec/intuition/README.md, Phase 2).
 * The chain + pinner are faked at the port boundary, so these prove the
 * orchestration logic: the nested-triple ontology is built correctly, predicate
 * reuse vs pin-create works, and a re-run is fully idempotent.
 *
 * Run: bun test test/unit
 */
import { describe, test, expect } from 'bun:test'
import { concatHex, getAddress, isHex, keccak256, type Hex } from 'viem'
import {
  caip10Uri,
  recipientUri,
  atomDataFromUri,
  getIntuitionNetwork,
  inputFromStoredDelegation,
  publishDelegation,
  buildDelegationDocument,
  describeDelegation,
  DELEGATION_DOCUMENT_NAME,
  type IntuitionChain,
  type IntuitionPinner,
  type CreatePreview,
} from '../../src/lib/intuition'
import type { DelegationStruct } from '../../src/lib/delegations'
import type { StoredDelegation } from '../../src/lib/storage'

const ZERO_PREVIEW: CreatePreview = { shares: 0n, assetsAfterFixedFees: 0n }

interface RecordedTriple {
  id: Hex
  subject: Hex
  predicate: Hex
  object: Hex
}

/** In-memory MultiVault: deterministic ids, tracks existence + what was created. */
function makeFakeChain(seed: Hex[] = []) {
  const terms = new Set<Hex>(seed.map((h) => h.toLowerCase() as Hex))
  const createdAtoms: Hex[] = []
  const createdTriples: RecordedTriple[] = []

  const atomId = (data: Hex): Hex => keccak256(data)
  const tripleId = (s: Hex, p: Hex, o: Hex): Hex => keccak256(concatHex([s, p, o]))
  const has = (id: Hex): boolean => terms.has(id.toLowerCase() as Hex)

  const chain: IntuitionChain = {
    getAtomCost: async () => 1n,
    getTripleCost: async () => 1n,
    calculateAtomId: async (data) => atomId(data),
    calculateTripleId: async (s, p, o) => tripleId(s, p, o),
    isTermCreated: async (id) => has(id),
    previewAtomCreate: async () => ZERO_PREVIEW,
    previewTripleCreate: async () => ZERO_PREVIEW,
    createAtom: async (data) => {
      const id = atomId(data)
      if (has(id)) throw new Error('atom exists')
      terms.add(id.toLowerCase() as Hex)
      createdAtoms.push(id)
      return id
    },
    createTriple: async (s, p, o) => {
      const id = tripleId(s, p, o)
      if (has(id)) throw new Error('triple exists')
      terms.add(id.toLowerCase() as Hex)
      createdTriples.push({ id, subject: s, predicate: p, object: o })
      return id
    },
  }
  return { chain, createdAtoms, createdTriples }
}

function makeFakePinner(): IntuitionPinner {
  const uri = (kind: string, name: string): string =>
    `ipfs://fake-${kind}-${keccak256(atomDataFromUri(name)).slice(2, 14)}`
  return {
    pinThing: async (t) => uri('thing', t.name),
    pinOrganization: async (o) => uri('org', o.name),
  }
}

const DELEGATOR = getAddress('0x1111111111111111111111111111111111111111')
const RECIPIENT = getAddress('0x2222222222222222222222222222222222222222')

const input = {
  delegator: { address: DELEGATOR, chainId: 84532 },
  recipient: { kind: 'caip10' as const, address: RECIPIENT, chainId: 84532 },
  organization: { name: 'intuition.box' },
  agreementUri: 'ipfs://bafyAgreement',
}

const testnet = getIntuitionNetwork('testnet')
// All three testnet predicates are now reused by term_id — `delegate to`'s
// canonical atom exists on the graph, so nothing is pin-created any more.
const reusedPredicates: Hex[] = [
  testnet.predicates.owns.termId as Hex,
  testnet.predicates.inContextOf.termId as Hex,
  testnet.predicates.delegateTo.termId as Hex,
]

describe('encoding', () => {
  test('caip10Uri is checksummed and well-formed', () => {
    expect(caip10Uri(1, '0x1111111111111111111111111111111111111111')).toBe(
      `caip10:eip155:1:${DELEGATOR}`,
    )
  })

  test('recipientUri: caip10 uses its own chain, atomWallet uses the Intuition chain', () => {
    expect(recipientUri({ kind: 'caip10', address: RECIPIENT, chainId: 8453 }, 13579)).toBe(
      `caip10:eip155:8453:${RECIPIENT}`,
    )
    expect(recipientUri({ kind: 'atomWallet', walletAddress: RECIPIENT }, 13579)).toBe(
      `caip10:eip155:13579:${RECIPIENT}`,
    )
  })
})

describe('delegation document', () => {
  const delegation: DelegationStruct = {
    delegate: RECIPIENT,
    delegator: DELEGATOR,
    authority: '0xff',
    caveats: [{ enforcer: DELEGATOR, terms: '0x00' }],
    salt: '0x01',
    signature: '0x02',
  }

  const details = { kind: 'subscription' as const, amount: '300', tokenSymbol: 'USDC', period: 'month' }

  test('name is generic — carries no amount/period', () => {
    const doc = buildDelegationDocument({ delegation, details })
    expect(doc.name).toBe('Hourglass delegation')
    expect(doc.name).toBe(DELEGATION_DOCUMENT_NAME)
    expect(doc.name).not.toMatch(/USDC|month|\d/)
  })

  test('description carries the human-readable specifics', () => {
    expect(describeDelegation(details)).toBe(
      'Subscription delegation using the erc20PeriodTransfer enforcer for an amount of 300 USDC / month.',
    )
    expect(describeDelegation({ kind: 'stream', amount: '1000', tokenSymbol: 'DAI', period: 'month' })).toBe(
      'Stream delegation using the erc20Streaming enforcer for an amount of 1000 DAI / month.',
    )
  })

  test('is a schema.org Thing that embeds the atomic delegation', () => {
    const doc = buildDelegationDocument({ delegation, details })
    expect(doc['@context']).toBe('https://schema.org')
    expect(doc['@type']).toBe('Thing')
    expect(doc.description).toBe(describeDelegation(details))
    expect(doc.delegation).toEqual(delegation)
  })
})

describe('network config', () => {
  test('reused testnet predicates are valid bytes32 term_ids', () => {
    for (const id of reusedPredicates) {
      expect(isHex(id)).toBe(true)
      expect(id.length).toBe(66)
    }
    // `delegate to` is reused by term_id too (its canonical atom is on the graph),
    // so no predicate needs the pin path — which Intuition now gates behind a key.
    expect(isHex(testnet.predicates.delegateTo.termId as Hex)).toBe(true)
  })

  test('multiVault + chain id are set per network', () => {
    expect(testnet.chainId).toBe(13579)
    expect(isHex(testnet.multiVault)).toBe(true)
  })
})

describe('publishDelegation', () => {
  test('builds the full nested-triple ontology', async () => {
    const { chain, createdTriples } = makeFakeChain(reusedPredicates)
    const result = await publishDelegation(
      { chain, pinner: makeFakePinner(), config: testnet },
      input,
    )

    // Reused predicates resolve to their configured term_ids (not re-created).
    expect(result.predicates.owns).toBe(testnet.predicates.owns.termId as Hex)
    expect(result.predicates.inContextOf).toBe(testnet.predicates.inContextOf.termId as Hex)
    expect(result.predicates.delegateTo).toBe(testnet.predicates.delegateTo.termId as Hex)

    // The context triple nests the relationship triple as its object.
    const ctx = createdTriples.find((t) => t.id === result.triples.context)
    expect(ctx?.object).toBe(result.triples.relationship)
    expect(ctx?.subject).toBe(result.atoms.delegationJson)
    expect(ctx?.predicate).toBe(result.predicates.inContextOf)

    // Relationship triple is (delegator, delegate to, recipient).
    const rel = createdTriples.find((t) => t.id === result.triples.relationship)
    expect(rel?.subject).toBe(result.atoms.delegator)
    expect(rel?.object).toBe(result.atoms.recipient)

    // Ownership triple is (organization, owns, delegator).
    const own = createdTriples.find((t) => t.id === result.triples.ownership)
    expect(own?.predicate).toBe(result.predicates.owns)
    expect(own?.object).toBe(result.atoms.delegator)
  })

  test('is idempotent: a second run creates nothing', async () => {
    const fake = makeFakeChain(reusedPredicates)
    const deps = { chain: fake.chain, pinner: makeFakePinner(), config: testnet }
    const first = await publishDelegation(deps, input)
    expect(first.created.length).toBeGreaterThan(0)

    const second = await publishDelegation(deps, input)
    expect(second.created).toEqual([])
    // Same terms resolved both runs.
    expect(second.triples).toEqual(first.triples)
    expect(second.atoms).toEqual(first.atoms)
  })

  test('omits the ownership edge when no organization is given', async () => {
    const { chain } = makeFakeChain(reusedPredicates)
    const result = await publishDelegation(
      { chain, pinner: makeFakePinner(), config: testnet },
      { ...input, organization: undefined },
    )
    expect(result.predicates.owns).toBeNull()
    expect(result.atoms.organization).toBeNull()
    expect(result.triples.ownership).toBeNull()
    // The delegation + relationship + context still publish.
    expect(result.triples.relationship).toBeTruthy()
    expect(result.triples.context).toBeTruthy()
  })

  test('reuses an existing organization atom by id (no new org atom)', async () => {
    const orgAtom = `0x${'ab'.repeat(32)}` as Hex
    const { chain, createdAtoms } = makeFakeChain([...reusedPredicates, orgAtom])
    const result = await publishDelegation(
      { chain, pinner: makeFakePinner(), config: testnet },
      { ...input, organization: { atomId: orgAtom } },
    )
    expect(result.atoms.organization).toBe(orgAtom)
    expect(result.triples.ownership).toBeTruthy()
    expect(createdAtoms).not.toContain(orgAtom) // reused, not created
  })

  test('throws when a configured reuse predicate is missing on-chain', async () => {
    const { chain } = makeFakeChain([]) // do not seed the reused predicates
    await expect(
      publishDelegation({ chain, pinner: makeFakePinner(), config: testnet }, input),
    ).rejects.toThrow(/not found on testnet/)
  })

  test('rejects a non-ipfs agreement URI', async () => {
    const { chain } = makeFakeChain(reusedPredicates)
    await expect(
      publishDelegation(
        { chain, pinner: makeFakePinner(), config: testnet },
        { ...input, agreementUri: 'https://example.com/agreement.json' },
      ),
    ).rejects.toThrow(/ipfs:\/\//)
  })
})

describe('inputFromStoredDelegation', () => {
  const base: StoredDelegation = {
    delegation: {
      delegate: RECIPIENT,
      delegator: DELEGATOR,
      authority: '0x',
      caveats: [],
      salt: '0x',
      signature: '0x',
    },
    meta: {
      label: 'Acme',
      scopeType: 'erc20SpendingLimit',
      createdAt: '2026-06-28',
      chainId: 84532,
      safeAddress: DELEGATOR,
      moduleAddress: DELEGATOR,
      status: 'signed',
      delegationHash: '0xabc',
      agreement: { cid: 'bafy', uri: 'ipfs://bafy', termsHash: '0xdef' },
      recipient: RECIPIENT,
    },
  }

  test('derives delegator/recipient/agreement from a stored delegation', () => {
    const out = inputFromStoredDelegation(base, { name: 'Acme' })
    expect(out.delegator).toEqual({ address: DELEGATOR, chainId: 84532 })
    expect(out.recipient).toEqual({ kind: 'caip10', address: RECIPIENT, chainId: 84532 })
    expect(out.agreementUri).toBe('ipfs://bafy')
  })

  test('throws without a pinned agreement URI', () => {
    const noAgreement: StoredDelegation = { ...base, meta: { ...base.meta, agreement: undefined } }
    expect(() => inputFromStoredDelegation(noAgreement, { name: 'Acme' })).toThrow(/agreement/)
  })
})
