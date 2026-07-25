---
name: hourglass-agent
description: Set up and run an autonomous agent for a Hourglass strategy mandate — a recurring DCA buy or a single price-triggered limit order (buy-the-dip). Use this whenever a user wants to operate the agent side of a Hourglass Safe strategy — creating the agent wallet, funding its gas, discovering the delegation the Safe signed, and executing the swap. Trigger it whenever the user mentions Hourglass, a strategy mandate, a limit order, a Safe delegation to redeem, "run my DCA agent", "run my limit order", "set up the agent for my Safe", an agent address to paste into Hourglass, or executing a delegated swap on behalf of a Safe — even if they don't name Hourglass explicitly but describe an agent redeeming a Safe's delegation to DCA or to buy a dip.
compatibility: bun or node ≥ 20, foundry (cast), the uniswap swap-integration skill, network access to the Intuition graph and the Uniswap Trading API.
---

# Hourglass agent

Run the agent side of a Hourglass strategy. A Safe (a DAO/company treasury) signs
**one** delegation — the *mandate* — that lets a named agent swap on the Safe's
behalf, bounded on-chain by a per-swap cap. **You operate that agent.** Hourglass
never holds your keys and never runs the agent for you: you create a wallet, give
its address to the Safe operator, and this skill drives the recurring buy.

Mental model — read `references/context.md` first if any of this is unclear:

- **Non-custodial.** The agent holds nothing. Funds never leave the Safe except
  into the swap; the bought token returns to the Safe. The agent only *triggers*
  the swap (and pays the gas), executing it *as the Safe* via the delegation.
- **Bounded by consensus.** The mandate's `erc20BalanceChange` caveat caps the
  loss per swap. Even a buggy or compromised agent cannot spend more than the cap,
  touch another contract, or drain the Safe. The strategy (amount, cadence) is your
  instruction; the cap is the on-chain guarantee.
- **Your one job the chain can't do for you: hold a funded key.** Redeeming a
  delegation is a real transaction that costs gas. So the agent needs a wallet with
  a little native ETH. That is the *only* value the agent custodies — gas, not the
  treasury.

## The handoff (agent ⇄ operator)

This skill drives the agent, but signing the mandate is the operator's job in the Safe
App — so the flow hands back and forth once. The whole loop, from the operator's seat:

1. **Load this skill.** The agent sets up its wallet and reports back its **address**
   (steps 1–3 below). You fund that address with a little gas.
2. **You open the Safe App**, paste the agent address, create the delegation (Strategy
   or Limit order tab), and sign it — a multisig Safe needs its threshold of signers.
   The publisher backend then publishes the finalized mandate on Intuition.
3. **You come back to this skill** with the recap JSON the tab emitted. The agent
   discovers the mandate on Intuition and executes it (steps 5–6).

The agent does **not** run unattended between sessions — there is no built-in
scheduler. A limit order polls the price for as long as the run is alive and fills once
the dip hits; a DCA fires once per invocation. To keep watching, keep the run alive or
wire it to a scheduler you own (cron, a runtime wake). Re-loading the skill resumes from
discovery — the mandate lives on Intuition, not in this session.

## Quick start checklist

Do these in order. Steps 1–3 are one-time setup; steps 5–6 repeat on the mandate's
cadence.

1. **Install dependencies.** `bun add viem @metamask/smart-accounts-kit`. Install
   the Uniswap **swap-integration** skill (it builds the swap calldata). Get a Uniswap
   Trading API key from the developer hub (**https://hub.uniswap.org/**) — the full
   walkthrough is in `references/setup.md`.
2. **Create the agent wallet.** Generate a fresh keypair and record the address.
   `cast wallet new` (foundry), or the viem snippet in `references/setup.md`. Keep
   the private key secret; it only ever pays gas.
3. **Fund the wallet with a little ETH** on the mandate's chain (Base or Ethereum
   mainnet). A few dollars of ETH covers many redeems. Ask the human operator to
   send it — the agent does not self-fund. Verify the balance before proceeding.
4. **Hand the address to the Safe operator.** They paste it into Hourglass as the
   *Agent address* (Strategy tab for a DCA, Limit order tab for a limit order) and sign
   the mandate — a multisig Safe needs its signing threshold. Nothing below works until
   the mandate is finalized and published. They then hand you back the **recap JSON**
   the tab emits (it names the mandate by `delegationHash`).
