# Plan — deterministic Intuition indexing (ADR 0005)

Goal: a multisig delegation is indexed on Intuition regardless of WHEN the Nth
owner signs, with nothing pinned or minted before finalization, and a backend
that can verify everything it publishes from public data alone.

Design decisions are in `.claude/choices/0005-deterministic-indexing-mint-at-finalization.md`.
Read it first. On-chain delegation format never changes.

## Branch & sequencing

- **Branch:** `feat/deterministic-intuition-indexing` (off `main`).
- **PR:** one PR for the whole feature; commits below are atomic and land in
  order. Commit 6 (verifier) is a PR in the separate OurGlass-verifier repo,
  coordinated to merge with this one.

**Dependency order (each commit builds on the previous):**

```
1 terms v2 + sanitizer  ─┐  (defines the salt preimage everything else rebuilds)
                         ▼
2 deterministic doc + local CID + precomputed ids
                         ▼
3 decouple publish from signing + finalize-on-open (browser path)
                         ▼
4 verify-then-mint publisher (server path)  ── EIP-1271 gate, reconstruct
                         ▼
5 redeem watcher (server, trustless second signal)
   6 verifier repo (parallel, must ship with 1)   7 docs + .env.example
```

**Hard prerequisite:** the token-metadata sanitizer (FUTURE.md security ticket)
is built IN commit 1 — terms v2 cannot be deterministic without it. Do not
split it out.

**Reused-as-is (no rewrite):** `ensureAtom`/`ensureTriple` + `isTermCreated`
guard in `publish.ts`; `calculateAtomId`/`createAtoms` in `chain.ts`;
`pinThing`/`pinOrganization` for org/predicate atoms (only the delegation atom
switches to raw-bytes pinning). The atom-creation mechanism does not change —
only the document contents, the pin method for the delegation atom, the timing,
and who supplies the data.

## Commit 1 — `feat(web): terms v2, fully derivable from public data`

Files: `src/lib/subscriptionTerms.ts`, `src/lib/streamTerms.ts`,
`src/pages/CreateDelegation.tsx`, `src/pages/CreateStream.tsx`.

- Bump `schema` to `...@2`.
- `terms.organization`: replace free-text `name` with
  `{ atomId: <Intuition term_id>, recipient, delegate }`. The org picker already
  returns the atom id (`orgSelectionToInput`); it becomes part of the salted
  terms instead of UI-only state.
- `terms.amountPerPeriod`: derive via `formatUnits(periodAmountRaw, decimals)` —
  never the user's input string. (Stream flow already derives; align both.)
- New shared sanitizer for token `symbol`/`name`/`decimals` (byte-length cap,
  strip non-printables, clamp decimals) — security amendment 4. Lives in the
  service layer so the publisher's `reconstruct` (commit 4) reuses the exact
  same function.
- Keep everything else byte-identical in construction (sortDeep + JSON.stringify
  canonicalization is already deterministic).
- Tests (vitest, service layer): round-trip — given only
  `{ delegation struct, chainId, safeAddress, token metadata, org atomId }`,
  rebuild terms and assert `hashTerms(rebuilt) === salt`. Include: endDate null
  and set; amounts with trailing zeros typed by user (must not affect hash).

## Commit 2 — `feat(web): deterministic DelegationJson + local CID + precomputed ids`

Files: `src/lib/intuition/delegation-document.ts`, new `src/lib/intuition/cid.ts`,
`src/lib/intuition/publish.ts`, `src/lib/storage.ts`, both Create pages.

- `buildDelegationDocument`: drop `signature` and any wall-clock field; every
  field derived from terms v2 / the unsigned struct. Serialization of the
  document itself must be canonical (reuse `canonicalize`).
- `cid.ts`: local CIDv0 computation from raw bytes (dependency: `multiformats`
  — justify in PR per ui.md bundle rule; consider lazy import, only Create
  pages need it).
