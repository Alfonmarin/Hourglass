# Plan — async-safe Intuition indexing (ADR 0005)

Goal: a multisig delegation is indexed on Intuition regardless of WHEN the Nth
owner signs, with nothing pinned or minted before finalization, a backend that
verifies everything it publishes, and ZERO on-chain impact.

Design: `.claude/choices/0005-deterministic-indexing-mint-at-finalization.md`.
Read it first.

## Locked decisions (2026-07-11)

- **Only the Intuition indexing side is touched.** The salt, the signed
  delegation struct, the caveats, the signing flow, and the redeem flow are
  UNCHANGED. Flag explicitly if anything would reach the signed struct.
- **Index from the signed struct, recovered from the Safe tx-service.** No terms
  reconstruction (the struct is the source of truth; EIP-1271 is the check).
- **The document is unchanged (ADR 0004):** schema.org Thing + full signed
  delegation (signature included), pinned via `pinJSONToIPFS`. Keeping the
  signature preserves redeem-from-graph. Only token `symbol`/`name` in the
  description are sanitized.
- **One indexer: the backend.** Browsers only poke it → `pinJSONToIPFS` +
  `isTermCreated` are already idempotent. No canonicalization, no local CID, no
  `pinFileToIPFS`, no precompute (those are only for multi-indexer convergence).
- **Deployment: dedicated backend service** (decision 1 option A), web container
  static-only, attestor key isolated. Monorepo (all code in `src/lib` +
  `server/`).
- **No redeem watcher in v1** (deferred, FUTURE.md).

## Done

- **Sanitizer** (kept from the reverted terms-v2 work):
  `src/lib/sanitize-text.ts` (generic `cleanDisplayText`) +
  `src/lib/token-meta.ts` (`sanitizeTokenMeta`) + `test/unit/token-meta.test.ts`
  (10 tests). Not yet wired — commit 2 points it at the document description.

## Reverted (do not reintroduce without a new decision)

The first commit 1 changed the salted terms (dropped the org name, derived the
amount, bumped the schema). That was reverted — indexing does not need terms
reconstruction, and the salt is part of the signed struct. `subscriptionTerms.ts`,
`streamTerms.ts`, and the two Create pages are back to their original state.

## Commit 2 — `feat(web): sanitize token metadata in the delegation document`

Files: `src/lib/intuition/delegation-document.ts` (or the call sites that build
`DelegationDetails`), `server/intuition-publisher.ts` where the doc is built.

- Apply `sanitizeTokenMeta` to the token `symbol`/`name` before they enter the
  document `description` (`describeDelegation`) — the injection / doc-size defense
  from FUTURE.md. Pure Intuition-side; no salt, no struct.
- Tests: a hostile `symbol` (HTML / oversized) yields a sanitized, bounded
  description; a normal token is unchanged.

## Commit 3 — `feat(web): finalize-on-open — recover + poke from the Safe tx-service`

Files: `src/pages/CreateDelegation.tsx`, `src/pages/CreateStream.tsx`,
new `src/lib/safe-messages.ts`, new `src/lib/intuition/from-message.ts`,
new hook `src/hooks/useFinalizePending.ts`, `src/pages/Home.tsx`, `src/lib/storage.ts`.

- Remove the inline `publishToIntuition(...)` from both `handleSign` paths (that
  was the fragile in-session trigger). Persist what the poke needs in
  `StoredDelegation.meta`: `safeMessageHash`, and the org selection
  (`orgName`/`orgAtomId`) for the ownership edge.
- `safe-messages.ts` (service, no React): Safe Transaction Service client — list a
  Safe's messages, read `confirmations`/`threshold`/`preparedSignature`. Chain →
  tx-service base URL map (web runs on Base Sepolia today).
- `from-message.ts` (service, pure TS, shared with the server): a Safe message's
  typed data → the delegation struct → `DelegationDetails` decoded from the caveat
  (like `discover.ts`), token metadata sanitized. No terms, no salt check.
- `useFinalizePending` (hook — bridges lifecycle to the service): on app open with
  a connected Safe, list that Safe's DelegationManager-domain messages, keep
  `confirmations >= threshold`, and poke the backend with references only. The
  `owns`-edge reconciliation checks the edge existence SEPARATELY from the
  delegation atom (ADR pitfall). Renders nothing; status via the existing
  Intuition status UI.
- **User consent copy** below the org-name field (public + permanent publication,
  unverified claim), per ADR 0005 point 7 and ui.md.

## Commit 4 — `feat(server): verify-then-mint publisher + dedicated deploy`

Files: `server/intuition-publisher.ts`, `src/lib/intuitionPublisher.ts`,
`server/Dockerfile`, root `Dockerfile`/`Caddyfile` (web static-only), `.env.example`.

- `/publish` accepts references only: `{ chainId, safeAddress, messageHash,
  orgName?/orgAtomId? }`. No document, no delegation payload from the client.
  The server:
  1. rate-limits, dedups by `messageHash`, consults a verdict cache BEFORE any
     outbound call,
  2. fetches the message from the Safe tx-service; `chainId` must equal the
     message's EIP-712 `domain.chainId`,
  3. verifies the `preparedSignature` ON-CHAIN via EIP-1271 `isValidSignature`
     on the Safe (app-chain public client) — the mint gate,
  4. builds the document from the struct via the shared `from-message` service
     (sanitized token metadata),
  5. resolves the org: `findOwningOrganization(safeAddress)`; else, if a name is
     supplied, dedup-by-name then create; else index without the `owns` edge,
  6. pins via `pinJSONToIPFS`, computes the atom id, guards `isTermCreated`,
  7. mints atom + triples (`ensureAtom`/`ensureTriple`), under the daily TRUST
     budget circuit breaker with alert.
- Deploy split: publisher becomes its own Coolify service (`server/Dockerfile`);
  the web container drops the in-container publisher + the `/intuition/*` proxy
  and no longer holds the attestor key. `VITE_INTUITION_PUBLISHER_URL` points at
  the dedicated service. PR previews must NOT carry the prod attestor key.
- Tests: EIP-1271 rejection of a forged confirmation set; already-created no-op;
  the from-message decode fixtures (a real testnet message payload); sanitizer in
  the description.

## Commit 5 — `docs`

- Update `spec/intuition/README.md` + `plan-intuition-storage.md`; `.env.example`
  for the dedicated service. Note the deferred redeem watcher in FUTURE.md.

## Testing strategy (unit here, then testnet, then mainnet)

1. **Unit (here):** the sanitizer (done); the from-message decode (struct →
   details) against fixtures; the EIP-1271 verify path (mock the Safe client);
   the backend idempotency (isTermCreated guard).
2. **Testnet end-to-end:** propose with a 2-of-2 Safe, sign the SECOND owner
   LATER (new session), reopen the app on that Safe, confirm the atom + triples
   appear; confirm redeem-from-graph still works (signature intact); confirm a
   forged/incomplete message is rejected by EIP-1271.
3. **Mainnet:** only after testnet is validated end-to-end.

## Explicitly out of scope (v1)

- The redeem watcher (deferred to FUTURE.md).
- Any change to the salt, the signed delegation struct, caveats, signing, or
  redeem.
- Canonicalization / local CID / precompute (only if a second indexer appears).
