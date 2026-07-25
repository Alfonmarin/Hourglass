# Approval rails — how each strategy grants token permissions

**Status:** verified against the codebase and against Uniswap's published contracts (October 2026). One load-bearing claim rests on bytecode analysis rather than Solidity source — flagged explicitly in §1.

Three rails exist in this repo and they approve tokens in three different ways. This document exists because that looked like inconsistency, and it is not: **the approval mechanism is dictated by the target contract, not chosen by the team.** It also records one real defect found while writing it (§5).

## 1. Execution identity: the Safe is `msg.sender`

Everything below depends on this, so it comes first.

The DeleGator module is a **genuine Safe module**, not a standalone smart account. When a delegation is redeemed:

```
agent EOA → DelegationManager.redeemDelegations
          → module.executeFromExecutor(mode, calldata)        [0xd691c964]
          → safe.execTransactionFromModuleReturnData(...)     [0x5229073f]
          → target.approve(...) / router.execute(...)          msg.sender == SAFE
```

The Safe holds the tokens; the module exists only to carry the delegations. `useSafeTokens` reads balances at `safe.safeAddress`, and `Yield.tsx` validates deposits against `balanceOf(safeAddress)`.

The module has a **second** entry point with different behaviour — worth knowing, because it is the exception that looks like a contradiction:

| Entry point | Guard | Downstream | `msg.sender` at target |
|---|---|---|---|
| `executeFromExecutor` (`0xd691c964`) | DelegationManager | `safe.execTransactionFromModuleReturnData` | **the Safe** |
| `execute` (`0xe9ae5c53`) | the Safe | raw `CALL` from the module | **the module** |

The second is used by `src/lib/revoke.ts` (whose comment documents exactly this: `disableDelegation` must come from the delegator, so it is routed through `module.execute()`) and by `ModuleTransfer.tsx`, the recovery page that sweeps assets accidentally sent to the module back into the Safe.

> **Evidence caveat.** The `delegator-safe-module` Solidity source is not vendored in this repo (`test/setup-local.mjs` compiles it from an external project). The call path above was established by analysing the module's runtime bytecode: the `execTransactionFromModuleReturnData` call site was located, and the module's complete dispatch table was read — `supportsInterface`, `isValidSignature`, `safe()`, `executeFromExecutor`, `execute`, `delegationManager()`. Notably there is **no** `entryPoint()` and no `validateUserOp`, so it is not a `DeleGatorCore`; it has a `safe()` getter instead. The control flow is unambiguous, but two revert-guard selectors (`0x17c62ee9`, `0x0692ce81`) could not be reversed to names, so *which* caller each entry point requires is inferred from control flow rather than confirmed by name. This has **not** been confirmed on a live chain — it remains the open item in `ARBITRAGE_EXECUTIVE_SUMMARY.md`.

## 2. The three rails

| Rail | Target contract | Approval mechanism | What bounds it |
|---|---|---|---|
| **Yield (LP)** | Uniswap v3 `NonfungiblePositionManager` | ERC-20 `approve`, inside the mandate | `exactExecution` + `limitedCalls: 1` |
| **DCA / Strategy** | Uniswap `UniversalRouter` | ERC-20 `approve`, inside the mandate | **nothing effective — see §5** |
| **Arbitrage** (design only) | Uniswap `UniversalRouter` | Permit2, as a Safe setup transaction | `(amount, expiration)` + scope reduced to `execute` |

### Yield — ERC-20 approve, pinned

`src/lib/uniswapPosition.ts` builds three executions: `approve(positionManager, amount0)`, `approve(positionManager, amount1)`, `mint(...)`. Each is wrapped in its own single-use delegation (`src/lib/yieldDelegations.ts`) carrying `exactExecution` + `limitedCalls: 1` + `redeemer` + `timestamp`.

This is safe because **the calldata is fully known at signing time**. `exactExecution` pins target, value and calldata byte-for-byte, so spender and amount are frozen. The agent decides only *whether* and *when* to submit — never *what*.

The PositionManager reads standard ERC-20 allowances, so no Permit2 is involved or needed.

### Arbitrage — Permit2, and why it has no choice

The Universal Router **does not read ERC-20 allowances granted to itself.** Verified negatively across `Dispatcher.sol`: no command calls `ERC20.transferFrom` directly. Every pull from a user goes through `Permit2Payments.permit2TransferFrom` → `PERMIT2.transferFrom(from, to, amount, token)`. `PAY_PORTION` and `SWEEP` only distribute tokens the router already holds — they cannot source funds.

Consequence: `token.approve(universalRouter, amount)` is **dead allowance**. A swap on that basis fails.

So Permit2 is not a security upgrade the arbitrage team chose — it is the only path the target accepts. The flow is **two transactions**, both from the Safe:

1. `token.approve(PERMIT2, ...)` — required, no alternative. Permit2 moves funds with a plain `ERC20.transferFrom`, so it needs a real ERC-20 allowance.
2. `Permit2.approve(token, universalRouter, amount, expiration)` — bounds what the router may pull.

The router **consumes** an allowance already in place; it never creates one. Both steps are Safe multisig transactions, outside the mandate but inside the Safe.

## 3. Permit2 is not tied to smart accounts

A natural objection is that Permit2 is an EOA/smart-account mechanism incompatible with a Safe module. It is not. From `AllowanceTransfer.sol`:

```solidity
function approve(address token, address spender, uint160 amount, uint48 expiration) external {
    PackedAllowance storage allowed = allowance[msg.sender][token][spender];
    allowed.updateAmountAndExpiration(amount, expiration);
    emit Approval(msg.sender, token, spender, amount, expiration);
}
```