5. **Discover the mandate.** Read the delegations the Safe addressed to your agent
   from the Intuition graph, and match the one in the recap by `delegationHash`. See
   `references/discovery.md`. If none appear, the mandate isn't published yet (threshold
   not reached, or indexing lag) — wait and retry.
6. **Execute the buy.** Build the swap (Uniswap Trading API, CLASSIC routing + legacy
   approval) and redeem it — approve + swap in one atomic transaction. For a **DCA**,
   run this on the mandate's cadence (a cron/scheduler you own; this skill does not run
   a scheduler) — see `references/execution-dca.md`. For a **limit order**, poll the
   price and fire once when the dip hits — see `references/execution-limit-order.md`.

Ready-to-run scripts that do steps 5–6 are bundled: `scripts/run-dca.ts` for a DCA and
`scripts/run-limit-order.ts` for a limit order. Each takes the operator's instruction
JSON (the recap copied from the Strategy or Limit order tab); read the matching
execution reference for how to configure and invoke it.

## What you need from the operator / environment

| Value | Where it comes from | Notes |
|---|---|---|
| `AGENT_PRIVATE_KEY` | the wallet you created in step 2 | secret, gas only, never commit |
| `UNISWAP_API_KEY` | Uniswap developer portal | agent-side only |
| chain id | the mandate's chain (Base 8453 / Ethereum 1) | mainnet — the router + liquidity live there |
| `INTUITION_NETWORK` | `mainnet` for a mainnet mandate | which graph to discover on |
| `RPC_URL` (optional) | your RPC provider | defaults to a public RPC |

## Hard rules (the chain enforces the last two — respect the first two so you don't waste gas)

- **CLASSIC routing only.** Request `routingPreference: "CLASSIC"` from the Trading
  API so the swap is a router `execute(...)` tx the delegation can redeem. A gasless
  UniswapX order has no on-chain tx to redeem and cannot be bounded — reject it.
- **Legacy approval, never Permit2.** Approve the funding token directly to the
  Universal Router. The mandate whitelists `approve` on the token + `execute` on the
  router; a Permit2 flow targets a contract the mandate does not allow and needs a
  signature the Safe can't give — it reverts.
- **One swap per redeem entry.** The mandate's `functionCall` enforcers only accept
  a single-call execution, so approve and swap are two `SingleDefault` entries in one
  `redeemDelegations` call — not a batch execution (which reverts).
- **The cap is the ceiling.** Never try to swap more than the per-swap cap; the
  `erc20BalanceChange` enforcer reverts the redeem if you do. Simulate before sending.

## Strategy variants

Discovery is **type-agnostic**: it returns every delegation addressed to the agent,
each tagged with a `scopeType`, and strategy mandates carry a `strategyKind`. This
skill details two:

- **DCA** (`strategyKind: 'dca'`) — a recurring buy. One Decrease bound (the per-swap
  spend cap); the agent re-runs on the operator's cadence. See `references/execution-dca.md`
  and `scripts/run-dca.ts`.
- **Limit order** (`strategyKind: 'limitOrder'`) — a single price-triggered buy. Two
  bounds (Decrease spend + Increase min-received = the price trigger) plus a
  `limitedCalls(1)` cap. The agent polls the price and fills once. See
  `references/execution-limit-order.md` and `scripts/run-limit-order.ts`.

**The `limitedCalls` caveat is the discriminator**: a mandate that has one is a limit
order, otherwise a DCA. Both discover and redeem the same way — the only differences
are when the agent fires and whether it repeats.

Hourglass supports other delegation types the team ships — yield positions
(`exactExecution`, a fixed-calldata replay), subscriptions and streams
(`erc20PeriodTransfer` / `erc20Streaming`, a `transfer` redeem). They follow the same
shape: **discover → route on `scopeType` / `strategyKind` → execute**. When those types
are stabilized, add a branch here and a matching `references/<type>.md`; the discover
and redeem layers are already generic. Until then, this skill handles DCA and limit
orders and skips mandates of other types rather than guessing at their execution.

## Reference files

- `references/context.md` — the Safe + delegation model, non-custodial guarantees,
  what the agent can and cannot do. Read first.
- `references/setup.md` — wallet creation, funding, the one-time dependencies.
- `references/discovery.md` — reading the mandate from the Intuition graph.
- `references/execution-dca.md` — building the swap and redeeming it atomically for a
  DCA, plus configuring and running `scripts/run-dca.ts`.
- `references/execution-limit-order.md` — the same, for a single price-triggered limit
  order (poll → fill once), plus `scripts/run-limit-order.ts`.
