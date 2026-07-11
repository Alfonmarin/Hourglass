# 0005 — Deterministic delegation indexing: derivable terms, mint at finalization

**Status:** Accepted
**Date:** 2026-07-11
**Triggered by:** User request — multisig async-signing breaks Intuition indexing (data lost when a co-signer signs later); backend must not become an attack surface.

## Context

Intuition publishing is bolted to the in-session sign event (`publishToIntuition`
inline in `handleSign`). On a threshold > 1 Safe, `signTypedMessage` resolves after
the FIRST owner signs, returning only the `safeTxHash`. Three failures follow:

1. If the Nth owner signs later, nothing re-triggers the publish — the delegation
   is never indexed.
2. The published document embeds a placeholder signature (the safeTxHash), not the
   aggregated EIP-1271 signature.
3. The org selection and display details live only in React state — gone next day.

Constraints established during design:

- **Nothing minted before finalization.** Intuition atoms are permanent; minting
  at proposal publishes claims about delegations that may never be signed.
- **Nothing pinned before finalization.** A pin-on-propose endpoint is a free
  pinning service for attackers on our Pinata account.
- **No trust in the backend.** A compromised publisher must not be able to forge
  delegations or hold anything but a gas key. No private database.
- **On-chain format unchanged.** Same delegation struct, same
  `erc20PeriodTransfer` caveat, same EIP-712 domain, salt still
  `keccak256(canonicalize(terms))`.

Verified facts this decision rests on:

- Intuition term ids are content-addressed (`calculateAtomId(bytes)` /
  `calculateTripleId(...)` are pure), `isTermCreated` is a free read, creation
  reverts on duplicates. Pre-computing ids and minting later is sound.
- The pending Safe message on the Safe Transaction Service exposes the full
  EIP-712 typed data (delegate, delegator, salt, caveat terms bytes),
  `confirmations[]`, and `preparedSignature` once complete — public, keyed by
  Safe address.
- A redeem tx carries the full signed delegation in its calldata — a second,
  fully trustless finalization signal.
- Reconstruction audit: every `terms` field is derivable from the delegation
  struct + chain reads + constants EXCEPT `organization.name` (free text, hard
  blocker) and the `amountPerPeriod` display string (user-typed, soft blocker).
  The pinned wrapper's `createdAt` (wall clock) is also non-reproducible.
  Post-review precision: the org atom reference that replaces the free-text
  name is itself a user CHOICE, not derivable — it is verifiable against the
  salt but must be carried alongside the references (see decision point 6).
- `pinThing` (Intuition GraphQL) serializes server-side → its CID is not
  computable offline. Only self-controlled raw bytes have a locally computable
  CIDv0.

## Decision

Make the indexed delegation fully deterministic from public data, pre-compute its
ids at proposal, and move all pinning + minting to finalization.

