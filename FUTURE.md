# Future work

Deferred ideas captured during tasks (per workflow rules — scope discipline).

- **Multi-token redeem stats.** `StatsRow` / `sumDisplay` on the Charge page sum
  claimable/claimed across token groups under a single hardcoded "USDC" label.
  Correct for the current USDC-centric POC (amounts are grouped per token with
  per-token decimals in `useClaimTotals`), but if non-USDC redeem becomes real,
  show per-token figures and the actual symbol instead of a single USDC headline.

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

  **Fix (per ADR 0005):** one canonical sanitizer in the service layer
  (byte-length cap on `symbol`/`name`, strip non-printable/control chars, clamp
  `decimals` to a sane range e.g. 0–36), applied IDENTICALLY at proposal
  (`buildTerms`) and at reconstruction (publisher). Because both sides derive
  the same sanitized value, the salt still matches — determinism preserved.
  Also independently valuable for the current UI even before indexing lands
  (vectors 2 and 3 already affect the live app's display and stored terms).
  PoC script: reproduce with `formatUnits(1_000_000n, 255)` and a
  `Buffer.byteLength` of a doc carrying `'A'.repeat(500_000)` as symbol.
