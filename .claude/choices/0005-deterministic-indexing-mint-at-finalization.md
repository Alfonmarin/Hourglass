# 0005 — Async-safe delegation indexing: reconstruct from the Safe tx-service, mint at finalization

**Status:** Accepted
**Date:** 2026-07-11
**Triggered by:** User request — multisig async-signing breaks Intuition indexing (the indexing data is lost when a co-signer signs the next day); the backend must not become an attack surface.

> This ADR was substantially rewritten on 2026-07-11 after a long design
> conversation removed several layers of over-engineering. Earlier drafts (and
> the first version of commit 1) changed the salted terms and dropped the
> signature from the document; both were reverted. See "What we tried and
> dropped" below. The final design touches ONLY the Intuition indexing side.

## Context

Intuition publishing is bolted to the in-session sign event (`publishToIntuition`
inline in `handleSign`). On a threshold > 1 Safe, `signTypedMessage` resolves
after the FIRST owner signs, returning only the `safeTxHash`. Three failures
follow:

1. If the Nth owner signs later, nothing re-triggers the publish — the delegation
   is never indexed.
2. The stored signature at that moment is a placeholder (the safeTxHash), not the
   aggregated EIP-1271 signature.
3. The org selection lives only in React state / localStorage — gone next day.

Constraints established during design:

- **Only the Intuition indexing side may be touched.** Nothing that changes the
  signed on-chain delegation struct, the caveats, the salt, the signing, or the
  redeem flow. (See `.claude/rules` and the memory `onchain-untouchable`.)
- **Nothing minted before finalization.** Intuition atoms are permanent; minting
  at proposal publishes claims about delegations that may never be signed.
- **Nothing pinned before finalization.** A pin-on-propose endpoint is a free
  pinning service for attackers on our Pinata account.
- **No trust in the backend.** A compromised publisher must be able to forge
  nothing and hold nothing but a gas key. No private database.

Verified facts this decision rests on:

- The pending Safe message on the Safe Transaction Service exposes the full
  EIP-712 typed data — which IS the delegation struct (delegate, delegator,
  authority, caveats, salt) — plus `confirmations[]` and the aggregated
  `preparedSignature` once complete. Public, keyed by Safe address.
- The delegation struct is therefore fully recoverable from public data. The
  human-readable details (amount, token, period) are decodable from the caveat
  bytes (as `discover.ts` already does). **No terms reconstruction is needed** —
  the struct is the source of truth.
- Intuition term ids are content-addressed; `isTermCreated` is a free read;
  `createAtoms`/`createTriples` revert on duplicates. So a single indexer is
  idempotent by construction.
- `pinJSONToIPFS` returns the same CID for the same object across calls (verified
  live), but a DIFFERENT CID if the key order differs (also verified). This only
  matters if two DIFFERENT code paths build the document — which does not happen
  in v1 (one indexer, below).

## Decision

Index a delegation from its **signed struct**, recovered from the Safe
Transaction Service, and move the trigger + minting to finalization. The salt,
the terms, the struct, and the redeem flow are untouched.

1. **The document is unchanged (ADR 0004 stands).** The `DelegationJson` atom is
   still the schema.org Thing carrying the full signed delegation (signature
   included), pinned via `pinJSONToIPFS`. Keeping the signature preserves the
   existing redeem-from-graph path (`discover.ts` reads the signature to let an
   org redeem). The only content change: the token `symbol`/`name` that flow into
   the document `description` are sanitized (injection / size defense) — see
   point 4.

2. **One indexer: the backend.** The backend `/publish` is the ONLY minter (it
   holds the attestor key). Browsers only POKE it. Because there is a single
   indexer building the document with one code path, the same delegation always
   yields the same object → the same CID → the same atom, and `isTermCreated`
   dedups. No canonicalization, no local-CID precompute, no `pinFileToIPFS` —
   those are only needed for multi-indexer convergence, which v1 does not have.

3. **Finalize-on-open trigger (no watcher in v1).** On app open with a connected
   Safe, the browser lists that Safe's DelegationManager-domain messages from the
   Safe tx-service, keeps those at `confirmations >= threshold`, and pokes the
   backend with references only (`chainId`, `safeAddress`, `messageHash`, plus an
   optional `orgName`/`orgAtomId` for the ownership edge). The inline
   `publishToIntuition` call at sign time is removed. Nothing is pinned or minted
   at proposal. If the delegation is never fully signed, the graph stays clean.
   The redeem-based signal (a chain watcher decoding `redeemDelegations`
   calldata) is a valid SECOND trigger but is deferred to v2 (FUTURE.md).

