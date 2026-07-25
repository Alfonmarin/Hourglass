# Arbitrage in Hourglass — executive summary

**To:** Frontyield / Yield team
**From:** Arbitrage team
**Status:** design verified against the codebase; 3 points still to validate on testnet before writing code. One previously-open point is now closed — see "Treasury protection".

## In one sentence

Arbitrage fits the delegation model more cleanly than any other strategy: it is bounded by `erc20BalanceChange(Increase)` = a **profit floor**, which is not a spend cap but an on-chain **no-loss guarantee**. The agent finds the opportunity; the caveat guarantees the vault can only end up richer, or revert.

## The design (intra-Uniswap rail)

One delegation: `functionCall` over `[UniversalRouter] · execute` + an `erc20BalanceChange(Increase)` with a strictly-positive `minProfit` on the base token. Both legs of the arb (e.g. `USDC→WETH→USDC`) go in a **single atomic `execute`** on the Universal Router. If the round-trip does not clear the floor, the `afterHook` reverts and nothing happens.

**Everything stays in the Safe module — nothing external, ever.** This is the hard constraint, not a nice-to-have:

- Funds never leave the Safe. There is no intermediate custody, not even transiently within a transaction.
- The execution runs through the Safe's DeleGator module, as the Safe. The agent holds no funds and no approval.
- The Permit2 approval is a **Safe multisig transaction** — the Safe approving the router against its own balance. It is a setup step outside the *mandate*, not outside the *Safe*.
- The agent's only powers are: sign the redemption, pay its own gas. Both are bounded by the caveat.

This is also why cross-DEX is out of scope (below): it cannot be done without reintroducing transient custody.

## The key part: two defects we found and fixed

The first version copied the Strategy rail (DCA) shape verbatim. The review caught that **this is not valid for arbitrage**:

1. **The `approve` leg is incompatible with the `Increase` floor.** With `Decrease` (DCA — what `src/lib/strategyMandate.ts` ships today), a redemption that only approves leaves the balance intact and passes. With `Increase`, that same redemption has a zero delta and always reverts. The agent cannot approve from inside the mandate.
2. **`minProfit = 0` was a drain vector.** Because `functionCall` is a cartesian product of targets × selectors, the spender of an in-scope `approve` is unbounded; a zero floor makes a balance-neutral call redeemable → `approve(attacker, max)` would slip through.

The cartesian product is confirmed in the SDK, not inferred: `FunctionCallScopeConfig = AllowedTargetsBuilderConfig & AllowedMethodsBuilderConfig`, and the builder emits two independent caveats — `.addCaveat('allowedTargets', { targets }).addCaveat('allowedMethods', { selectors })`. There is no target↔selector pairing. Concretely, in the mandate the strategy rail builds today (`targets = [router, ...cappedTokens]`, `selectors = [approve, execute]`), `approve` is callable **on the router** and `execute` **on the token**.

**The fix, one for both:** move approvals out of the mandate. The approval becomes a **multisig setup transaction** using Permit2 (`Permit2.approve(token, router, cap, expiration)`), and the mandate scope shrinks to a single target + selector (`execute`). Permit2 also gives an amount and time bound for free.

`minProfit = 0` is not merely forbidden by convention — **the SDK cannot encode it**. `erc20BalanceChangeBuilder` rejects it outright:

```js
if (balance <= 0n) throw new Error("Invalid balance: must be a positive number");
```

So the strictly-positive floor is guaranteed by construction.

## Treasury protection — the mitigation had to change

If the Safe holds other tokens with pre-existing Permit2 approvals, an `execute` could liquidate them and still clear the USDC floor. The original mitigation was one `erc20BalanceChange(Decrease, tokenX, 0)` per treasury token.

**That does not work.** It is the same `balance <= 0n` guard above: an `amount = 0` cap throws before a caveat is ever produced. This was listed as a testnet question; the answer is already settled in the SDK, so it needs a different shape:

- use `amount = 1` (one wei of slack — negligible against any real balance), or
- bypass the scope builder and encode the caveat terms directly.

Either way the stacking rationale is unchanged: distinct tokens → independent enforcer slots → safe to stack.

## Key invariants

- The Trading API **does not quote round-trips**: the agent composes the multi-leg `execute` itself from two CLASSIC quotes. This is the hardest piece of the runner.
- **CLASSIC routing is mandatory**: UniswapX is an off-chain signed order, with no `execute`, and escapes the caveat.
- Cross-DEX is out of scope: it cannot keep the single-`execute` atomicity without reintroducing transient custody — which the Safe-module constraint above rules out.

## What this touches on your side (Yield / shared config)

- **Shared config:** Uniswap addresses live in `src/config/uniswap.ts`, **not** `src/config/addresses.ts` (which holds only the DelegationManager, the module factory, and the enforcer registry). `UNIVERSAL_ROUTER` is already there — but mainnet and Base only, no testnet entry yet, which is exactly what the testnet validation below needs. `Permit2` does not exist anywhere in the codebase yet; adding it is net-new work.
- **The `ERC20BalanceChangeEnforcer` is registered, with a caveat of its own:** the override in `src/lib/environment.ts` only applies on chains carrying an `hourglass` block — mainnet (1) and Base (8453). Base Sepolia and Sepolia fall through to the SDK defaults. More importantly, `findBalanceChangeCaveat` (`src/lib/intuition/discover.ts`) matches **only** the HourGlass instance, so discovery finds nothing on testnet. That has to be resolved before the testnet validation step means anything.
- **To verify together — the swap's `msg.sender`:** the mandate uses `from: moduleAddress` (the Safe's DeleGator module). Note the rail as built today passes `recipient: moduleAddress` (`src/pages/Strategy.tsx`), not the Safe address — so the account being measured is the module, and we need to confirm which account actually holds the balance and performs the swap. Approval, holdings, and `balanceOf` must all reference the same account. This also affects your yield rail (`exactExecution`), so it's worth validating once for both.
- **Clean boundary between rails:** LP (yield) stays on `exactExecution` (known calldata); arbitrage/swap uses `balanceChange` (delta). They don't overlap.

## Next steps (before writing code)

1. Redesign the approval → done in the doc (Permit2 as a Safe setup transaction).
2. Rework the treasury protection away from `amount = 0` (settled in the SDK, no testnet run needed — see above).
3. Confirm on testnet: approval shape (Permit2 vs legacy), batch-mode behaviour, and the swap's `msg.sender`. Prerequisites: a testnet `UNIVERSAL_ROUTER` entry, and a discovery path that matches the enforcer on testnet.
4. Add `Permit2` addresses to `src/config/uniswap.ts`.
5. Treat the agent-side composition of the `execute` as an invariant and validate it with fork-tests (profitable / below-floor / leg-2 fails / approve-only reverts / drain rejected / protected token).

Full technical detail: `docs/HOURGLASS_ARBITRAGE.md` — **not written yet**; this summary is currently the only arbitrage document in the repo.
