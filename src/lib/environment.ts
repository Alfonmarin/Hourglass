import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit'
import { addresses } from '../config/addresses'

/**
 * Get the SmartAccountsEnvironment for the current chain.
 *
 * Resolves all contract addresses (DelegationManager, enforcers, etc.) from the SDK's
 * built-in deployment registry, then — on chains where HourGlass has deployed its own
 * audited enforcer instances — overrides the three enforcers HourGlass delegations use
 * so new delegations reference the HourGlass instances. The period enforcer's
 * TransferredInPeriod events are then attributable to HourGlass by emitter address (the
 * analytics marker; see spec/plan-analytics.md and
 * spec/hourglass-enforcer-suite.md).
 *
 * `addresses[chainId].hourglass` is a registry of all 37 deployed instances, but only the
 * three below are overridden. Adding a key there does not change what gets signed; routing
 * another delegation type through an HourGlass instance means adding it here, deliberately.
 *
 * Chains without an `hourglass` block fall through to the canonical SDK addresses.
 */
export function getEnvironment(chainId: number) {
  const env = getSmartAccountsEnvironment(chainId)
  const hourglass = addresses[chainId]?.hourglass
  if (!hourglass) return env

  return {
    ...env,
    caveatEnforcers: {
      ...env.caveatEnforcers,
      ERC20PeriodTransferEnforcer: hourglass.erc20PeriodTransferEnforcer,
      TimestampEnforcer: hourglass.timestampEnforcer,
      ERC20StreamingEnforcer: hourglass.erc20StreamingEnforcer,
    },
  }
}
