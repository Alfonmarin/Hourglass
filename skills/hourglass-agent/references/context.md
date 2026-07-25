# Context — the Safe, the delegation, and what the agent can do

Read this before running anything. It is the mental model the rest of the skill
assumes.

## The players

- **The Safe** — a multisig smart-contract account (a DAO/company treasury). It
  holds the funds. It signs the mandate once, via its owners' threshold.
- **The DeleGator module** — a module enabled on the Safe (not a separate account).
  It is the *delegator*: when the agent redeems, the action executes through this
  module, i.e. **as the Safe**. The Safe's own balance is what moves.
- **The agent** — you. A wallet you create. It is the *delegate*: the only address
  allowed to redeem this mandate. It holds no treasury funds — only a little ETH for
  gas.

## The mandate (what was signed)

One EIP-712 delegation, signed by the Safe, carrying:

- A **`functionCall` scope** — whitelists exactly two things: `approve(address,uint256)`
  on the funding token, and `execute(bytes,bytes[],uint256)` on the Uniswap Universal
  Router. The agent can call nothing else. Any other target or method reverts.
- One or two **`erc20BalanceChange` caveats**, both enforced per redemption by
  reading the Safe's balance before and after:
  - A **Decrease** on the funding token — the **max spend** (anti-drain cap). The
    Safe cannot lose more than this per swap.
  - Optionally an **Increase** on the bought token — the **min received**, derived
    from a max price. The swap only clears if the Safe receives at least this much,
    i.e. the effective price is at or below the operator's max. Both revert the
    redeem if violated.

The mandate's DCA intent (target token, amount, cadence) is **not** in the caveat.
It lives in the mandate's metadata on Intuition — an instruction the agent follows,
not something the chain enforces. Only the per-swap cap and the call surface are
enforced on-chain.

## Non-custodial — what that means concretely

- Funds never sit in the agent. A swap moves the funding token **out of the Safe
  and into the swap**; the bought token comes **back to the Safe**. The agent is
  never the holder.
- The agent's only custody is **gas** (native ETH in its wallet). That is not the
  treasury; it's the cost of submitting the redeem transaction.
- Worst case, a fully compromised agent can: swap up to the cap, through the router
  only, and lose the gas in its own wallet. It cannot drain the Safe, call another
  contract, or move the bought token elsewhere.

## What the agent can and cannot do

| Can | Cannot |
|---|---|
| Redeem the mandate to swap funding → target token | Spend more than the per-swap cap |
| Route the swap through the Uniswap Universal Router | Call any other contract or method |
| Choose *when* to act and *how much* (≤ cap) | Move funds out of the Safe to any address |
| Pay its own gas | Change the mandate's terms (that needs a new signature) |

## Trust boundary

Do not treat the delegate restriction as the security boundary — a delegate that
can itself re-delegate could pass it on. The real boundary is the pair
**`functionCall` scope + `erc20BalanceChange` cap**: they hold no matter who
ultimately redeems. That is why the agent is safe to run unattended.

## Revocation

The Safe owners stop the agent by disabling the delegation (a multisig action).
There is no separate off-switch; the multisig is the kill switch. Auto-expiry
(`timestamp`) is optional and may or may not be on a given mandate.
