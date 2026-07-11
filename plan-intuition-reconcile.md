# Plan — deterministic Intuition indexing (ADR 0005)

Goal: a multisig delegation is indexed on Intuition regardless of WHEN the Nth
owner signs, with nothing pinned or minted before finalization, and a backend
that can verify everything it publishes from public data alone.

Design decisions: `.claude/choices/0005-deterministic-indexing-mint-at-finalization.md`.
Read it first. On-chain delegation format never changes.

## Locked decisions (2026-07-11)

- **Monorepo.** All code stays in this repo. `src/lib` is the shared core
  (browser + server import the SAME functions — that is what guarantees a
  byte-identical hash on both sides). No second repo, no npm package.
- **Deployment: dedicated backend service (decision 1 option A).** The publisher
  (`/publish`) is deployed as its own Coolify service built from
  `server/Dockerfile`. The web container becomes static-only and no longer holds
  `INTUITION_ATTESTOR_PK` / `PINATA_JWT` — key isolation is the goal. The browser
  pokes cross-origin (CORS already handled in `server/cors.ts`).
- **No redeem watcher in v1.** Discovery is browser-only: on app open, the Safe
  App reads the connected Safe's messages from the Safe Transaction Service and
  reconstructs. The redeem watcher (a long-running chain scanner) is deferred to
  FUTURE.md — reintroducing it is what brings back the block-cursor question.
- **Nothing pinned or minted before finalization.** The browser precomputes ids;
  the backend pins + mints only after verifying finalization.
- **Org name out of the salt.** Terms commit to addresses (in the struct). The
  org name is graph metadata, resolved via GraphQL from the delegator (Safe)
  address at index/display time (`findOwningOrganization`).

## What does NOT change

The atom-creation mechanism is reused as-is: `ensureAtom`/`ensureTriple` +
`isTermCreated` guard (`publish.ts`), `calculateAtomId`/`createAtoms`
(`chain.ts`), `pinThing`/`pinOrganization` for org/predicate atoms. Only the
delegation atom switches to raw-bytes pinning. What changes: the document
contents, the pin method for the delegation atom, the timing, and who supplies
the data.

## Architecture (v1, no watcher)

