# Execution — build the swap and redeem it atomically

For each discovered DCA mandate: build the swap with the Uniswap Trading API, then
redeem the mandate to execute it **as the Safe**. Approve and swap go in **one**
`redeemDelegations` call so it's all-or-nothing.

## Step 1 — build the swap (Uniswap Trading API)

Base URL: `https://trade-api.gateway.uniswap.org/v1`. All requests send these
headers:

```
Content-Type: application/json
x-api-key: <UNISWAP_API_KEY>
x-universal-router-version: 2.0
```

**Swapper is the Safe** (`meta.safeAddress`) — the swap runs as the Safe, so the
Safe is the token owner and recipient, not the agent.

1. **`POST /check_approval`** — `{ walletAddress: <Safe>, token: <fundingToken>, amount, chainId }`.
   Returns `{ approval: { to, data, ... } }` (a legacy `approve(router, amount)` tx on
   the token) or `{ approval: null }` if already approved.
2. **`POST /quote`** with **`routingPreference: "CLASSIC"`** (chain ids are strings):
   ```json
   { "swapper": "<Safe>", "tokenIn": "<funding>", "tokenOut": "<target>",
     "tokenInChainId": "8453", "tokenOutChainId": "8453", "amount": "<raw>",
     "type": "EXACT_INPUT", "slippageTolerance": 0.5, "routingPreference": "CLASSIC" }
   ```
   Reject the mandate if the response `routing` is not `CLASSIC` — a UniswapX
   (`DUTCH_*`) route is a gasless off-chain order with no router tx to redeem.
3. **`POST /swap`** with the quote — returns `{ swap: { to, data, value } }` where
   `to` is the Universal Router and `data` is the `execute(...)` calldata. Send **no**
   `permitData` / signature (legacy path).

The Hourglass repo wraps steps 1–3 in `checkApproval` and `buildSwap`
(`src/lib/trading-api.ts`); the bundled runner reuses them.

## Step 2 — redeem approve + swap in one atomic call

The mandate's `functionCall` enforcers only accept a **single-call** execution, so a
batch execution reverts (`CaveatEnforcer:invalid-call-type`). Instead, put approve
and swap as **two `SingleDefault` entries** in one `redeemDelegations` — both land in
one transaction, so a revert on either rolls back both.

```ts
import { createExecution, ExecutionMode, redeemDelegations, type Redemption } from '@metamask/smart-accounts-kit'

const delegation = /* rebuilt from the discovered mandate; each caveat gets args: '0x' */
const redemptions: Redemption[] = []
if (approval) {
  redemptions.push({
    permissionContext: [delegation],
    executions: [createExecution({ target: approval.to, value: 0n, callData: approval.data })],
    mode: ExecutionMode.SingleDefault,
  })
}
redemptions.push({
  permissionContext: [delegation],
  executions: [createExecution({ target: swap.to, value: BigInt(swap.value), callData: swap.data })],
  mode: ExecutionMode.SingleDefault,
})

// The helper simulates before sending, so a cap-exceeded / bad-route revert
// surfaces here — no gas lost, nothing sent on-chain.
const hash = await redeemDelegations(walletClient, publicClient, delegationManager, redemptions)
```

`delegationManager` is the Delegation Framework's manager on the chain
(`0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`, same across chains). `walletClient` is
the agent's account; `publicClient` reads the chain.

## Why these constraints (don't waste gas fighting them)

- **CLASSIC only** — the mandate can only redeem a router `execute(...)` tx.
- **Legacy approval to the router** — the mandate whitelists `approve` on the token +
  `execute` on the router. Permit2 targets a different contract and needs a signature
  the Safe can't give; it reverts.
- **One swap per entry** — the `functionCall` enforcers are single-call; a batch
  execution reverts.
- **≤ cap** — never swap more than `capPerSwap`; the `erc20BalanceChange` enforcer
  reverts the redemption otherwise. The simulation in `redeemDelegations` catches it
  before broadcast.

## The bundled runner

`scripts/run-agent.ts` does discovery + execution end to end for the DCA type. Set
the env from `setup.md` and run:

```bash
bun scripts/run-agent.ts <chainId>
```

It discovers the agent's DCA mandates, reads the intent (target/amount/period) from
each mandate's metadata, and executes the swap for the current tick. Wire it to a
scheduler you own (cron / a runtime wake) to hit the mandate's cadence — this skill
does not run a scheduler; each invocation is one self-contained run.
