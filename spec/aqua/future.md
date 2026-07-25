# FUTURE — Aqua ideas out of scope for the current page

Ideas captured for consideration, not yet committed. An idea only becomes a task
on an explicit decision (see `.claude/rules/workflow.md`).

Current scope for reference: the Aqua page builds a constant-product AMM
strategy — `[salt][flatFeeAmountIn][xycSwap]` — and ships it to Aqua. See
`spec/aqua/encoding.md` for the verified encoding and
`.claude/choices/0007`/`0008` for the decisions behind it.

## Price-range selector — concentrated liquidity (2026-07-25)

**Target:** let the Safe choose the price range over which its liquidity is
active, instead of spreading it across the whole `0 → ∞` constant-product curve.
Same capital, more depth where the market actually trades, and more fees per
dollar while in range.

**Instruction:** `XYCConcentrate`, already wired into the deployed
`AquaSwapVMRouter`. Verified present in its opcode table:

| Opcode | Instruction |
|---|---|
| `0x12` | `_xycConcentrateGrowLiquidityXD` (n tokens) |
| `0x13` | `_xycConcentrateGrowLiquidity2D` (a pair — what we would use) |

Note the router wires only the **GrowLiquidity** variants, not
`GrowPriceRange`. That matters: GrowLiquidity keeps a per-order `deltaScales`
entry and multiplies it by the invariant ratio after every swap, so the virtual
liquidity compounds along with the fees rather than staying fixed.

From the deployed source:

```
/// @dev Scales both balanceIn/Out to concentrate liquidity within price bounds
///      for XYCSwap formula, real balances should be drained when price comes
///      to the concentration bounds
```

### How the encoding works

The instruction does **not** take price bounds. It takes virtual reserve
*deltas*, computed off-chain from the bounds. The contract's NatSpec carries a
reference JavaScript implementation, so this is a port rather than a derivation:

```js
function computeDeltas(balanceA, balanceB, price, priceMin, priceMax) {
  const sqrtMin = Math.sqrt(price * 1e18 / priceMin);
  const sqrtMax = Math.sqrt(priceMax * 1e18 / price);
  return {
    deltaA: (price == priceMin) ? 0 : (balanceA * 1e18 / (sqrtMin - 1e18)),
    deltaB: (price == priceMax) ? 0 : (balanceB * 1e18 / (sqrtMax - 1e18)),
  };
}
```

`price` is tokenB/tokenA at 1e18 precision, and the contract requires
`priceMin <= price <= priceMax`.

`build2D` packs the deltas ordered by token address, not by the caller's
argument order:

```solidity
(uint256 deltaLt, uint256 deltaGt) = tokenA < tokenB ? (deltaA, deltaB) : (deltaB, deltaA);
return abi.encodePacked(deltaLt, deltaGt);   // 64 bytes
```

Program becomes `[salt][concentrate][flatFeeAmountIn][xycSwap]` — one extra
instruction, 66 bytes of args including the length byte.

### What it needs that we do not have

- **A spot price at ship time.** `computeDeltas` takes the current price and the
  result is baked into an immutable program, so a wrong price bakes in a wrong
  curve. The repo already reads `sqrtPriceX96` from Uniswap v3 pools in
  `src/lib/uniswapDiscovery.ts`, but `UNISWAP_V3_FACTORY` in
  `src/config/uniswap.ts` is wired for Base Sepolia only — Base mainnet needs
  adding. Alternatives: the 1inch spot-price aggregator, or a Chainlink feed.
- **A re-ranging story.** Strategies are immutable and a docked hash is burned
  forever, so moving a range is dock + ship under a new salt. There is no edit,
  and the UI would have to say so.

### Risks to weigh

- **Out of range is one-sided and idle**, exactly as in Uniswap v3 — the
  docstring is explicit that the real balances drain at the bounds. Narrower
  range, more fees while in range, more time spent earning nothing.
- **More impermanent loss** for the same reason. Concentration is leverage on
  the LP position, not free yield.
- **Instruction ordering becomes load-bearing.** `_xycConcentrateGrowLiquidity*`
  calls `ctx.runLoop()` internally and then `_updateScales`, so it *wraps* the
  rest of the program; the fee instruction does the same. That nests two
  wrapping instructions, and the SwapVM docs call fee ordering
  security-critical. Any change here needs a fork test that compares the quote
  against an independently computed expected value, the way
  `scripts/aqua-fork-check.ts` already does for the flat-fee case.
- **`deltaScales` is router state keyed by order hash**, so the concentration
  multiplier persists across swaps and is not reconstructible from the program
  alone. Anything that displays an expected price has to read it.

### Why it is deferred

A shipped order is not tradable until it is submitted to the 1inch API, which
requires KYB (out of scope). Concentrating liquidity refines the pricing of
liquidity no taker can currently reach, so the immediate benefit is
presentational rather than economic. Revisit when order flow is real — at which
point this is the highest-value next feature on the Aqua surface, because it is
what separates a toy AMM from a competitive one.

### If picked up

1. `src/lib/aqua/concentrate.ts` — port `computeDeltas`, in integer math against
   `bigint` rather than the float reference (`Math.sqrt` on 1e18-scaled values
   loses precision; use an integer sqrt).
2. Unit-test it against values produced by the on-chain library on a fork, not
   against the JavaScript reference.
3. Extend `buildAmmProgram` with an optional range, keeping the unranged path
   byte-identical so existing fixtures still pass.
4. A price source and a range picker in the page, defaulting to full-range so
   the current behaviour stays the default.
5. Extend `scripts/aqua-fork-check.ts` with a ranged strategy: quote inside the
   range, quote at the bound, and confirm the balances drain as documented.