The owner slot is `msg.sender`. There is no `owner` parameter, no signature, no nonce, no `extcodesize` check, no EOA assertion anywhere in the path. Any contract — Safe, module, anything — can call it, and the allowance is recorded against that caller.

ERC-1271 becomes relevant **only** on the signature path (`permit` / `permitTransferFrom`), where a contract wants to be the `owner` of an off-chain signature. That path is not used here. And even there Permit2 supports contract signers via ERC-1271 — it is not EOA-only.

Since §1 establishes the Safe is `msg.sender`, the Safe is the Permit2 owner, holds the tokens, and is the account the caveat should measure. All three coincide, which is the property the design needs.

**Address:** `0x000000000022D473030F116dDEE9F6B43aC78BA3` on standard EVM chains, but **not universal** — zkSync Era (324) uses `0x0000000000225e31D15943971F47aD3022F714Fa`, because zkSync's CREATE2 derivation differs. Resolve per `chainId`; do not hardcode.

## 4. Why we do not unify

Unifying would mean changing target contracts, not changing code style. The PositionManager takes ERC-20 allowances; the Universal Router takes only Permit2. Each rail already uses the correct mechanism for its target.

What *should* be uniform is the principle, and it holds across all three:

> **An approval must be bounded by something the signer knows at signing time.**

Yield knows the calldata → `exactExecution`. Arbitrage cannot know it (the opportunity does not exist yet) → bound the *result* via a balance delta, and bound the *allowance* via Permit2's `(amount, expiration)`. This is the same `exactExecution` vs `balanceChange` boundary already described in `HOURGLASS_STRATEGIES.md`: means-enforcers pin *how*, intent-enforcers pin *what result*.

The DCA rail currently satisfies neither.

## 5. Defect: the DCA per-swap cap does not bind

`src/pages/Strategy.tsx` builds the mandate's spend cap with `recipient: moduleAddress`.

The enforcer reads `balanceOf(recipient)` before and after the execution. Per §1 the module holds no tokens — its balance is 0 before and 0 after. **The observed delta is always 0, so it is always within cap. The per-swap loss limit never binds**, while the UI states "Enforced on-chain".

The codebase disagrees with its own call site in three places:

- `src/lib/strategyMandate.ts` — the field's doc comment: *"The account measured — the Safe (funds return here)."*
- `docs/DCA_IMPLEMENTATION_PLAN.md`, `docs/STRATEGY_IMPLEMENTATION_PLAN.md`, `docs/HOURGLASS_STRATEGIES.md` — all three specify `recipient: Safe`.

**Scope of the exposure.** The `functionCall` scope still holds, so this is not unlimited theft of arbitrary assets. But within those targets the agent can spend the Safe's entire funding-token balance in one swap instead of being held to `capPerSwap`.

**Fix:** `recipient: safe.safeAddress`. This changes `mandateSalt` (which includes `recipient`), invalidating existing signed mandates — acceptable, since they enforce nothing today.

**Yield is not affected:** it passes `recipient: safeAddress`, and its rail uses `exactExecution` anyway, so it does not depend on the measured account at all.

### Second, independent DCA weakness

`STRATEGY_SELECTORS` in `src/lib/strategyMandate.ts` includes `approve(address,uint256)`, and `functionCall` compiles to two *independent* caveats — `.addCaveat('allowedTargets', { targets }).addCaveat('allowedMethods', { selectors })`, with no target↔selector pairing. With `targets = [router, ...cappedTokens]`, `approve` is therefore callable on any in-scope target with an arbitrary spender.

Yield escapes this via `exactExecution`; arbitrage escapes it by moving `approve` out of the mandate entirely (§2). DCA has neither guard. Fixing `recipient` (§5) restores the per-swap cap on the funding token but does **not** close this: a cap on one token does not constrain an `approve` of another.

## 6. Open items

- Confirm §1 on-chain (the `msg.sender` item already tracked in `ARBITRAGE_EXECUTIVE_SUMMARY.md`).
- Decide the DCA fix: `recipient` alone, or also constrain/remove `approve` from the mandate.
- `Permit2` does not exist anywhere in the codebase yet; `UNIVERSAL_ROUTER` (`src/config/uniswap.ts`) is wired for mainnet and Base only, with no testnet entry.

## Selector reference

| Signature | Selector |
|---|---|
| `execute(bytes,bytes[],uint256)` — Universal Router | `0x3593564c` |
| `execute(bytes,bytes[])` — Universal Router | `0x24856bc3` |
| `approve(address,address,uint160,uint48)` — Permit2 | `0x87517c45` |
| `transferFrom(address,address,uint160,address)` — Permit2 | `0x36c78516` |
| `approve(address,uint256)` — ERC-20 | `0x095ea7b3` |

Sources: [AllowanceTransfer.sol](https://github.com/Uniswap/permit2/blob/main/src/AllowanceTransfer.sol) · [Permit2Payments.sol](https://github.com/Uniswap/universal-router/blob/main/contracts/modules/Permit2Payments.sol) · [Payments.sol](https://github.com/Uniswap/universal-router/blob/main/contracts/modules/Payments.sol) · [Dispatcher.sol](https://github.com/Uniswap/universal-router/blob/main/contracts/base/Dispatcher.sol) · [permit2-sdk constants](https://github.com/Uniswap/sdks/blob/main/sdks/permit2-sdk/src/constants.ts)
