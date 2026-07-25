# DCA — strict implementation plan

> First strategy of the Strategy tab: a non-custodial DCA mandate. Then a range
> variant, then customizable client offers. Grounded in the Uniswap
> `swap-integration` skill, the repo `.claude/rules/`, and the current repo state.
> Companion: [`STRATEGY_IMPLEMENTATION_PLAN.md`](STRATEGY_IMPLEMENTATION_PLAN.md),
> [`UNISWAP_STRATEGY_CATALOGUE.md`](UNISWAP_STRATEGY_CATALOGUE.md),
> [`HOURGLASS_STRATEGIES.md`](HOURGLASS_STRATEGIES.md).

## Product target — everything from a Safe

Hourglass targets **Safes with large treasuries** (DAOs, companies) that cannot
automate on-chain investing themselves. The offer: the multisig approves **one
bounded mandate** (quorum signs once), and an agent trades inside that envelope
**without ever re-quoruming the owners or holding any funds**.

This is not marketing — it constrains the design (verified against the repo):

- **Delegator is always the Safe** (its DeleGator module, `from: moduleAddress`).
  No EOA, no intermediary account. Everything moves from the Safe and returns to it.
- **Signature is multisig**: the mandate activates only when the Safe's threshold
  of owners signs (`sdk.txs.signTypedMessage` → aggregated EIP-1271). One signature
  event, not one per trade.
- **The agent only triggers**: at redeem, `DelegationManager.redeemDelegations`
  executes *as the Safe*; the agent (`account.address`) merely submits the tx and
  pays gas — it never custodies funds (verified `scripts/yield-agent.ts:77-83`,
  `yieldDelegations.ts:49`).
- **Non-custodial is non-negotiable** for this target: a large treasury's owners
  will not let funds transit an agent account. Hence `erc20BalanceChange` (funds
  never leave the Safe), not a funding-transfer rail.

Every decision below serves this: one quorum-signed, Safe-rooted, non-custodial
mandate; the agent trades bounded, the treasury stays put.

## Scope

- **In:** DCA mandate (one funding token → one target token, bounded per swap),
  then a range variant (buy < X / sell > Y). Then decline into customizable offers.
