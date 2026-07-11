# 0004 — DelegationJson document: schema.org Thing wrapper + `delegation` field

**Status:** Accepted
**Date:** 2026-06-28
**Triggered by:** User decision during Phase 2 live validation of `spec/intuition/README.md`.

## Context

The spec described the `DelegationJson` atom as reusing the human-readable
**agreement** OurGlass already pins (the `terms` document). During live testing we
settled what the document should actually contain. Two requirements emerged:

1. **The Intuition GraphQL indexer must parse human-readable metadata.** The
   indexer only populates `atom.value.thing.{name,description,image,url}` when the
   pinned JSON is a **schema.org Thing** (`@context: https://schema.org`,
   `@type: Thing`). A raw JSON object (no schema.org markers) indexes as
   `type: JsonObject` with `value.thing = null`.
2. **The atomic signed delegation must be recoverable and re-executable** from the
   same document — but the delegation object itself stays **atomic** (not enriched
   with semantic fields). All relationship semantics live in the triples
   (`owns`, `delegate to`, `in context of`), not inside the document.

## Decision

The `DelegationJson` document is a **schema.org Thing with an extra `delegation`
field**:

```json
{
  "@context": "https://schema.org",
  "@type": "Thing",
  "name": "OurGlass delegation — 300 USDC/month",
  "description": "Recurring ERC20 subscription: 300 USDC/month …",
  "image": "",
  "url": "https://ourglass.intuition.box/",
  "delegation": { "delegate", "delegator", "authority", "caveats": [{ "enforcer", "terms" }], "salt", "signature" }
}
```

- Pinned to IPFS via Pinata (`pinJSONToIPFS`); the `ipfs://` URI is the atom data.
- The Thing fields give the indexer something to parse → `value.thing` populated,
  so a UI can show name/description from GraphQL alone.
- The `delegation` field carries the atomic, re-executable delegation. It is NOT
  enriched with context — semantics are the triples.

## Validation (testnet 13579, live)

Built a genuine `erc20PeriodTransfer` delegation via the SDK, signed EIP-712 with
the attestor key, pinned the Thing+delegation document, published the ontology,
then round-tripped:

- `atom.type = Thing`; `value.thing = { name, description, url }` parsed by the
  indexer (after a short lag — see below).
- IPFS fetch of `atom.data` returns the document with the `delegation` field
  intact.
- `recoverTypedDataAddress` on `delegation.signature` returns the delegator
  (`0x66Dbd2…050E`) — the stored delegation is re-executable, not just archived.

### Indexer lag note

For a Pinata-pinned document, `value.thing` is **not** populated instantly — the
indexer must fetch the CID off IPFS and classify it (observed: seconds, sometimes
longer). `atom.data` (the `ipfs://` URI) is available immediately, so the
IPFS-fetch path works at once; only the indexed `value.thing` convenience view
lags. Do not treat a null `value.thing` right after creation as "not a Thing" —
poll, or fetch IPFS directly. (Consistent with the discovery-vs-truth split in
ADR 0003.)

## Consequences

**Positive:**
- GraphQL alone yields a display label (`value.thing.name`/`description`) without
  an IPFS round-trip — good for list/showcase rendering.
- The full delegation is recoverable + redeemable from the graph + IPFS, no
  `localStorage`.
- No semantic duplication: the document's prose is display-only; meaning is in the
  triples.

**Negative / to handle later:**
- The structured terms (rate/period/parties/end date) live inside the encoded
  caveat `terms`, not as document fields. If the showcase needs them as data,
  decode the caveat on-chain or add explicit fields. Decide per Phase 4.
- Right-after-write reads must tolerate `value.thing = null` (indexer lag).

## Supersedes

The spec line "DelegationJson reuses the agreement OurGlass already pins to IPFS":
the atom now points at a purpose-built Thing-wrapped document embedding the atomic
delegation.

## References

- Spec: `spec/intuition/README.md`
- ADR: `.claude/choices/0003-intuition-testnet-predicate-reuse.md`
- Service: `src/lib/intuition/` (treats the pinned URI as opaque — no code change needed)
