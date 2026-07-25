# Strategy mandates — implementation plan

> How our **Strategy** part (DCA, range, index) fits alongside the colleague's
> **Yield** part, inside one "Agent Delegation" page. Scope: the strategy rail
> (`functionCall` + `erc20BalanceChange`). Intuition discovery is deferred — for
> now the base (build + sign + a local agent runner) is what we build.
>
> Companion research doc: [`HOURGLASS_STRATEGIES.md`](HOURGLASS_STRATEGIES.md)
> (verified enforcer semantics). This doc is the build map.

## 0. The two parts of "Agent Delegation"

One page, two families of agentic delegation. They share a signing + storage +
redeem core; they differ in the caveat that bounds the agent.

| | **Yield** (colleague) | **Strategy** (us) |
|---|---|---|
| Action | provide liquidity (LP mint) | swap (buy/sell) |
| Calldata known at sign time? | **yes** (amounts, pool fixed) | **no** (price/route change) |
| Enforcer | `exactExecution` (pins calldata) | `erc20BalanceChange` (bounds delta) |
| Delegations | 3 single-use (approve, approve, mint) | 1 per mandate (reusable) |
| Files | `yieldDelegations.ts`, `Yield.tsx`, `uniswapPosition.ts` | `strategyMandate.ts`, `Strategy` UI (new) |

They are **complementary, not competing** — two rails for two constraints. We do
**not** rewrite yield; we add the strategy rail next to it.

## 1. What already exists (colleague's yield, do not modify)

| File | Role |
|---|---|
| `src/pages/Yield.tsx` | operator UI: pick pool, amounts, sign 3 delegations, download `plan.json` |
| `src/lib/yieldDelegations.ts` | `buildYieldDelegations` — `exactExecution` + `limitedCalls` + `redeemer` + `timestamp` |
| `src/lib/uniswapPosition.ts` | `buildDepositPlan` — computes the exact approve/approve/mint calldata |
| `src/lib/uniswapDiscovery.ts`, `src/hooks/useUniswapPools.ts` | pool discovery + ranking (Base Sepolia v3) |
| `src/config/uniswap.ts` | factory + position manager addresses (84532 only) |
| `scripts/yield-agent.ts` | agent runner: reads `plan.json`, redeems each delegation |

His agent path is **local JSON bundle → agent reads file → `redeemDelegations`**.
No Intuition. We mirror the *shape*, not the exactExecution caveat.

## 2. Reusable vs. strategy-specific

**Shared core — reuse as-is (do NOT refactor his files; extract a thin helper if
needed, used by us only):**

- Signing: `buildDelegationTypedData(delegation, chainId)` + `sdk.txs.signTypedMessage` loop (`Yield.tsx:117-124`, same as `CreateDelegation.tsx:338`).
- Storage: `StoredDelegation` + the `buildStoredYieldPlan` pattern (`yieldDelegations.ts:104-149`) — reuses `scopeType: 'custom'` + `targetAddress`/`methodSelector`/`calldataArgs`.
- Redeem: `src/lib/redeemDirect.ts` `buildRedeemTx`, and the `scripts/yield-agent.ts` scaffold (key check, chain map, `redeemDelegations` encode).
- `createDelegation` from `@metamask/smart-accounts-kit`.

**Strategy-specific — net-new (our files only):**

- `src/lib/strategyMandate.ts` — `buildStrategyMandate` (the DCA/range/index builder).
- `src/config/addresses.ts` — add `ERC20BalanceChangeEnforcer` address (**absent today**). Additive change, low conflict risk.
- A swap target: `UNIVERSAL_ROUTER` (or reuse `delegationMetaSwapAdapter`, already at `addresses.ts:53`).
- `scripts/strategy-agent.ts` — DCA runner; unlike yield it must **build swap calldata at redeem time** (dynamic), not replay fixed calldata.

**Rule of thumb:** we write only in our files; we read his. The only shared file
we touch is `addresses.ts`, and only to add.

## 3. Our strategy catalogue

All strategies share **one rail**: `functionCall` (locks the call surface) +
`erc20BalanceChange` (bounds the loss). Only the agent's off-chain logic differs.

| Strategy | What the agent does | Enforcers | Swap direction |
|---|---|---|---|
| **DCA** | buy a fixed size on a cadence | `functionCall` + `BalanceChange(Decrease, fundingToken)` | 1-way (buy) |
| **Range / limit** ("dip / rip") | buy when price < X, sell when price > Y | `functionCall` + `BalanceChange(Decrease)` **×2** (cap on each token) | 2-way (buy + sell) |
| **Index / basket** | split across N tokens | `functionCall` + `BalanceChange` per token | multi |

### On-chain vs off-chain — the invariant

For **every** strategy: the **condition and cadence live in the agent**
(off-chain), the **cap lives in the caveat** (on-chain). Example, range trading:

- Off-chain (agent): watches the ETH price, decides "price < X → buy" / "price > Y → sell".
- On-chain (caveat): each trade cannot lose more than the cap. The contract does
  **not** verify the price was actually below X — it only bounds the spend.

So "buy the dip" is a **promise of the agent, not a guarantee of the contract**.
The caveat bounds operational risk (no drain, no wrong contract), not strategy
correctness. This is the thesis: *strategies are software, guardrails are consensus.*

### Why range needs two caps

- Buy = USDC → ETH (spends USDC) → `BalanceChange(Decrease, USDC)`.
- Sell = ETH → USDC (spends ETH) → `BalanceChange(Decrease, ETH)`.
- A strategy that does both authorizes both directions → two caps, one per token.
  Verified safe: two `BalanceChange` on **distinct** tokens use independent
  storage slots (see research doc §6).

## 4. Architecture — where things live

```
src/lib/
  yieldDelegations.ts        ← colleague, INTACT
  strategyMandate.ts         ← NEW (us): buildStrategyMandate
  redeemDirect.ts            ← shared, reuse

src/config/
  addresses.ts               ← ADD ERC20BalanceChangeEnforcer (additive)
  uniswap.ts                 ← colleague; add UNIVERSAL_ROUTER if not reusing metaSwap adapter

src/pages/
  Yield.tsx                  ← colleague, INTACT
  <Agent page>               ← shared shell, two tabs: Yield | Strategy (UI = coordinated)

scripts/
  yield-agent.ts             ← colleague, INTACT
  strategy-agent.ts          ← NEW (us): builds swap calldata at redeem time
```

The "Agent Delegation" page with Yield/Strategy tabs is the only seam, and it is
UI — each side fills its own tab independently.

## 5. `buildStrategyMandate` — the shape (mirrors buildYieldDelegations)

```
buildStrategyMandate({ moduleAddress, agentAddress, environment,
                       fundingToken, swapRouter, capPerSwap,
                       // range adds: sellToken, capPerSell
                     }) → { delegation: DelegationStruct }

  createDelegation({
    to:   agentAddress,          // delegate = the agent (redeem only)
    from: moduleAddress,         // the Safe's DeleGator module
    environment,
    scope: {
      type: 'functionCall',
      targets:   [fundingToken, swapRouter],
      selectors: ['approve(address,uint256)', 'execute(bytes,bytes[],uint256)'],
    },
    caveats: [
      { type: 'erc20BalanceChange', tokenAddress: fundingToken,
        recipient: <safe>, changeType: Decrease, balance: capPerSwap },
      // range only: a second Decrease cap on sellToken
    ],
    salt: keccak256(terms),   // NOT keccak256(callData) — DCA has no fixed calldata
  })
```

Difference from yield, precisely:
- drop `exactExecution` → add `erc20BalanceChange` + a broad `functionCall` scope.
- salt source changes: yield uses `keccak256(execution.callData)` (a fixed call);
  we have no single call, so `keccak256(terms)` (the project convention).
- `limitedCalls` / `timestamp`: **omitted** for a reactive agent (deliberate risk
  posture — see research doc §4). The multisig `disableDelegation` is the kill-switch.

## 6. Ordered steps (what to actually do)

1. **Config prerequisite** — add `ERC20BalanceChangeEnforcer` to `addresses.ts`;
   confirm its address per chain against the SDK deployments. Pick the swap target
   (UNIVERSAL_ROUTER vs `delegationMetaSwapAdapter`).
2. **`buildStrategyMandate` (DCA first)** — one funding token, one `BalanceChange`
   Decrease cap, `functionCall` over `[token, router]`. Unit-test the built
   delegation's caveats/scope.
3. **Sign + store** — reuse `buildDelegationTypedData` + `signTypedMessage`; store
   as `StoredDelegation` (scopeType `'custom'`, like yield, or a new `'strategy'`).
4. **`scripts/strategy-agent.ts`** — a runner that: reads the stored mandate,
   builds the swap calldata *at run time* (via the Uniswap swap skill), redeems.
   This is the one place that genuinely differs from yield-agent (dynamic calldata).
5. **Extend to range** — add the second `BalanceChange` (sell token) + the agent's
   price condition. Index/basket follows the same rail.
6. **(Later) Intuition discovery** — publish the mandate at sign time and add a
   `findBalanceChangeCaveat` decode branch in `discover.ts` so an agent can
   discover mandates addressed to it, instead of reading a local bundle. Deferred.

## 7. Open decisions

- **scopeType**: reuse `'custom'` (like yield) or introduce `'strategy'`? `'custom'`
  is faster and consistent; `'strategy'` is cleaner if we later type the UI/discovery.
- **Swap target**: `UNIVERSAL_ROUTER` (standard) vs `delegationMetaSwapAdapter`
  (already in config, may simplify the approve+swap surface). Confirm which the
  Uniswap swap skill emits calldata for.
- **Agent runner scope**: local bundle (like yield) for the demo, Intuition later.