- **Out:** copy-trade (dropped), index, LP (Yield rail), Intuition discovery
  (deferred), the agent scheduler UI (colleague's page).
- **Boundary:** we write only our files; the one shared file we touch is
  `src/config/` (additive Universal Router addresses). Do not modify the
  colleague's `yieldDelegations.ts` / `Yield.tsx` / `yield-agent.ts`.

## Constraints from `.claude/rules/`

- **`code.md`**: three layers — services (`src/lib`, no React, no UI), hooks
  (bridge), presentation (`src/pages`, no direct chain calls). `strict: true`, no
  `any` (use `unknown` + narrow), no default exports, `kebab-case.ts` files /
  `PascalCase.tsx` components, no dead code, tests are part of the code.
- **`metamask-delegation.md`**: use the SDK scope builder, no custom enforcers.
  `salt = keccak256(terms)`; terms computed once, never modified after signing.
  Never reuse a signature across chains/terms.
- **`security.md`**: validate every input at the boundary; never commit keys; the
  Trading API key is server/agent-side only, never a `VITE_` var.
- **`workflow.md`**: conventional + atomic commits; tests ship with the feature;
  run typecheck/tests before done; end the branch with a complete PR.

## Current repo state (verified)

- **Enforcer**: `erc20BalanceChangeEnforcer` is registered via the merged
  `HourGlassEnforcers` suite (`src/config/addresses.ts`). Prerequisite met.
- **Signing primitives to reuse** (generic core, NOT the colleague's structure):
  `predictAddress` (module) → `getEnvironment(chainId)` → `createDelegation` →
  `buildDelegationTypedData` + `sdk.txs.signTypedMessage`. **Do not copy his
  multi-delegation shape:** yield signs a **loop of 3** single-use delegations
  (approve/approve/mint) because its calldata is fixed; DCA signs **ONE** reusable
  delegation. The loop and the 3-call bundle are yield-specific — we take the
  per-delegation primitives, not the bundle.
- **Storage**: `StoredDelegation` + `buildStored…Plan` pattern
  (`yieldDelegations.ts:104-149`), reuses `scopeType: 'custom'` +
  `targetAddress`/`methodSelector`/`calldataArgs`.
- **Redeem**: `src/lib/redeemDirect.ts` `buildRedeemTx`; agent scaffold
  `scripts/yield-agent.ts`.
- **Missing**: Universal Router addresses are NOT in config yet.
- **Swap execution** (skill): Trading API `/check_approval` → `/quote` (force
  `routingPreference: "CLASSIC"`) → `/swap` returns `{ to: UniversalRouter, data:
  execute(...), value }`. Needs an `x-api-key`.

## The DCA mandate (recap, verified)

One delegation. delegator = Safe (via its DeleGator module). delegate = agent.

```
scope: functionCall
  targets:   [fundingToken, UNIVERSAL_ROUTER]
  selectors: ['approve(address,uint256)', 'execute(bytes,bytes[],uint256)']
caveats:
  erc20BalanceChange { tokenAddress: fundingToken, recipient: Safe,
                       changeType: Decrease, balance: capPerSwap }
  valueLte: 0n
salt: keccak256(terms)
```

Non-custodial: funds never leave the Safe; the swap runs *as* the Safe; the bought
token returns to the Safe. Cadence + price condition live in the agent (off-chain).

## Ordered steps

### Step 1 — config: Universal Router (additive, low risk)
- **File:** `src/config/uniswap.ts` (colleague's — additive only; or a new
  `src/config/swap-router.ts` if we prefer zero-touch on his file — DECISION §Open).
- Add `UNIVERSAL_ROUTER: Record<number, Address>` for our target chains (Base
  `0x6ff5693b99212da76ad316178a184ab56d299b43`, Ethereum
  `0x66a9893cc07d91d95644aedd05d03f95e1dba8af`; testnets as needed). Do NOT include
  the deprecated v1 router.
- Test: a unit test asserting the map has our chains.

### Step 2 — service: `src/lib/strategyMandate.ts` (`buildDcaMandate`)
- Pure service (no React). Signature:
  ```
  buildDcaMandate({ moduleAddress, agentAddress, environment, chainId,
                    fundingToken, capPerSwap }): { delegation: DelegationStruct }
  ```
- Build via `createDelegation` with the scope + `erc20BalanceChange` caveat above,
  `salt: keccak256(terms)` (not `keccak256(callData)` — no fixed calldata).
- Reuse only `buildYieldDelegations`'s SDK-typing workarounds (`as never`) and the
  `DelegationStruct` assembly (`signature: '0x'` pre-sign). Returns **one**
  delegation, not an array — no `exactExecution`, no per-call loop.
- **Tests:** assert the built delegation's caveats include the balance-change
  enforcer address, the functionCall targets/selectors, and value cap. No network.

### Step 3 — storage: represent the mandate
- Reuse `scopeType: 'custom'` (like yield) OR add `'strategy'` to the union in
  `src/lib/storage.ts` (DECISION §Open). Store `targetAddress` = router,
  `methodSelector`, and the cap/token in `customParams`/meta.
- `buildStoredDcaMandate(...)` mirroring `buildStoredYieldPlan`.
- **Tests:** the stored shape round-trips and carries the signed delegation.

### Step 4 — presentation: the Strategy tab (below Yield, separate for now)
- A page/section mirroring `Yield.tsx`'s structure (NOT importing it): inputs
  (funding token via the existing whitelist picker, target token, cap per swap,
  agent address from env), then the sign flow (`predictAddress` →
  `getEnvironment` → `buildDcaMandate` → `signTypedMessage`), then export/store.
- No chain calls in the component — a `useDcaMandate` hook bridges to the service.
- UI per `ui.md`: dark-first, typography-driven, mono for addresses/amounts, no
  template look. Reuse existing primitives (`Card`, `Segmented`, `Field`).

### Step 5 — agent runner: `scripts/strategy-agent.ts`
- Reuse from `scripts/yield-agent.ts` only the **scaffold**: private-key check,
  chain map, `redeemDelegations` encode primitive.
- **The fundamental difference from yield-agent:** yield replays a *fixed*
  calldata read from the stored plan; our runner **builds swap calldata at run
  time** via the Trading API (`/check_approval` → `/quote` with
  `routingPreference: "CLASSIC"` → `/swap`), then redeems the SAME reusable
  delegation with `execution = { target: router, callData: swap.data, value }`.
  So the delegation is signed once and redeemed many times, each with fresh
  calldata — the opposite of yield's one-shot replay.
- Cadence + optional price predicate (poll `/quote`) are the agent's job.
  Trading API key from env (never `VITE_`).
- Runner invariant: reject any quote whose routing is not CLASSIC (a UniswapX
  order has no `execute` tx and cannot be bound by our caveat).

### Step 6 — range variant (after DCA works)
- Same rail, add: a second `erc20BalanceChange(Decrease)` on the sell token (safe —
  distinct token, verified), and the agent's price condition (buy < X / sell > Y).
- The "range" is DCA + an off-chain price predicate + a sell direction. No on-chain
  limit order exists in the skills.

### Step 7 — customizable offers (later)
- Parameterize the mandate builder (token, cap, cadence hint, price bounds) so a
  client can compose named offers on the same rail.

## Verification per step (rules)

Each step: `bun run tsc -b` (no errors), `bun test test/unit` (new tests pass),
`bunx eslint` on changed files. UI steps: spot-check against `ui.md`. End: a
complete English PR.

## Open decisions (trade-offs, decide at code time)

1. **Router config location:** extend colleague's `src/config/uniswap.ts` (one
   place for Uniswap addrs) vs a new `src/config/swap-router.ts` (zero-touch on his
   file). Leaning new file to avoid merge friction during the hackathon.
2. **scopeType:** reuse `'custom'` (fast, consistent with yield) vs add `'strategy'`
   (cleaner for future UI/Intuition typing). Leaning `'custom'` for the first pass.
3. **CLASSIC enforcement:** the agent must set `routingPreference: "CLASSIC"`; if a
   quote ever returns UniswapX, the runner must reject it (the caveat can't bound a
   gasless order). Document this as a hard runner invariant.

## Deliberate scope note — standalone redeem is not extended

`website/src/redeem/` (the "Charge a subscription" standalone page) is where a
**human payee** encashes a subscription/stream from their own wallet. A strategy
mandate has no human payee — it is consumed by the **agent** (`scripts/`), not that
page. So the DCA caveat decoders live only in `src/lib/intuition/discover.ts`, not
in the website copy. This is a choice, not an omission: extending the standalone
would add surface with no consumer.

## Critical invariants (do not violate)

- Force **CLASSIC** routing — a UniswapX order is unbounded by our caveat.
- One `BalanceChange` per token per delegation (same-token stacking reverts).
- `salt = keccak256(terms)`, terms frozen after signing.
- Trading API key is agent-side only, never shipped to the browser.
- Non-custodial: funds never leave the Safe; the agent only redeems.
