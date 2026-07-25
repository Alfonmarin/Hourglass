# Execution — a limit order (single price-triggered swap)

A limit order is a **buy-the-dip**: one swap that fires only when the price is at or
below the operator's trigger, then never again. Everything about executing it is the
same as a DCA (`execution-dca.md`) — CLASSIC quote, legacy approval, two
`SingleDefault` entries in one atomic `redeemDelegations` **as the Safe** — with two
differences: **when** you fire, and **once**.

## How the trigger is enforced

The mandate carries **two** `erc20BalanceChange` bounds, both on the HourGlass
enforcer instance, plus a `limitedCalls(1)` cap:

- **Decrease** on the funding token = the max spend. Its token IS the funding token.
- **Increase** on the target token = the **min received** — the price trigger. The
  redeem reverts unless the swap returns at least this much. A cheaper price returns
  more of the target token, so a low-enough price clears the bound; a high price
  reverts. That inequality *is* "buy only at or below the trigger".
- **`limitedCalls(1)`** — the mandate can be redeemed exactly once. Its presence is
  also how discovery tells a limit order from a DCA (a DCA has no `limitedCalls`).

So the chain already guarantees you can't overpay or overspend, and can't fire twice.
Your job is only to **avoid a guaranteed-revert redeem** — don't submit until the dip
has actually hit — and to fire promptly when it does.

## The loop

1. **Discover** the mandate addressed to your agent (`discovery.md`). Keep only the
   ones with a `limitedCalls` caveat (limit orders); read `maxSpend` from the Decrease
   bound and `minReceived` from the Increase bound.
2. **Quote** `EXACT_INPUT` of the full `maxSpend`, funding → target, CLASSIC routing.
   Read the expected out at `quote.output.amount`.
3. **Compare** to `minReceived`:
   - `output < minReceived` → the price is still above the trigger. Wait and re-quote
     on your poll interval. Do **not** redeem — it would revert and waste gas.
   - `output >= minReceived` → the dip has hit. Go to step 4.
4. **Fill** exactly as in `execution-dca.md`: `/check_approval` on `maxSpend`, `/swap`
   with the quote, then approve + swap as two `SingleDefault` entries in one
   `redeemDelegations`. The min-received bound is your on-chain backstop if the price
   moves between quote and redeem — the redeem simply reverts, and you keep polling.
5. **Stop after a successful fill.** `limitedCalls(1)` means a second redeem reverts;
   there's nothing left to do.

## The bundled runner

`scripts/run-limit-order.ts` does discovery + poll + fill end to end. It takes the
operator's instruction JSON (the recap copied from the **Limit order** tab):

```bash
POLL_SECONDS=60 bun scripts/run-limit-order.ts <path-to-instruction.json>
```

Env: `AGENT_PRIVATE_KEY`, `UNISWAP_API_KEY`, `INTUITION_NETWORK` (`mainnet` |
`testnet`), optional `RPC_URL`, optional `POLL_SECONDS` (default 60), optional
`MAX_POLLS` (default 0 = poll until it fills). It matches the mandate by
`delegationHash`, polls the quote against the enforced `minReceived`, fills atomically
when the dip hits, and exits once filled. Wire it to a long-running process or a
scheduler you own — one invocation watches one order until it fills or `MAX_POLLS`.
