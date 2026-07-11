# Future work

Deferred ideas captured during tasks (per workflow rules — scope discipline).

- **Multi-token redeem stats.** `StatsRow` / `sumDisplay` on the Charge page sum
  claimable/claimed across token groups under a single hardcoded "USDC" label.
  Correct for the current USDC-centric POC (amounts are grouped per token with
  per-token decimals in `useClaimTotals`), but if non-USDC redeem becomes real,
  show per-token figures and the actual symbol instead of a single USDC headline.

- **[v2] Redeem watcher — second, trustless finalization signal.** v1 indexes
  via the browser finalize-on-open path only (any Safe owner opening OurGlass
  reconstructs the delegation from the Safe Transaction Service and pokes the
  backend). Gap: a delegation signed AND redeemed but whose Safe never reopens
  the app is not indexed. A backend watcher scanning `DelegationManager`
  `redeemDelegations` on the app chain closes it — the calldata carries the full
  signed delegation, so it feeds the same verify-then-mint path with no trust in
  any Web2 API. Deferred because it is a long-running chain scanner (dedicated
  singleton process, reorg/receipt-status handling, and a block-cursor decision:
  stateless rescan-window vs persisted cursor). Reintroduce if the "used but
  never reopened" case proves real. Design context in ADR 0005.

- **[SECURITY] Unbounded token metadata (`symbol`/`name`/`decimals`) is a
  hostile input.** `readErc20Meta` (`src/lib/erc20.ts:43`) reads a custom
  token's `symbol`/`name`/`decimals` from the contract with no bounds, and they
  flow into the delegation terms (`CreateDelegation.tsx:239`,
  `CreateStream.tsx`) and into the pinned/indexed document. Any address can
  deploy a token that returns malicious values. Prerequisite for the
  deterministic-indexing work (ADR 0005 amendment 4): the shared sanitizer must
  exist before terms v2 ships.

  **Attack vectors (proof-of-concept run 2026-07-11, viem `formatUnits`):**
  1. **Oversized `symbol` → mint self-sabotage.** A 500 KB `symbol()` produces a
     ~977 KiB pinned document. IPFS single-block limit is 262144 bytes (256
     KiB); above it Pinata returns a multi-block DAG root CID that does NOT
     equal the single-block CIDv0 computed locally → the `CID === computed`
     assert fails → the delegation can never be indexed. Cheap, permissionless
     denial of indexing.
  2. **Stored injection.** `symbol = "<img src=x onerror=alert(document.cookie)>"`
     lands verbatim in the document `description`
     (`describeDelegation`) → `Recurring subscription: 100 <img src=x
     onerror=…>/month` → rendered by any consumer of the graph (Intuition
     portal, OurGlass showcase). Persistent XSS surface via the knowledge graph.
  3. **Absurd `decimals`.** `decimals() = 255` (readable via the `uint256`
     fallback in `readErc20Decimals`) turns `formatUnits(1e6, 255)` into a
     251-char `"0.000…"` string — a garbage `amountPerPeriod` display and a
     bloated terms field.

  **Fix (per ADR 0005):** one shared sanitizer (`src/lib/sanitize-text.ts` +
  `src/lib/token-meta.ts`, DONE) — byte-length cap on `symbol`/`name`, strip
  control + HTML-significant chars, clamp `decimals` to 0–36. Applied to the
  token metadata that enters the **Intuition document description** (commit 2),
  server-side and in any client that builds the description. This is
  Intuition-side only — it does NOT touch the salted terms or the signed struct
  (the earlier plan to sanitize inside `buildTerms` was dropped with the terms-v2
  revert). PoC (verified 2026-07-11): `formatUnits(1_000_000n, 255)` → 251-char
  string; a doc carrying `'A'.repeat(500_000)` as symbol → ~977 KiB.
