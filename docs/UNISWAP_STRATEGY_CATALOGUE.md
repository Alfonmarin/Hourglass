# Uniswap strategy catalogue — what the skills actually offer

> What investment strategies the Uniswap `uniswap-ai` skills provide, verified by
> reading each SKILL.md, and which ones fit the Hourglass **Strategy** rail
> (`functionCall` + `erc20BalanceChange`, agent decides *when*, caveat bounds the
> loss). LP stays with the colleague's **Yield** rail. Companion:
> [`STRATEGY_IMPLEMENTATION_PLAN.md`](STRATEGY_IMPLEMENTATION_PLAN.md),
> [`HOURGLASS_STRATEGIES.md`](HOURGLASS_STRATEGIES.md).

## The catalogue

| Strategy | What it does | Trigger | On-chain action | Custody |
|---|---|---|---|---|
| **DCA** | buy a fixed amount into a token on a cadence, optionally only if a price condition holds ("buy if ETH < X") | scheduled (cron) + optional off-chain price predicate | 1 spot swap / period via Universal Router `execute` | none |
| **Copy-trade** | mirror a leader wallet's swaps into the follower, filtered/sized by guardrails | event-based (leader's swaps), polled ~5 min | spot swap per mirrored intent | none |
| **Index / basket** | buy a weighted multi-asset basket in one pass, rebalance on drift | one-shot buy + scheduled drift-based rebalance | N spot swaps (one per leg) | none |
| **Swap-planner** | plan a one-off swap / discover tokens | one-shot, manual | none — emits a `app.uniswap.org/swap?…` deep link | none |
| **Liquidity-planner** | plan a v2/v3/v4 LP position | one-shot, manual | none emitted; underlying action is an **LP mint** | none |

All bots are **non-custodial**: they build+submit from the operator's own wallet.
None hold funds. They assume two external services: a **scheduler** (cron/wake)
and a **Uniswap Trading API key** (`x-api-key`).

## Fit with our rail (BalanceChange bounds, agent decides when)

**Fits — our Strategy tab:**

- **DCA** — ideal. Off-chain scheduler + off-chain price predicate; each act is a
  single spot swap we bound with `erc20BalanceChange` (cap `tokenIn` spent) under a
  `functionCall` scope on the router. Its config (spend cap, allowlist, kill switch)
  already mirrors our caveat model.
- **Copy-trade** — fits. Off-chain wallet-watching; each mirror is a spot swap.
  Nuance: `tokenIn/tokenOut` are dynamic (from the leader), so the caveat's token
  allowlist must be broad, or the agent re-scopes per trade.
- **Index** — fits with a wrinkle: a basket buy / rebalance is **N swaps per run**.
  A per-tx `BalanceChange` caps one swap; a whole-basket cap needs either an
  off-chain per-run aggregate or N scoped executions.

**"Buy the dip / sell the rip" (range / limit):** exists, but conditionality is
**always the agent's off-chain job** — the bots poll `/quote` each wake and decide.
There is **no on-chain limit order** in these skills (`LIMIT_ORDER`/`DUTCH_LIMIT`
are Trading-API routing types, not wired into any bot). So range = DCA + a price
condition. It fits our rail; a *sell* leg just adds a second `BalanceChange` cap on
the sold token (verified safe for distinct tokens).

**Does NOT fit:**

- **Liquidity-planner (LP)** — its action is an **LP mint** (two tokens in, a
  position NFT out), not a router swap. It needs exact-execution semantics
  (amounts + range + tick spacing), not a balance-delta bound — a `BalanceChange`
  caveat can't correctly bound an LP mint. **This is the colleague's Yield rail
  (`exactExecution`), not ours.** Clean boundary.
- **Swap-planner** — doesn't execute (deep link only); nothing to bind. To use its
  intent, take its planned params and route them through our own capped swap call.

## Critical: force CLASSIC routing

The Uniswap Trading API can route two ways:

- **CLASSIC** → an `execute(...)` tx on the Universal Router. ✅ bindable — known
  target + selector.
- **UniswapX (DUTCH_V2/V3/PRIORITY)** → a **signed off-chain gasless order**, with
  **no `execute` tx** from the swapper. ❌ our `functionCall`+`BalanceChange` caveat
  cannot bound it.

`BEST_PRICE` on Ethereum mainnet **typically returns UniswapX**. So the agent MUST
request `routingPreference: "CLASSIC"` (optionally `protocols: ["V2","V3","V4"]`)
in `/quote`, so `swap.to` is always the Universal Router and `swap.data` is always
an `execute(...)` calldata our caveat can bind.

## What to whitelist in the `functionCall` scope

- **Target:** the per-chain **Universal Router** (what Trading API `/swap` returns
  as `swap.to` under CLASSIC):
  - Ethereum (1): `0x66a9893cc07d91d95644aedd05d03f95e1dba8af`
  - Base (8453): `0x6ff5693b99212da76ad316178a184ab56d299b43`
  - Arbitrum (42161): `0xa51afafe0263b40edaef0df8781ea9aa03e381a3`
  - Optimism (10): `0x851116d9223fabed8e56c0e6b8ad0c31d98b3507`
  - Unichain (130): `0xef740bf23acae26f6492b10de645d6b98dc8eaf3`
  - Polygon (137): `0x1095692a6237d83c6a72f3f5efedb9a670c49223`
  - Do **not** whitelist the deprecated v1 router `0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD`.
- **Selector:** `execute(bytes,bytes[],uint256)` — the only swap entrypoint.
- **Approval leg:** `approve(address,uint256)` from the token to the Universal
  Router (legacy approval, recommended for automated/smart-account execution), or
  to Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` on the Permit2 path.
- **L2 quirk:** a swap to native ETH on an L2 may deliver WETH + a trailing
  `WETH.withdraw` — bound the `BalanceChange` on WETH or expect the unwrap.

## Recommendation for the Strategy tab

Ship **DCA first** (the ideal fit, simplest to demo), then Range (DCA + price
condition), then Copy-trade and Index. All share one rail: `functionCall` on the
Universal Router (CLASSIC) + `erc20BalanceChange`. LP is out of scope (Yield rail).

**New config needed:** the per-chain Universal Router addresses above (not yet in
`src/config/`). The `ERC20BalanceChangeEnforcer` is already registered via the
merged `HourGlassEnforcers` suite.

## Note on the skills as shipped

The bots defer their execution/guardrail/state contracts to plugin-root reference
files (`../../references/execution-model.md`, `strategy-state.md`, chain template)
that are **not installed** on this machine (`~/.claude/references/` is absent). The
per-skill logic is readable, but the authoritative execution-mode, spend-cap, and
kill-switch definitions live in files we'd have to supply ourselves. No bot needs a
custody service; each assumes a scheduler + the Trading API key.
