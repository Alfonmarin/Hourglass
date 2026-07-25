# Full HourGlass enforcer suite on Ethereum mainnet and Base

**Status:** Accepted
**Date:** 2026-07-25
**Triggered by:** user request (deploy the complete Delegation Framework caveat enforcer set)
**Supersedes scope of:** `spec/ourglass-enforcer-instances.md` (the three-enforcer subset)

## Context

`spec/ourglass-enforcer-instances.md` deployed three HourGlass-salted enforcers on
2026-06-25 — the exact set HourGlass delegations referenced at the time — and explicitly
rejected the full suite as "~28.3M gas for ~34 enforcers HourGlass never references".

That tradeoff was reversed on user request: the remaining enforcers should exist under
the HourGlass salt so any future delegation shape (batch executions, NFT scopes, logical-OR
caveat trees, multi-token periods) can be built without a new deployment round, and so the
whole set is auditable from one place.

## Decision

Deploy the remaining **34** enforcers from `DeployCaveatEnforcers.s.sol` to Ethereum
mainnet under the same salt `bytes32("OURGLASS")`, and publish verified source for each.

The 3 instances from June (`ERC20PeriodTransferEnforcer`, `TimestampEnforcer`,
`ERC20StreamingEnforcer`) were skipped — their CREATE2 addresses are already occupied.
Total: 37 HourGlass-owned enforcers on chain 1.

As in June, this is **not** custom code: every deployment is unmodified
`@metamask/delegation-framework` bytecode. The recorded deviation remains the
deployment address, not any logic change.

### The salt string stays `OURGLASS` after the rebrand

The CREATE2 salt is the literal ASCII `OURGLASS`
(`0x4f5552474c415353…00`). It is an input to every deployed address, so it cannot be
renamed to `HOURGLASS` without producing a completely different address set and
orphaning all 74 deployments. Code and prose say HourGlass; the salt constant, the
deployer wallet name (`ourglass-deployer` in OWS) and the prior ADR's filename are
historical facts and stay as they are. Anyone recomputing an address must use
`OURGLASS`.

### Deployed addresses (chain 1, salt `OURGLASS`)

| Contract | Address |
|---|---|
| `AllowedCalldataEnforcer` | `0xb418A0C7003F15EEC765D1e1c0E198cA8531fABe` |
| `AllowedMethodsEnforcer` | `0x5FFb84883543A9ED068b1D3DB428037e95C1f26A` |
| `AllowedTargetsEnforcer` | `0x71832d69693A818C7e6163e632c5e3fBedf65362` |
| `BlockNumberEnforcer` | `0xDaE46FC044CC9A03E0274E51c900946F52afC59A` |
| `DeployedEnforcer` | `0x0F40211A6E6B68920690f2a0619714283706E7b3` |
| `ERC20BalanceChangeEnforcer` | `0xf069a9da3987eDA46F711dC40012f3674c6Ad517` |
| `ERC20TransferAmountEnforcer` | `0xf180Ec5552f7251268540f5D0292e44e6cD37491` |
| `ERC721BalanceChangeEnforcer` | `0x3a9aF4D3089F6755f80FF5568268CC1fFd233103` |
| `ERC721TransferEnforcer` | `0x9ACf459b3495626a1Fb7B9e60519582c273295e7` |
| `ERC1155BalanceChangeEnforcer` | `0x341CD2A57ececdAbd41D348b7B616C63D3Ba86f7` |
| `ExactCalldataBatchEnforcer` | `0xE7dB63Ae90BF479Fd3Ca0148Eca73560DD324591` |
| `ExactCalldataEnforcer` | `0x0a1A4e45Be9183465c0f4ac7907605269B2a2573` |
| `ExactExecutionBatchEnforcer` | `0x1c0e253Ef34F05f9Bb35bc373F811A719478a4BB` |
| `ExactExecutionEnforcer` | `0xb0deD8b9f02f8D100078F1AA75Ab9FCDB0D5e729` |
| `IdEnforcer` | `0xF60958a138A885FD10418E7b0D76Ceb45AA25605` |
| `LimitedCallsEnforcer` | `0x0c6a3a33d02c7bEb6B066960CE92DF8CC8EA35C8` |
| `LogicalOrWrapperEnforcer` | `0x3FeDC2610F558E6a0e5c5d9A591E4621C76Ea4f7` |
| `MultiTokenPeriodEnforcer` | `0xAA7E306EcBCFF5A5b37BE13d8a4655E0998D8E87` |
| `NativeBalanceChangeEnforcer` | `0xF069FB64eFDBdA222a86952fC71E87CC6731d545` |
| `ArgsEqualityCheckEnforcer` | `0xAF081f825b0Fd4D1cA3b56E2766248A3689Aea4f` |
| `NativeTokenPaymentEnforcer` | `0xD406D916bA7c155B186639f6f6783A17DFe81B1c` |
| `NativeTokenTransferAmountEnforcer` | `0x953AB69e4aeE3a5e311261573B826Daf29735e52` |
| `NativeTokenStreamingEnforcer` | `0xC2db9C9c3fb2d15d67F4B89B61D6C7332C8B866B` |
| `NativeTokenPeriodTransferEnforcer` | `0xe96539D0aB03b9D7Dc45B2326E2FCdb598b721Dc` |
| `NonceEnforcer` | `0x3266A5827F3fFED7c4BBa1a7F461F46C8D2835b6` |
| `OwnershipTransferEnforcer` | `0xcA474A11645EeCBC225B60944940f81eCd1A7DF8` |
| `RedeemerEnforcer` | `0x787308b5d74797E9FEA19cc186bcF12a19dcABB0` |
| `SpecificActionERC20TransferBatchEnforcer` | `0xE9F0fb5011Db7F59763d999470af2b7f586712a0` |
| `ValueLteEnforcer` | `0x9Fed2C8Bf48Af2c8C0D7E9aE089523Da78D0A076` |
| `ERC20MultiOperationIncreaseBalanceEnforcer` | `0xd1f2F8b225e16A1a22E0C760e25B8da5e58fbb88` |
| `ERC721MultiOperationIncreaseBalanceEnforcer` | `0xF9D8b696eb1FC8E07F17aF2b491B36e63985f814` |
| `ERC1155MultiOperationIncreaseBalanceEnforcer` | `0x7a6c0065a6306b93e82E5Dc7BFD871990a0F910E` |
| `NativeTokenMultiOperationIncreaseBalanceEnforcer` | `0x23D27CaFC7968C9C615a2CcDa9Ca80e36A0f76Ba` |
| `ApprovalRevocationEnforcer` | `0xa92E4c2f624ac064875CA92beDa44629958A0803` |

