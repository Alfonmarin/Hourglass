import { createPublicClient, http, parseAbiItem, type Address } from 'viem';
import { ANALYTICS_CHAINS, HOURGLASS_ENFORCERS, type AnalyticsChain } from './config';

type ChargeKind = 'subscription' | 'stream';

/** One attributable charge (subscription) or claim (stream), normalized. */
export interface Charge {
  kind: ChargeKind;
  /** Chain the event was emitted on. Amounts are only comparable within a chain+token. */
  chainId: number;
  delegationHash: string;
  token: Address;
  /** The receiver (delegate / payee) that redeemed. */
  redeemer: Address;
  /** The funding side recorded by the enforcer. */
  sender: Address;
  /** Per-charge amount in the token's raw units. */
  amount: bigint;
  /** Unix seconds, from the event's own timestamp field. */
  timestamp: number;
  txHash: string;
}

const PERIOD_EVENT = parseAbiItem(
  'event TransferredInPeriod(address indexed sender, address indexed redeemer, bytes32 indexed delegationHash, address token, uint256 periodAmount, uint256 periodDuration, uint256 startDate, uint256 transferredInCurrentPeriod, uint256 transferTimestamp)',
);
const STREAM_EVENT = parseAbiItem(
  'event IncreasedSpentMap(address indexed sender, address indexed redeemer, bytes32 indexed delegationHash, address token, uint256 initialAmount, uint256 maxAmount, uint256 amountPerSecond, uint256 startTime, uint256 spent, uint256 lastUpdateTimestamp)',
);

// Per-charge cumulative-counter rows, decoupled from viem's Log type so the delta
// logic below is plain and testable.
interface PeriodRow {
  chainId: number;
  delegationHash: string;
  token: Address;
  redeemer: Address;
  sender: Address;
  cumulative: bigint;
  periodDuration: bigint;
  startDate: bigint;
  ts: bigint;
  txHash: string;
}
interface StreamRow {
  chainId: number;
  delegationHash: string;
  token: Address;
  redeemer: Address;
  sender: Address;
  spent: bigint;
  ts: bigint;
  txHash: string;
}

/**
 * Run `fetch` across [fromBlock, toBlock] in windows. If a window is rejected
 * (provider range/result caps vary) the step is halved and retried, down to a
 * single block, so the scan degrades gracefully; it recovers toward the default
 * window after a success.
 */
async function paginate<T>(
  fromBlock: bigint,
  toBlock: bigint,
  chunkBlocks: bigint,
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  let start = fromBlock;
  let step = chunkBlocks;
  while (start <= toBlock) {
    const end = start + step - 1n > toBlock ? toBlock : start + step - 1n;
    try {
      out.push(...(await fetch(start, end)));
      start = end + 1n;
      if (step < chunkBlocks) step = step * 2n > chunkBlocks ? chunkBlocks : step * 2n;
    } catch (err) {
      if (step <= 1n) throw err;
      step = step / 2n;
    }
  }
  return out;
}

/** Rows for one delegation must not mix chains — the counters are per-chain state. */
function groupRows<T extends { chainId: number; delegationHash: string }>(rows: T[]): T[][] {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const key = `${r.chainId}:${r.delegationHash}`;
    const group = map.get(key) ?? [];
    group.push(r);
    map.set(key, group);
  }
  return [...map.values()];
}

/**
 * Subscription charge = the in-period delta of the cumulative counter, which
 * resets each period. Period boundaries come from (startDate, periodDuration, ts),
 * so a new period's first charge is counted in full rather than as a delta against
 * the prior period.
 */
function periodCharges(rows: PeriodRow[]): Charge[] {
  const charges: Charge[] = [];
  for (const group of groupRows(rows)) {
    group.sort((a, b) => Number(a.ts - b.ts));
    let prevPeriod: bigint | null = null;
    let prevCumulative = 0n;
    for (const r of group) {
      const duration = r.periodDuration > 0n ? r.periodDuration : 1n;
      const period = (r.ts - r.startDate) / duration;
      const amount = prevPeriod !== null && period === prevPeriod ? r.cumulative - prevCumulative : r.cumulative;
      prevPeriod = period;
      prevCumulative = r.cumulative;
      charges.push({
        kind: 'subscription',
        chainId: r.chainId,
        delegationHash: r.delegationHash,
        token: r.token,
        redeemer: r.redeemer,
        sender: r.sender,
        amount: amount > 0n ? amount : 0n,
        timestamp: Number(r.ts),
        txHash: r.txHash,
      });
    }
  }
  return charges;
}