```
┌ BROWSER (Safe App, static, no secret) ──────────────────────┐
│ propose:                                                    │
│   terms v2 (addresses only, sanitized token meta)           │
│   → salt → sign via Safe SDK → localStorage (UX only)       │
│   → precompute deterministic doc bytes → local CID → atomId │
│   (no pin, no mint)                                          │
│ on app open (finalize):                                     │
│   read Safe tx-service messages for the connected Safe      │
│   → reconstruct terms from the message typed data + chain   │
│   → keccak(terms)===salt → isTermCreated? → if final+absent │
│   → poke backend ────────────────────────────┐             │
└───────────────────────────────────────────────┼────────────┘
                                                 ▼
┌ BACKEND publisher (dedicated Coolify service, holds key) ───┐
│ POST /publish { chainId, safeAddress, messageHash,          │
│                 orgName? }   ← references only               │
│   verify: EIP-1271 isValidSignature on the Safe (app chain) │
│   reconstruct terms (shared src/lib) → keccak===salt        │
│   resolve org name via GraphQL from Safe addr (or orgName)  │
│   pin exact doc bytes (raw upload) → assert CID===precomputed│
│   isTermCreated guard → mint atom + triples                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Commit 1 — `feat(web): terms v2 (addresses only) + token sanitizer`

Files: `src/lib/subscriptionTerms.ts`, `src/lib/streamTerms.ts`,
new `src/lib/token-meta.ts` (sanitizer), `src/pages/CreateDelegation.tsx`,
`src/pages/CreateStream.tsx`.

- Bump `schema` to `...@2`.
- `terms.organization`: DROP the free-text `name`. Keep only the addresses
  (`recipient`, `delegate`) — both derivable from the delegation struct.
- `terms.amountPerPeriod`: derive via `formatUnits(periodAmountRaw, decimals)`,
  never the user's input string (align subscription with the stream flow).
- `token-meta.ts`: one `sanitizeTokenMeta({symbol,name,decimals})` — byte-length
  cap on symbol/name, strip non-printable/control chars, clamp decimals to a sane
  range. Applied in `buildTerms` now and reused verbatim by the backend
  `reconstruct` (commit 4). This is what keeps the salt reconstructible for a
  hostile token AND blocks injection / oversized-doc CID breakage
  (FUTURE.md security ticket — folded in here, not split out).
- Keep canonicalization untouched (sortDeep + JSON.stringify is deterministic).
- Tests (bun test, service): round-trip — given only
  `{ delegation struct, chainId, safeAddress, token metadata }`, rebuild terms
  and assert `hashTerms(rebuilt) === salt`. Cases: endDate null/set; user amount
  with trailing zeros (must not change the hash); hostile token (sanitizer makes
  browser and rebuild agree).

## Commit 2 — `feat(web): deterministic doc + local CID + precomputed ids`

Files: `src/lib/intuition/delegation-document.ts`, new `src/lib/intuition/cid.ts`,
`src/lib/intuition/publish.ts`, `src/lib/storage.ts`, both Create pages.

- `buildDelegationDocument`: drop `signature` and any wall-clock field
  (`createdAt`). Every field derived from terms v2 / the unsigned struct. The
  document's own serialization is canonical (reuse `canonicalize`). Doc `name`/
  `description` stay derived from amount/token/period (never the org name).
- `cid.ts`: local CIDv0 from raw bytes. **Verified recipe (live Pinata test,
  2026-07-11):** compute with `ipfs-only-hash` (`Hash.of(buf, {cidVersion:0})`)
  — it reproduces the UnixFS/dag-pb wrapping that `ipfs add` / Pinata apply, so
  the local CID equals Pinata's. Plain `multiformats` sha256 alone does NOT
  (missing the UnixFS wrap). Dep: `ipfs-only-hash` (small, purpose-built);
  justify in PR per ui.md bundle rule; lazy-import (only Create pages need it).
- At proposal: doc bytes → local CID → `atomId` (call `calculateAtomId` via RPC,
  or replicate `keccak(ATOM_SALT, keccak(data))` with the network's salt) →
  derive triple ids. No pin, no mint.
- `StoredDelegation.meta` additions: `safeMessageHash` (from `signTypedMessage`),
  `precomputed { docCid, atomId, tripleIds }`, `termsVersion: 2`. (No org name
  needed for indexing; keep it only if the UI wants to show it locally.)
- Remove the `offlinePin` fallback for the indexed path (pinning now happens
  server-side at mint; the browser never pins for indexing).
- Golden test (empirically confirmed 2026-07-11 — local CID === Pinata CID for
  the same 210-byte canonical doc; `pinJSONToIPFS` returned a DIFFERENT CID,
  proving it is unusable for precompute): fixed doc bytes → local CID === CID
  Pinata returns via `pinFileToIPFS` + `cidVersion:0` for a raw-bytes upload of
  the same content (recorded fixture; live test behind an env flag). This is the
  linchpin of the whole precompute scheme.

## Commit 3 — `feat(web): decouple publish from signing; finalize-on-open`

Files: `src/pages/CreateDelegation.tsx`, `src/pages/CreateStream.tsx`,
new `src/lib/safe-messages.ts`, new `src/lib/intuition/reconstruct.ts`,
new hook `src/hooks/useFinalizePending.ts`, `src/pages/Home.tsx`.

- Delete the `publishToIntuition(...)` call from both `handleSign` paths.
- `safe-messages.ts` (service, no React): Safe Transaction Service client — list
  a Safe's messages, read confirmations/threshold/`preparedSignature`. Chain →
  tx-service base URL map (web runs on Base Sepolia today).
- `reconstruct.ts` (service, pure TS, shared with the server): message typed data
  → delegation struct → terms v2 (sanitized token meta) → `hashTerms === salt`
  check → doc bytes → ids. Org name resolved separately via
  `findOwningOrganization(safeAddress)` (GraphQL, existing helper).
- `useFinalizePending`: on app open with a connected Safe, list that Safe's
  DelegationManager-domain messages, keep those with `confirmations >= threshold`,
  `isTermCreated(atomId)` RPC read, and poke the backend with references only
  (`{ chainId, safeAddress, messageHash }`, plus optional `orgName`/`orgAtomId`
  from meta for the `owns` edge). The `owns`-edge reconciliation checks the edge
  existence SEPARATELY from the delegation atom (see ADR pitfall) — a delegation
  already indexed by a co-signer must still get its `owns` edge when the proposer
  opens the app. Renders nothing; status on the existing Intuition status UI.
- localStorage records with `termsVersion < 2`: skipped (not retroactive).
- **User consent copy (UI):** in the create flow, below the org-name field,
  factual microcopy stating the org name + Safe address will be published
  publicly and permanently on Intuition once the delegation is signed and the
  app is reopened, and that the name is an unverified public claim. Per ui.md
  (no marketing, no emoji); optional consent checkbox. Org creation is
  dedup-by-name + EIP-1271-gated `owns` (self-scoped) per ADR 0005.

## Commit 4 — `feat(server): verify-then-mint publisher + dedicated deploy`

Files: `server/intuition-publisher.ts`, `src/lib/intuitionPublisher.ts`,
`server/Dockerfile`, root `Dockerfile` / `Caddyfile` (make web static-only),
`.env.example`.

- `/publish` accepts references only: `{ chainId, safeAddress, messageHash,
  orgName? }`. No document, no delegation payload, no signature from the client.
  The server:
  1. rate-limits, dedups by `messageHash`, consults a verdict cache BEFORE any
     outbound call (amplification guard),
  2. fetches the message from the Safe tx-service (discovery only); `chainId`
     must equal the message's EIP-712 `domain.chainId`,
  3. verifies the `preparedSignature` ON-CHAIN via EIP-1271 `isValidSignature`
     on the Safe (app chain — a second public client) — the actual mint gate,
  4. reconstructs terms v2 via the shared `reconstruct` service (sanitized token
     meta),
  5. `keccak256(canonicalize(terms)) === salt` — reject otherwise,
  6. resolves the org: `findOwningOrganization(safeAddress)`; else, if `orgName`
     supplied, create the Organization atom from it (best-effort, display-only —
     not salted, not security-critical); else index the org by CAIP-10 address,
  7. computes doc bytes (size-capped, single-block) + CID + ids, guards
     `isTermCreated` — if already created, still ensures the exact bytes are
     pinned (idempotent re-pin against a front-run dangling atom),
  8. pins the exact bytes (Pinata raw file upload, explicit cidVersion 0,
     rawLeaves/no-wrap — never `pinJSONToIPFS`, never `pinThing` for this atom),
     asserts returned CID === computed CID,
  9. mints atom + triples (`ensureAtom`/`ensureTriple`), under a daily TRUST
     budget circuit breaker WITH ALERT (economic-drain risk is accepted, but a
     drain must be noticed — see ADR 0005 amendment 2).
- Deploy split: the publisher becomes a standalone Coolify service
  (`server/Dockerfile`). The web container drops the in-container publisher +
  the `/intuition/*` reverse-proxy and stops receiving the attestor key.
  `VITE_INTUITION_PUBLISHER_URL` points at the dedicated service origin. PR
  previews must NOT carry the prod attestor key (point at a test-attestor
  publisher or none — auto-publish degrades gracefully).
- Tests: reconstruction fixtures (a real testnet message payload); salt-mismatch
  rejection; already-created no-op; EIP-1271 rejection of a forged confirmation
  set; sanitizer determinism (browser and server derive identical bytes for a
  hostile token).

## Commit 5 — separate repo: OurGlass-verifier

- Update `verify.ts` canonicalization to terms v2 (no org name in the salted
  terms) while keeping v1 verification for existing delegations. Stays pure: no
  RPC, no network at verify time (its security model).

## Commit 6 — `docs: indexing lifecycle`

- Update `spec/intuition/README.md` + `plan-intuition-storage.md` (Phase 4
  trigger superseded). `.env.example` for the dedicated service (tx-service URLs,
  publisher origin). Note the deferred redeem watcher in FUTURE.md.

## Verification protocol (per workflow.md)

- `bun run typecheck` after each web commit (user runs builds himself).
- `ui-reviewer` on commits 1–3; manual SDK check against Smart Accounts Kit docs
  for the typed-data reconstruction.
- End-to-end on testnet: propose with a 2-of-2 Safe, sign the SECOND owner LATER
  (new session), reopen the app on that Safe, confirm the atom appears; verify
  `salt === keccak256(terms)` from the published atom alone; confirm the org name
  resolves via GraphQL from the Safe address.

## Explicitly out of scope (v1)

- The redeem watcher (deferred to FUTURE.md — brings back the block cursor).
- Retroactive indexing of v1 delegations.
- Any change to the delegation struct, caveats, EIP-712 domain, or redeem flow.
- On-chain publication of delegations (would need its own ADR).
