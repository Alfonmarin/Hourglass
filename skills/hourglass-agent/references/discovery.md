# Discovery — reading the mandate from Intuition

The Safe publishes the signed mandate to the Intuition knowledge graph: a triple
saying *"this Safe delegate-to this agent"*, linked to the pinned delegation
document (which holds the full signed delegation, caveats intact). The agent finds
its mandates by querying that graph for delegations addressed to its own address.

## How discovery works

The read is **type-agnostic** — it returns every delegation addressed to the agent,
each tagged with a `scopeType`. The agent filters for the type it handles.

Query the Intuition GraphQL endpoint for the agent as the object of a `delegate to`
triple (encoded as a CAIP-10 URI: `caip10:eip155:<chainId>:<agentAddress>`),
traverse the `in context of` triple to the delegation document atom, fetch that
document from IPFS, and reconstruct the signed delegation. The Hourglass repo does
this in `discoverIncomingDelegations(agentAddress, chainId)` — the bundled runner
(`scripts/run-agent.ts`) reuses the same logic.

Network: set `INTUITION_NETWORK=mainnet` for a mainnet mandate so discovery hits the
right graph. The GraphQL URL and predicate ids are per network.

## What a discovered DCA mandate contains

Each result is a stored delegation with the full signed `delegation` (delegate,
delegator, authority, caveats, salt, signature) plus a `meta` describing it:

| Field | Meaning |
|---|---|
| `scopeType` | `'strategyMandate'` for a strategy — filter on this |
| `strategyKind` | `'dca'` (or a future variant) |
| `safeAddress` | the Safe (= the delegation's delegator; the swap runs as this) |
| `delegate` | the agent this mandate is addressed to — must equal your address |
| `tokenAddress` | the **funding** token (what the Safe spends) |
| `targetToken` | the token to **buy** (the swap output) |
| `amount` | the buy amount per tick — the DCA intent (agent instruction) |
| `period` | the cadence: `daily` / `weekly` / `monthly` (agent instruction) |
| `capPerSwap` | the on-chain max-spend per swap (from the Decrease bound) — a guardrail |
| `maxPrice` | the operator's max price (funding per target), or null — enforced on-chain via the min-received Increase bound |

Two kinds of field:

- **Intent** (`amount`, `period`, `targetToken`) — what the agent carries out, from
  the operator's instruction (the recap). **Not** enforced on-chain.
- **Guardrails** (`capPerSwap`, `maxPrice`) — enforced on-chain by the mandate's
  `erc20BalanceChange` caveats: a Decrease on the funding token (max spend) and,
  when a max price was set, an Increase on the bought token (min received). The
  agent cannot overspend or overpay, whatever it does.

Note: the discovery reads `tokenAddress` and `capPerSwap` from the **Decrease**
caveat (the funding token). `targetToken`, `amount`, `period`, and `maxPrice` come
from the operator's instruction, matched to the mandate by `delegationHash`.

## Filtering

Handle only what this skill covers:

```
mandates = discoverIncomingDelegations(agentAddress, chainId)
dca = mandates.filter(m =>
  m.meta.scopeType === 'strategyMandate' &&
  m.meta.strategyKind === 'dca' &&
  m.delegation.delegate.toLowerCase() === agentAddress.toLowerCase()
)
```

Skip mandates whose `delegate` is not your agent, or whose intent is incomplete
(missing `targetToken` / `amount`). Mandates of other types (yield, subscription,
stream) are returned too — skip them until this skill adds their branches.

## If nothing appears

An empty result usually means the mandate isn't published yet: the Safe hasn't
reached its signing threshold, or the publish to Intuition is still propagating.
Wait a minute and retry. It does **not** mean the mandate is lost — the signed
delegation lives in the pinned IPFS document regardless.