1. **Terms v2 — every field derivable from public data.**
   - The `organization.name` free-text field is REMOVED from the salted terms
     (revised 2026-07-11, supersedes the earlier "reference the org atomId in
     terms" idea). Rationale: the name is a free user choice, absent from the
     on-chain delegation struct, so no reconstructor (co-signer browser, backend)
     can reproduce it — it made the salt non-reconstructible. The delegation
     commits to ADDRESSES (delegator/delegate), which are in the struct and
     already what carries on-chain authority; the name was only decorative in
     the salt. Terms v2 keep the addresses, drop the name.
   - The org NAME becomes graph metadata, not a cryptographic commitment. It is
     resolved at index/display time via GraphQL from the delegator (Safe)
     address — which IS in the struct — through the existing
     `findOwningOrganization`: `(Organization) —owns→ (delegator CAIP-10)`, then
     read `label` / `value.organization.name`. Confirmed live on testnet
     (Organization atoms populate both `label` and `value.organization.name`).
   - The `(Organization) —owns→ (delegator Safe)` edge is DECOUPLED from
     delegation indexing (decided 2026-07-11). Delegation indexing (atom +
     relationship + context triples) is deterministic and done by anyone from
     the Safe message. The `owns` edge is a separate assertion only the proposer
     can make (only they know their org): the proposer's browser ensures it
     exists using the org selection in localStorage, reconciled INDEPENDENTLY of
     whether the delegation atom already exists.
   - **Implementation pitfall (must handle):** reconciliation keyed only on
     `isTermCreated(delegationAtom)` would never attach the `owns` edge once a
     co-signer has indexed the delegation — the proposer would see "already
     indexed" and never re-poke, leaving the delegation permanently orphaned of
     its org. The proposer's reconciliation MUST check the `owns` edge existence
     separately and poke to create it when missing and an org is known.
   - Brand-new org (not yet on the graph): created BY THE PROPOSER at
     finalization (Organization atom by name, from localStorage) + the `owns`
     edge. Existing orgs are resolved from the graph (mandatory — option 2 via
     `findOwningOrganization`). Prefer reusing an existing Organization atom by
     `term_id` over recreating by name — duplicate same-label atoms exist
     (observed: two "intuition.box" atoms with distinct term_ids).
   - Consequence: for a brand-new org where a co-signer finalizes first, the
     delegation indexes immediately and the `owns` edge attaches later (eventual
     consistency) — no corruption, guards prevent double-mint; only the org link
     lags until the proposer opens the app.

   **Org creation policy (decided 2026-07-11).** OurGlass MAY mint a new
   Organization atom from a user-typed name (so anyone can create their org),
   under these bounds:
   - **Dedup by name first.** Search existing Organization atoms by label
     (`searchOrganizations`); reuse the existing `term_id` if found; mint a new
     atom only when the name is genuinely absent. Prevents duplicate spam.
   - **The `owns` edge is gated by EIP-1271** — the backend creates
     `(Org) —owns→ (Safe X)` ONLY after verifying on-chain a valid signed
     message from Safe X (the same gate as the delegation, amendment 1).
     Therefore the edge is always SELF-SCOPED: you can only assert org-ownership
     of a Safe that actually signed, i.e. your own. Nobody can assert ownership
     of a Safe they do not control. Without this gate the poke would let anyone
     claim any org owns any Safe — the gate is mandatory.
   - **Residual, accepted:** a user can put any (even impersonating) name on
     THEIR OWN org atom. This is inherent to Intuition's permissionless model —
     the name is an unverified claim, not proof of identity; staking/counter-
     triples/curation are the recourse, not OurGlass. The delegation's verified
     part is the ADDRESSES; the name is decorative graph metadata.
   - **Cost:** the attestor pays gas for org creation — the same accepted
     economic risk as delegation minting (amendment 2), under the budget +
     alert circuit breaker.

   **Creation timing (no watcher, v1).** The org atom + `owns` edge are created
   at finalize-on-open: someone opens OurGlass on the Safe AND the delegation
   message has reached threshold (fully signed, EIP-1271-verified). Signing
   alone mints nothing; redeem is NOT a trigger (watcher deferred). So the
   sequence is: propose (nothing minted) → sign to threshold → any owner opens
   the app → browser pokes → backend verifies + mints.

   **User consent (UI requirement — commit 3).** Because this publishes the org
   name + the Safe address to a PUBLIC, PERMANENT graph (atoms/triples cannot be
   unmade), the create flow must inform the user BEFORE they sign: that the
   org name they type and their Safe address will be published publicly on
   Intuition and are permanent, that it happens once the delegation is signed
   and the app is reopened, and that the name is an unverified public claim.
   Factual microcopy per the UI rules (no marketing, no emoji), optionally a
   consent checkbox.
   - Display amounts (`amountPerPeriod`) are derived canonically from the raw
     caveat value (`formatUnits(periodAmount, decimals)`), never from the user's
     input string. (The stream flow already does this.)
   - All other fields stay as they are (already derivable from caveats, chain
     reads, or constants).

2. **Deterministic DelegationJson document** (amends ADR 0004): keep the
   schema.org Thing wrapper, drop the `signature` and any wall-clock field
   (`createdAt`). Every byte of the document is derivable at proposal time, so
   its CIDv0 — computed locally, no pinning — and therefore the atom `term_id`
   and all triple ids are known before the first co-signature.

3. **Nothing is pinned or minted at proposal.** The browser computes the ids,
   stores them with the pending record (localStorage), and signs. If the
   delegation is never fully signed, the graph and IPFS stay clean.

4. **Finalization is detected via the Safe Transaction Service** (browser path on
   app open: message `confirmations >= threshold`, gated on-chain by EIP-1271).
   The redeem-based signal (decoding the signed delegation from
   `redeemDelegations` calldata) is a valid SECOND signal but requires a
   long-running chain watcher — deferred to v2 (FUTURE.md). v1 is browser-only.

5. **The publisher becomes verify-then-mint and accepts no content.** Its input
   is references only (`chainId`, `safeAddress`, `messageHash`, `orgAtomId` —
   or a redeem tx hash). It fetches the public data itself, reconstructs the
   terms, and mints only if `keccak256(canonicalize(terms)) === salt` and
   `isTermCreated(id) === false`. It pins the exact reconstructed bytes as a raw
   file upload (never `pinJSONToIPFS` re-serialization, never `pinThing`), so
   the pinned CID equals the precomputed one. A golden test asserts local CID ===
   Pinata CID for identical bytes.

6. **Red-team amendments (2026-07-11), integral to the decision:**
   - The mint gate for the tx-service path is an **on-chain EIP-1271
     `isValidSignature`** check of the `preparedSignature` against the Safe;
     tx-service confirmation counts are discovery only (a spoofed tx-service
     must not be able to index a never-signed delegation).
   - **Economic drain = accepted risk (user decision, 2026-07-11).** A curated
     org allowlist on the poke path was proposed and rejected: the mint key is
     funded incrementally and holds small amounts, so the worst case is a
     bounded, noticed loss — not fund theft. Residual controls: rate limit,
     messageHash dedup, verdict cache, and a daily TRUST budget circuit
     breaker with alert. Revisit before mainnet or meaningful funding.
   - The org is resolved from the delegator (Safe) ADDRESS, which is in the
     struct — no org reference travels in the poke, and the org name is not in
     the salt (see decision point 1, revised). (This supersedes an earlier
     amendment that carried `orgAtomId` in the poke — dropped once the name left
     the salt.)
   - Token `symbol`/`decimals` are attacker-deployable inputs: one **shared
     sanitizer** (length cap, printable-only, clamped decimals) is applied
     identically at proposal and reconstruction, preserving determinism while
     blocking injection and doc-size CID breakage.

## Alternatives considered

- **Mint "pending" markers at proposal** — rejected: atoms are permanent; a
  refused co-signature leaves false claims in a public graph forever.
- **Pin the agreement at proposal, mint later** — rejected: turns the publisher
  into an open pinning service; pin moves to finalization.
- **Keep the signature in the atom + reconcile later (keeper fetches
  `preparedSignature`)** — rejected: the atom id then depends on the final
  signature (not precomputable), and it publishes a re-executable signature into
  a public graph for no benefit; the signature is always recoverable on demand
  from the tx-service or redeem calldata.
- **`pinThing` for the delegation atom** — rejected: server-side serialization
  makes the CID unpredictable; determinism requires self-controlled bytes.
- **Private backend queue/database of pending delegations** — rejected by the
  no-backend-trust constraint; the Safe Transaction Service and the chain are
  the queue.

## Consequences

**Positive:**
- Multisig timing becomes irrelevant: indexing no longer depends on any browser
  session surviving until the Nth signature.
- Backend compromise is bounded to spam mints / refusal to mint — it can forge
  nothing (every mint is re-verifiable via `salt === keccak256(terms)`), holds
  only a gas key, stores nothing.
- Indexing is permissionless and idempotent: anyone can re-run it from public
  data; the publisher is a convenience, not a root of trust.
- No signature published in the knowledge graph.

**Negative:**
- **Not retroactive.** Existing delegations (v1 terms with free-text org names)
  cannot be reconstructed from public data and will not be re-indexed.
  Accepted by the user (2026-07-11).
- New delegations get different salt values (format unchanged, derivation
  input changed).
- The record on Intuition is no longer directly re-executable (amends ADR 0004's
  "recoverable + redeemable from the graph" property); re-execution fetches the
  signature from the Safe tx-service or a past redeem.
- The OurGlass-verifier must be updated in lockstep to canonicalize terms v2
  (keeping v1 support for old delegations).
- A delegation that is signed but never redeemed AND whose Safe never reopens
  the app is not indexed — accepted edge case.

**Neutral (worth knowing):**
- CIDv0 determinism is the linchpin: the golden test (local CID vs pinned CID on
  identical bytes) guards the whole precompute scheme.
- Browser path depends on tx-service availability; the redeem keeper does not.

## References

- Related rule: `.claude/rules/metamask-delegation.md`, `.claude/rules/security.md`
- Related ADR: `.claude/choices/0004-delegationjson-is-the-atomic-delegation.md` (amended)
- Plan: `plan-intuition-reconcile.md`
- Verifier: https://github.com/intuition-box/OurGlass-verifier