4. **The backend is verify-then-mint and accepts no content.** Input: references
   only. It fetches the Safe message itself, and:
   - **Verifies the `preparedSignature` ON-CHAIN via EIP-1271
     `isValidSignature`** on the Safe (app chain). This is the trust gate — a
     spoofed/compromised tx-service cannot make it index a never-signed
     delegation. Confirmation counts are discovery only. (This replaces any
     `keccak(terms)===salt` check, which is redundant: EIP-1271 already proves
     the Safe signed this exact struct.)
   - Builds the same document, resolves the org (point 5), pins via
     `pinJSONToIPFS`, computes the atom id, and mints guarded by `isTermCreated`.
   - Sanitizes token `symbol`/`name` with the shared `sanitizeTokenMeta`
     (cap length, strip control + HTML-significant chars, clamp decimals) before
     they enter the document.

5. **Organization / `owns` edge.**
   - **Ontology unchanged (decided 2026-07-11).** Only the OrgPicker `org` (the
     org that OWNS the payer's Safe) is minted as a named Organization atom, and
     only if the user selects one (optional). The payee is its recipient CAIP-10
     address atom, UNNAMED. We keep exactly this — no payee naming added.
   - Two distinct names must not be confused: `terms.organization.name`
     (the free-text "payee" label, `payeeName`) is IN THE SALT and stays in the
     local label — it plays NO role in indexing and never reaches the graph. The
     Intuition Organization atom is driven by the separate OrgPicker selection
     (`org`), graph metadata, never the salt.
   - The org name is NOT needed to index the delegation (the delegation commits
     to addresses; the org is graph metadata).
   - **Org resolution is ADDRESS-first, name-second:**
     1. **By Safe address (primary, deterministic):**
        `findOwningOrganization(safeAddress)` follows the `owns` edge from the
        Safe's CAIP-10 atom → `(Organization) —owns→ (delegator CAIP-10)` →
        `label` / `value.organization.name`. If the Safe is already linked to an
        org, reuse it.
     2. **By name (only when creating a genuinely new org):** an Organization
        atom has NO address field (name/url/… only), so it is content-addressed
        on its content — the only way to dedup an atom is by name. So dedup by
        name (`searchOrganizations`, reuse `term_id` if present) applies ONLY on
        the create path, after the address lookup found nothing.
   - OurGlass MAY mint a new Organization atom from a user-typed name (so anyone
     can create their org), bounded by: the name dedup above; the **`owns` edge
     is EIP-1271-gated** so it is always SELF-SCOPED (you can only assert
     ownership of a Safe that actually signed — your own); residual
     name-impersonation is inherent to Intuition's permissionless model
     (staking/curation is the recourse, not us); the attestor pays gas (accepted
     economic risk, below).
   - The `owns` edge is DECOUPLED from delegation indexing: the delegation
     indexes from the struct by the backend regardless; the `owns` edge is a
     separate assertion the proposer's browser drives (it has the org). Pitfall:
     reconciliation must check the `owns` edge existence SEPARATELY from
     `isTermCreated(delegationAtom)` — otherwise, once a delegation is indexed,
     the proposer would never re-poke and the `owns` edge would never attach.
     Brand-new org where a co-signer indexes first → delegation indexes now,
     `owns` edge attaches when the proposer opens the app (eventual consistency,
     no corruption).

6. **Economic drain = accepted risk (user decision).** No curated allowlist on
   the poke path — the mint key is funded incrementally and holds small amounts,
   so the worst case is a bounded, noticed loss, not fund theft. Residual
   controls: rate limit, `messageHash` dedup, verdict cache, and a daily TRUST
   budget circuit breaker WITH ALERT. Revisit before mainnet or meaningful
   funding.

7. **User consent (UI, commit with the create flow).** Indexing publishes the org
   name + Safe address to a PUBLIC, PERMANENT graph. Before signing, the create
   flow must tell the user, factually (no marketing, no emoji), that the org name
   and Safe address will be published publicly and permanently on Intuition once
   the delegation is signed and the app is reopened, and that the name is an
   unverified public claim. Optionally a consent checkbox.

## Edge cases (v1, accepted)

- **Nobody reopens the app** — a delegation signed but whose Safe never reopens
  OurGlass is NOT indexed in v1. The deferred redeem watcher (v2) would catch it
  from an on-chain redeem. Accepted.
- **Brand-new org, a co-signer finalizes first** — the delegation indexes
  immediately (from the struct); the `(Organization) —owns→ (Safe)` edge attaches
  later, when the proposer (who has the org selection in localStorage) reopens
  the app. Eventual consistency, no corruption — `isTermCreated`/`ensureTriple`
  guards prevent duplicates. Reconciliation must check the `owns` edge existence
  SEPARATELY from the delegation atom, or the edge would never attach.
- **Safe tx-service unavailable** — finalize-on-open simply retries on the next
  app open; nothing is lost (the message stays in the tx-service).
- **Duplicate same-label org atoms exist** (observed: two "intuition.box" atoms
  with distinct term_ids) — always resolve/reuse by `term_id`, never by label
  string. Address-first resolution (via the `owns` edge) avoids the ambiguity for
  an already-linked Safe.
- **Indexing vs redeem** — indexing is a registry/discovery convenience. The
  org's redeem path (`discover.ts`) reads the signed delegation from the graph,
  so a delegation that was never indexed is not discoverable there until someone
  reopens the app and it gets indexed (the "nobody reopens" case above). This is
  a discovery limitation, not a fund-safety one.

## What changes vs. what does not

**Changes (all Intuition-side):** the publish trigger (finalize-on-open,
reconstructing from the tx-service); the backend becomes verify-then-mint with an
EIP-1271 gate and references-only input; token metadata is sanitized in the
document; org resolution/creation policy.

**Unchanged:** the salt, the signed delegation struct, the caveats, the signing
flow, the redeem flow, the document shape (ADR 0004, signature included), and the
pin mechanism (`pinJSONToIPFS`). Zero on-chain impact.

## What we tried and dropped (kept for the record)

- **Terms v2 / drop the org name from the salt** — reverted. It changed the salt
  value of the signed struct (an on-chain field) to make the terms
  reconstructible, but indexing does not need terms reconstruction: the signed
  struct is available from the tx-service and EIP-1271-verified. The salt change
  bought nothing and touched the signed struct. The sanitizer built alongside it
  is kept (repointed to the document).
- **Drop the signature from the document** — rejected: it would break the
  redeem-from-graph path (`discover.ts` reads `delegation.signature` so an org
  can redeem). The signature stays in the document.
- **Deterministic document + local CIDv0 + precompute at proposal +
  `pinFileToIPFS` + golden test** — dropped: these guarantee cross-indexer CID
  convergence, needed only if multiple independent code paths mint. v1 has one
  indexer (the backend), so `pinJSONToIPFS` + `isTermCreated` are already
  idempotent. Reintroduce IF a second indexer appears (e.g. the v2 redeem
  watcher, or a browser that pre-computes atom ids) — then canonicalize the
  bytes and pin them with `pinFileToIPFS`.
- **Mint / pin at proposal** — rejected: atoms are permanent and pinning is an
  attack surface; both move to finalization.
- **Private backend queue/DB of pending delegations** — rejected: the Safe
  Transaction Service is the queue; the backend stays stateless.

## Consequences

**Positive:**
- Multisig timing becomes irrelevant: indexing recovers the signed struct from
  the tx-service whenever any owner opens the app, not from a fragile in-session
  event.
- Zero on-chain impact — the signed struct, salt, and redeem are untouched.
- Backend compromise is bounded to spam/refusal: EIP-1271 verification means it
  cannot index a delegation the Safe did not sign; it holds only a gas key and
  stores nothing.
- Much smaller change set than the earlier drafts.

**Negative:**
- The browser path depends on Safe tx-service availability (per chain). A
  delegation that is signed but whose Safe never reopens the app is not indexed
  in v1 (the deferred redeem watcher would close this).
- The attestor pays gas (accepted economic risk).
- Not retroactive in the sense that delegations signed but never re-opened before
  this ships are only indexed once someone reopens the app on their Safe.

**Neutral (worth knowing):**
- `pinJSONToIPFS` is order-sensitive; safe here only because one indexer builds
  the document. This assumption must be revisited if a second indexer is added.

## References

- Related rule: `.claude/rules/metamask-delegation.md`, `.claude/rules/security.md`
- Related ADR: `.claude/choices/0004-delegationjson-is-the-atomic-delegation.md` (unchanged — signature stays in the document)
- Plan: `plan-intuition-reconcile.md`
- Verifier: https://github.com/intuition-box/OurGlass-verifier