- At proposal: compute doc bytes → CID → `atomId = keccak-per-network` (call
  `calculateAtomId` via RPC or replicate with the network's ATOM_SALT), derive
  triple ids. No pin. No mint.
- `StoredDelegation.meta` additions: `orgAtomId`, `safeMessageHash` (from
  `signTypedMessage` result), `precomputed: { docCid, atomId, tripleIds }`,
  `termsVersion: 2`.
- Remove the `offlinePin` fallback for anything destined to Intuition (skill
  rule: no plain-string fallback; a doc that can't be pinned must fail loudly —
  but note pinning now happens at mint time, server-side, so the browser no
  longer pins at all for the indexed path).
- Golden test: fixed doc bytes → local CID equals the CID Pinata returns for a
  raw-bytes upload of the same content (recorded fixture; live test behind an
  env flag).

## Security amendments (red-team 2026-07-11 — non-optional)

A dedicated adversarial review of this design found four gaps. Their fixes are
folded into the commits below; they are requirements, not suggestions.

1. **EIP-1271 is the mint gate, not the tx-service.** `confirmations >=
   threshold` from the Safe Transaction Service is a Web2 signal — a
   compromised/spoofed tx-service could report a never-signed delegation as
   complete (the salt check does not protect: an attacker authors consistent
   fake typed data). Before minting, the publisher MUST verify the
   `preparedSignature` on-chain via `isValidSignature` on the Safe (app chain —
   needs a second public client; mind the nested domains: SafeMessage hash
   under the SAFE's domain wraps the delegation hash under the
   DelegationManager domain). Tx-service data is discovery only.
2. **Economic drain: ACCEPTED RISK (user decision, 2026-07-11).** Minting
   costs TRUST + gas, and anyone can mass-produce internally-consistent junk
   delegations from a 1-of-1 Safe and poke the endpoint. A curated org
   allowlist was proposed and REJECTED: the mint key is funded incrementally
   and holds small amounts — worst case is a bounded loss and a refill, not a
   fund-theft. The poke path stays open to everyone. Residual controls:
   rate limit + dedup + verdict cache (see below) and a daily TRUST budget
   circuit breaker WITH ALERT (so a drain is noticed, not silent). Revisit
   before mainnet or before funding the key with meaningful amounts.
3. **`organization.atomId` is verifiable but NOT derivable.** It is a user
   choice absent from the delegation struct — no finalization path can
   rediscover it reliably (and `owns`-graph pollution can make the search
   ambiguous). The poke therefore carries it: `{ chainId, safeAddress,
   messageHash, orgAtomId }` — non-forgeable, a wrong id fails the salt check.
   The redeem watcher does a bounded candidate search over org atoms linked to
   the recipient, tries each against the salt, and skips on none/ambiguous
   (documented limitation of redeem-only indexing).
4. **Canonical sanitizer for token metadata.** `symbol()`/`decimals()` come
   from attacker-deployable contracts (arbitrary bytes/length; injection into
   the pinned JSON and graph UIs; oversized docs break single-block CIDv0).
   One shared sanitizer (byte-length cap, strip non-printables, clamp
   decimals) applied IDENTICALLY in `buildTerms` and `reconstruct` — both
   sides derive the same sanitized value, so determinism survives. Cap total
   doc size to stay single-block.

Smaller hardening items (folded into commits 4–5): chainId is read from the
message's EIP-712 domain and must agree with the poke; rate-limit + dedup by
messageHash + verdict cache BEFORE any outbound fetch; redeem watcher waits N
confirmations and processes success receipts only, strict-decodes just the
known caveat shapes (try/skip); if `isTermCreated` is already true for one of
our doc atoms (front-run mint), still ensure the exact bytes are pinned —
idempotent re-pin heals dangling atoms. Note: with the open poke path
(amendment 2 rejected), the attestor will mint `(Organization) —owns→
(delegator)` triples for arbitrary users — graph-pollution risk accepted
alongside the economic one; Intuition's counter-triple/staking model is the
recourse.

## Commit 3 — `feat(web): decouple publish from signing; finalize-on-open`

Files: `src/pages/CreateDelegation.tsx`, `src/pages/CreateStream.tsx`,
new `src/lib/safe-messages.ts`, new `src/lib/intuition/reconstruct.ts`,
new hook `src/hooks/useFinalizePending.ts`, `src/pages/Home.tsx`.

- Delete the `publishToIntuition(...)` call from both `handleSign` paths.
- `safe-messages.ts` (service, no React): Safe Transaction Service client —
  list messages for a Safe, get confirmations/threshold/`preparedSignature`.
  Chain → tx-service base URL map (web runs on Base Sepolia today).
- `reconstruct.ts` (service): pending message typed data → delegation struct →
  terms v2 → `hashTerms === salt` check → doc bytes → ids. Shared by web and
  server (pure TS, no DOM).
- `useFinalizePending`: on app open with a connected Safe, list that Safe's
  DelegationManager-domain messages, filter `confirmations >= threshold`,
  check `isTermCreated(atomId)` (RPC read), and poke the publisher with
  references only (`chainId`, `safeAddress`, `messageHash`, `orgAtomId` from
  meta — security amendment 3) for each finalized-but-unindexed delegation. Renders nothing; status surfaces on the
  existing Intuition status UI.
- localStorage records with `termsVersion < 2`: skipped (not retroactive).

## Commit 4 — `feat(server): verify-then-mint publisher`

Files: `server/intuition-publisher.ts`, `src/lib/intuitionPublisher.ts`.

- `/publish` no longer accepts documents or delegation payloads. New input:
  `{ chainId, safeAddress, messageHash, orgAtomId }` (amendment 3). The server:
  1. rate-limits, dedups by messageHash, and consults the verdict cache BEFORE
     any outbound call (amplification guard),
  2. fetches the message from the Safe tx-service (discovery only); chainId
     must equal the message's EIP-712 `domain.chainId`,
  3. verifies the `preparedSignature` ON-CHAIN via EIP-1271
     `isValidSignature` on the Safe — the actual mint gate (amendment 1),
  4. reconstructs terms v2 via the shared `reconstruct` service (sanitized
     token metadata — amendment 4; org atom from the poke),
  5. verifies `keccak256(canonicalize(terms)) === salt` — reject otherwise,
  6. computes doc bytes (size-capped, single-block) + CID + ids, guards
     `isTermCreated` — if already created, still ensures the exact bytes are
     pinned (idempotent re-pin against front-run dangling atoms),
  7. pins the exact bytes (Pinata raw file upload, explicit cidVersion 0,
     rawLeaves/no-wrap — never `pinJSONToIPFS`, never `pinThing` for this
     atom), asserts returned CID === computed CID,
  8. mints atom + triples (existing `ensureAtom`/`ensureTriple` pattern),
     under the daily TRUST budget circuit breaker (alerting, amendment 2).
- Tests: reconstruction fixtures (a real testnet message payload), the salt
  mismatch rejection, the already-created no-op, the EIP-1271 rejection of a
  forged confirmation set, the sanitizer determinism (browser and server
  derive identical bytes for a hostile token).

## Commit 5 — `feat(server): redeem watcher`

Files: `server/` (same publisher process, interval job).

- Scan `DelegationManager.redeemDelegations` transactions on the app chain
  since last processed block (block cursor may be kept in memory/disk — losing
  it only causes re-scans, never trust issues; rescan window bounded).
- Wait N confirmations (reorg guard) and process `status === 'success'`
  receipts only. Strict-decode only the known caveat shapes
  (erc20PeriodTransfer / erc20Streaming), wrapped in try/skip — crafted
  calldata must never crash or mislead the watcher.
- Decode the signed delegation from calldata → same verify-then-mint path.
  Org resolution: bounded candidate search over org atoms linked to the
  recipient, each tried against the salt; skip on none/ambiguous
  (amendment 3). The salt check naturally filters foreign delegations from
  other apps sharing the DelegationManager.
- No allowlist here: an on-chain redeem is self-funding proof of use
  (amendment 2).
- Covers delegations that are used but whose Safe never reopens the app.

## Commit 6 — separate repo: OurGlass-verifier

- Update `verify.ts` canonicalization to accept terms v2 (org as atom
  reference) while keeping v1 verification for existing delegations.
- Stays pure: no RPC, no network at verify time (its security model).

## Commit 7 — `docs: indexing lifecycle`

- Update `spec/intuition/README.md` + `plan-intuition-storage.md` (Phase 4
  trigger is superseded by this design). Update `.env.example` if new env vars
  (tx-service URLs, watcher RPC) appear.

## Verification protocol (per workflow.md)

- `bun run typecheck` after each web commit (user runs builds himself).
- `ui-reviewer` agent on commits 1–3; manual SDK check against Smart Accounts
  Kit docs for the typed-data reconstruction.
- End-to-end on testnet: propose with a 2-of-2 Safe, sign the second owner
  LATER (new session), confirm the atom appears via (a) app reopen path and
  (b) keeper path with the app never reopened; verify `salt ===
  keccak256(terms)` from the published atom alone.

## Explicitly out of scope

- Retroactive indexing of v1 delegations.
- Any change to the delegation struct, caveats, EIP-712 domain, or redeem flow.
- On-chain publication of delegations (ADR would be required).