Constructor arguments (the only two enforcers that take any):
`LogicalOrWrapperEnforcer(DelegationManager)` and
`NativeTokenPaymentEnforcer(DelegationManager, ArgsEqualityCheckEnforcer)`, the latter
pointing at the HourGlass-salted `0xAF081f82…`, not the canonical instance.

- Deployer: OWS `ourglass-deployer` `0x2FF0363132d0dc5feb090790C46B77EF1ce96aa2`, nonces 5–38.
- Gas: 18 518 437 total, ~0.00206 ETH at ~0.09 gwei. Balance after: 0.008430907 ETH.
- Verification: all 34 verified on Etherscan (solc 0.8.23, optimizer 200 runs, evm london),
  confirmed independently via `getsourcecode` rather than trusting forge's exit message.

### Base mainnet (chain 8453), same day

Extended on user request once the deployer was funded on Base. All **37** were
deployed there — none of the June trio existed on Base — from the same wallet and the
same salt, so **every address above is identical on Base**. The `DeleGatorModuleFactory`
already existed on Base (`0x0D0421e43057bf850e243EcDA2AD8966C8D5877B`) and was not
touched.

- Nonces 0–36. Gas: 20 311 167, cost 0.000123 ETH at ~0.006 gwei. Balance after: 0.000877 ETH.
- The OP-stack L1 data fee was priced via the `GasPriceOracle` before committing, not
  assumed: 0.00000067 ETH total across all 37, negligible next to L2 execution.
- All 37 verified on Basescan through the same Etherscan V2 key (`--chain 8453`),
  confirmed independently via `getsourcecode`.

### DeleGatorModuleFactory verification

The factory was unverified on both chains. Its source is not in `delegation-framework`
but in the separate `delegator-safe-module` Foundry project; the deployed runtime
bytecode matches that artifact except in the immutable slots, as expected. Verified on
Etherscan (chain 1) and Basescan (chain 8453) with `constructor-args` = the canonical
`DelegationManager`.

Etherscan's `getsourcecode` lagged several minutes behind forge's `Pass - Verified`,
so a single post-verification API check is not proof of failure — poll before
concluding.

## Alternatives considered

- **`forge script --broadcast`** — rejected, as in June: it wants the raw key. Deployments
  were built as unsigned EIP-1559 payloads and signed by `ows sign tx`, which returns only
  `{recovery_id, signature}`; the signed tx is reassembled and broadcast locally, so the
  key never leaves the encrypted vault. Signature recovery is asserted against the expected
  deployer before every broadcast.
- **Sourcify verification** — attempted and abandoned: forge 1.2.3 speaks Sourcify API v1,
  which is in a scheduled brownout from 2026-07-07 to 2027-01-08. Etherscan covers the
  auditability requirement; Sourcify can be backfilled via its v2 API if wanted.

## Consequences

**Positive:**
- Any future HourGlass delegation shape can reference an HourGlass-owned, source-verified
  enforcer without a deployment round.
- The suite is auditable on Etherscan: identical source to the audited MetaMask artifacts,
  at addresses attributable to HourGlass.

**Negative:**
- 37 addresses to track instead of 3 — though one set covers both chains, since
  CREATE2 makes the addresses identical. Deployed on chain 1 and 8453 only.

**Neutral (worth knowing):**
- `src/config/addresses.ts` carries all 37 as a **registry** (`HourGlassEnforcers`, one
  shared `HOURGLASS_ENFORCERS` constant attached to chains 1 and 8453), but
  `getEnvironment()` still overrides only the three enforcers from June. App behaviour is
  therefore unchanged and no in-flight delegation is affected: adding a key to the registry
  changes nothing about what gets signed. Routing new delegation types through these
  instances means editing `environment.ts` — a separate, deliberate decision.
- The analytics scanner (`website/src/analytics/`) sweeps both chains in parallel and
  tags each charge with its chain. Amounts are grouped by chain+token, never summed
  across chains. A chain whose RPC fails is named in the UI instead of silently
  contributing zero.
- Etherscan auto-matched most contracts as already-verified on submission, because the
  bytecode is identical to the canonical MetaMask enforcers already verified on mainnet.
  That is the intended consequence of deploying unmodified artifacts.

## References

- Prior ADR: `spec/ourglass-enforcer-instances.md`
- Deploy script: `delegation-framework/script/DeployCaveatEnforcers.s.sol` (address set and
  ordering mirrored; `ArgsEqualityCheckEnforcer` precedes `NativeTokenPaymentEnforcer`)
- Related rule: `.claude/rules/metamask-delegation.md`, `.claude/rules/security.md`
