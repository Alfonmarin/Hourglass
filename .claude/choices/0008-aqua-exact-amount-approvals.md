# 0008 — Aqua ships with exact-amount approvals, and a salt on every strategy

**Status:** Accepted
**Date:** 2026-07-25
**Triggered by:** user request (Aqua LP page)

## Context

Two choices in the Aqua ship batch are not obvious, and both were forced by
behaviour verified on a Base fork rather than by anything in the docs.

**Approvals.** Aqua never holds tokens. It records a virtual balance and, when a
taker swaps, calls `transferFrom` on the maker. So a live strategy requires a
standing ERC-20 allowance from the Safe to Aqua. As swaps run, `push()` can grow
a token's virtual balance *above* what was shipped, and a later `pull()` needs
allowance to cover that grown balance — which argues for approving generously.

**Strategy identity.** `ship()` requires `tokensCount == 0` for the strategy
hash, and `dock()` writes `255`. A hash is therefore burned permanently the
moment it is docked: re-shipping identical parameters reverts
`StrategiesMustBeImmutable` forever. Verified directly — see
`scripts/aqua-spike.sh` step 5.

## Decision

**Approve the exact shipped amount, never `type(uint256).max`.** A strategy that
trades heavily can stall until the Safe re-approves; the page says so.

**Emit a fresh 4-byte salt instruction (`0x15`) on every ship.** `Controls._salt`
is a no-op whose only effect is to perturb the program bytes and therefore the
hash. It is not exposed as a user-facing option.

## Alternatives considered

- **Unlimited approval** — makes a strategy trade indefinitely without
  maintenance, and is what most LP UIs do. Rejected: an unlimited allowance from
  a DAO treasury to a protocol with ~109 transactions of history is a poor
  trade against an inconvenience that is recoverable with one transaction.
- **Approve a multiple of the shipped amount (say 2×)** — an arbitrary constant
  that is neither honest about the limit nor generous enough to remove it.
- **No salt, and surface `StrategiesMustBeImmutable` as an error** — pushes an
  unrecoverable protocol detail onto the user for no benefit. A user who docks a
  position could never re-create it at the same terms.
- **Derive the salt from the terms plus a nonce** — deterministic and
  reproducible, but requires tracking a nonce per terms; randomness is
  sufficient across a 2^32 space for a per-Safe strategy list.

## Consequences

**Positive:**
- The Safe's exposure to Aqua is bounded by what it deliberately shipped, and
  drops to zero on dock (the dock batch also revokes).
- Docking is always reversible: the same terms can be re-shipped under a new salt.

**Negative:**
- A strategy whose inbound leg grows past the approval stops being pullable
  until re-approved. The position surface flags this as "not backed", but the
  Safe must act on it.
- Two strategies with identical terms are distinct on-chain and appear as
  separate rows. That is the protocol's model, not a display artefact.

**Neutral (worth knowing):**
- `dock()` moves no tokens, so unwinding costs only gas.
- `ship()` checks neither balance nor allowance, so "shipped" never implies
  "funded" — hence the separate backed/not-backed state in `useAquaPositions`.

## References

- Encoding reference: `spec/aqua-swapvm-encoding.md`
- Reproduction: `scripts/aqua-spike.sh`, `scripts/aqua-fork-check.ts`
- Related ADR: `.claude/choices/0007-aqua-encoding-pinned-to-deployed-build.md`