/** Stream claim = delta of lifetime-cumulative `spent` (monotonic, no reset). */
function streamCharges(rows: StreamRow[]): Charge[] {
  const charges: Charge[] = [];
  for (const group of groupRows(rows)) {
    group.sort((a, b) => Number(a.ts - b.ts));
    let prevSpent = 0n;
    for (const r of group) {
      const amount = r.spent - prevSpent;
      prevSpent = r.spent;
      charges.push({
        kind: 'stream',
        chainId: r.chainId,
        delegationHash: r.delegationHash,
        token: r.token,
        redeemer: r.redeemer,
        sender: r.sender,
        amount: amount > 0n ? amount : 0n,
        timestamp: Number(r.ts),
        txHash: r.txHash,
      });
    }
  }
  return charges;
}

/** Sweep one chain's enforcer instances. */
async function loadChainCharges({ chain, rpcUrl, lookbackBlocks, chunkBlocks }: AnalyticsChain): Promise<Charge[]> {
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const latest = await client.getBlockNumber();
  const fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;

  const [periodLogs, streamLogs] = await Promise.all([
    paginate(fromBlock, latest, chunkBlocks, (from, to) =>
      client.getLogs({ address: HOURGLASS_ENFORCERS.period, event: PERIOD_EVENT, fromBlock: from, toBlock: to }),
    ),
    paginate(fromBlock, latest, chunkBlocks, (from, to) =>
      client.getLogs({ address: HOURGLASS_ENFORCERS.stream, event: STREAM_EVENT, fromBlock: from, toBlock: to }),
    ),
  ]);

  const periodRows: PeriodRow[] = periodLogs.map((l) => ({
    chainId: chain.id,
    delegationHash: l.args.delegationHash!,
    token: l.args.token!,
    redeemer: l.args.redeemer!,
    sender: l.args.sender!,
    cumulative: l.args.transferredInCurrentPeriod!,
    periodDuration: l.args.periodDuration!,
    startDate: l.args.startDate!,
    ts: l.args.transferTimestamp!,
    txHash: l.transactionHash,
  }));
  const streamRows: StreamRow[] = streamLogs.map((l) => ({
    chainId: chain.id,
    delegationHash: l.args.delegationHash!,
    token: l.args.token!,
    redeemer: l.args.redeemer!,
    sender: l.args.sender!,
    spent: l.args.spent!,
    ts: l.args.lastUpdateTimestamp!,
    txHash: l.transactionHash,
  }));

  return [...periodCharges(periodRows), ...streamCharges(streamRows)];
}

/** A chain whose sweep failed, so the UI can say so instead of implying zero. */
export interface ChainFailure {
  name: string;
  reason: string;
}

export interface ChargesResult {
  charges: Charge[];
  failures: ChainFailure[];
}

/**
 * Load all attributable charges + claims from the HourGlass enforcer instances,
 * across every configured chain.
 *
 * A chain that fails to respond is surfaced rather than silently dropped: a partial
 * total that looks complete is worse than a visible gap.
 */
export async function loadCharges(): Promise<ChargesResult> {
  const settled = await Promise.allSettled(ANALYTICS_CHAINS.map((c) => loadChainCharges(c)));

  const charges: Charge[] = [];
  const failures: ChainFailure[] = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      charges.push(...result.value);
    } else {
      const reason: unknown = result.reason;
      failures.push({
        name: ANALYTICS_CHAINS[i].name,
        reason: reason instanceof Error ? reason.message : 'unreachable',
      });
    }
  });

  return { charges: charges.sort((a, b) => a.timestamp - b.timestamp), failures };
}
