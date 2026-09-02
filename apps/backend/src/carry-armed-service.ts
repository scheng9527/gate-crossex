import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { nativeMarketAsset } from './market-asset-aliases.js';
import type { LiveMarket } from './market-hub.js';
import { CreateStrategyInputSchema, type CreateStrategyInput, type StrategyRecord, TradingRuntimeError } from './trading-runtime.js';
import {
  evaluateCarryEntryGate,
  type CarryEntryGateConfig,
  type CarryEntryGateMetrics,
} from './carry-entry-gate.js';

export type CarryArmedStatus = 'ARMED' | 'TRIGGERING' | 'TRIGGERED' | 'COMPLETED' | 'CANCELLED' | 'ERROR';

export interface CarryArmedEntry {
  id: string;
  status: CarryArmedStatus;
  asset: string;
  shortSymbol: string;
  longSymbol: string;
  credentialProfileId: string;
  credentialProfileLabel: string;
  strategy: CreateStrategyInput;
  gate: CarryEntryGateConfig;
  lastGateReason: string | null;
  lastGateMetrics: CarryEntryGateMetrics | null;
  triggeredStrategyId: string | null;
  errorReason: string | null;
  createdAt: string;
  updatedAt: string;
  triggeredAt: string | null;
  cancelledAt: string | null;
}

interface CarryArmedRow {
  id: string;
  status: CarryArmedStatus;
  asset: string;
  short_symbol: string;
  long_symbol: string;
  credential_profile_id: string;
  credential_profile_label: string;
  strategy_json: string;
  gate_json: string;
  last_gate_reason: string | null;
  last_gate_metrics_json: string | null;
  triggered_strategy_id: string | null;
  error_reason: string | null;
  created_at: string;
  updated_at: string;
  triggered_at: string | null;
  cancelled_at: string | null;
}

interface GateSnapshot {
  passed: boolean;
  reason: string;
  metrics: CarryEntryGateMetrics | null;
}

export interface CarryArmedServiceOptions {
  market(symbol: string): LiveMarket | null;
  connectionState?(): 'connecting' | 'healthy' | 'reconnecting' | 'stale' | 'disconnected';
  liveTradingEnabled(): boolean;
  activeCredentialProfile(): Promise<{ profileId: string; label: string } | null>;
  startStrategy(strategy: CreateStrategyInput): Promise<StrategyRecord>;
  strategyState(strategyId: string): Promise<{ status: string; progress: number } | null>;
  stopStrategy(strategyId: string): Promise<void>;
  tickIntervalMs?: number;
  marketFreshnessMs?: number;
  now?: () => number;
}

const TERMINAL_STATUSES: CarryArmedStatus[] = ['COMPLETED', 'CANCELLED', 'ERROR'];
const TRANSIENT_START_ERRORS = new Set([
  'live_trading_locked',
  'strategy_market_data_unavailable',
  'too_many_running_strategies',
  'credential_mutation_in_progress',
  'strategy_instrument_constraints_unavailable',
]);

function symbolFor(venue: string, asset: string): string {
  const quote = venue === 'KRAKEN' ? 'USD' : venue === 'HYPERLIQUID' || venue === 'DERIBIT' ? 'USDC' : 'USDT';
  return `${venue}_FUTURE_${nativeMarketAsset(venue, 'FUTURE', asset)}_${quote}`;
}

function safeMetrics(value: string | null): CarryEntryGateMetrics | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as CarryEntryGateMetrics : null;
  } catch {
    return null;
  }
}

function rowToEntry(row: CarryArmedRow): CarryArmedEntry {
  return {
    id: row.id,
    status: row.status,
    asset: row.asset,
    shortSymbol: row.short_symbol,
    longSymbol: row.long_symbol,
    credentialProfileId: row.credential_profile_id,
    credentialProfileLabel: row.credential_profile_label,
    strategy: CreateStrategyInputSchema.parse(JSON.parse(row.strategy_json)),
    gate: JSON.parse(row.gate_json) as CarryEntryGateConfig,
    lastGateReason: row.last_gate_reason,
    lastGateMetrics: safeMetrics(row.last_gate_metrics_json),
    triggeredStrategyId: row.triggered_strategy_id,
    errorReason: row.error_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    triggeredAt: row.triggered_at,
    cancelledAt: row.cancelled_at,
  };
}

/**
 * Persistent user-authorized carry entry watch.
 *
 * ARMED is separate from execution_strategies. Only after every carry condition passes does this
 * service cross the application's existing strategy-start boundary. While that execution strategy
 * is still building its position, this service keeps the Carry Gate live. If conditions disappear
 * before any fill, the execution strategy is stopped and the intent returns to ARMED. If exposure
 * already exists, further entry is stopped and the intent becomes ERROR for manual review.
 */
export class CarryArmedService {
  private readonly tickIntervalMs: number;
  private readonly marketFreshnessMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickPromise: Promise<void> | null = null;
  private readonly retryAfter = new Map<string, number>();
  private readonly lastDecisionWriteAt = new Map<string, number>();

  constructor(
    private readonly database: Database.Database,
    private readonly options: CarryArmedServiceOptions,
  ) {
    this.tickIntervalMs = options.tickIntervalMs ?? 500;
    this.marketFreshnessMs = options.marketFreshnessMs ?? 15_000;
    this.now = options.now ?? Date.now;
    // A crash during TRIGGERING is ambiguous: the execution strategy might already exist. Never
    // auto-retry that state on restart because doing so could duplicate live exposure.
    const now = new Date(this.now()).toISOString();
    database.prepare(`
      UPDATE carry_armed_entries
      SET status = 'ERROR', error_reason = 'trigger_interrupted_review_required', updated_at = ?
      WHERE status = 'TRIGGERING'
    `).run(now);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.tickIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tickPromise?.catch(() => undefined);
  }

  list(): CarryArmedEntry[] {
    return (this.database.prepare(`
      SELECT * FROM carry_armed_entries
      ORDER BY CASE status
        WHEN 'ARMED' THEN 0
        WHEN 'TRIGGERING' THEN 1
        WHEN 'TRIGGERED' THEN 2
        WHEN 'ERROR' THEN 3
        WHEN 'COMPLETED' THEN 4
        ELSE 5 END,
        updated_at DESC
      LIMIT 200
    `).all() as CarryArmedRow[]).map(rowToEntry);
  }

  get(id: string): CarryArmedEntry | null {
    const row = this.database.prepare('SELECT * FROM carry_armed_entries WHERE id = ?').get(id) as CarryArmedRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  arm(input: {
    strategy: unknown;
    gate: CarryEntryGateConfig;
    shortSymbol: string;
    longSymbol: string;
    account: { profileId: string; label: string };
  }): CarryArmedEntry {
    if (!this.options.liveTradingEnabled()) throw new TradingRuntimeError('live_trading_locked', 403);
    const strategy = CreateStrategyInputSchema.parse(input.strategy);
    if (strategy.kind !== 'position' || strategy.reduceOnly || strategy.closePlan) {
      throw new TradingRuntimeError('carry_arm_requires_opening_position_strategy', 400);
    }
    const sellVenue = strategy.leftSide === 'SELL' ? strategy.leftVenue : strategy.rightVenue;
    const buyVenue = strategy.leftSide === 'BUY' ? strategy.leftVenue : strategy.rightVenue;
    const expectedShort = symbolFor(sellVenue, strategy.asset);
    const expectedLong = symbolFor(buyVenue, strategy.asset);
    if (input.shortSymbol !== expectedShort || input.longSymbol !== expectedLong) {
      throw new TradingRuntimeError('carry_arm_symbol_direction_mismatch', 400);
    }
    if (!input.gate.enabled) throw new TradingRuntimeError('carry_gate_disabled', 400);

    const activeCount = this.database.prepare(`
      SELECT COUNT(*) AS count FROM carry_armed_entries
      WHERE status IN ('ARMED', 'TRIGGERING', 'TRIGGERED')
    `).get() as { count: number };
    if (activeCount.count >= 20) throw new TradingRuntimeError('too_many_armed_carry_entries', 409);

    const duplicate = this.database.prepare(`
      SELECT id FROM carry_armed_entries
      WHERE credential_profile_id = ? AND short_symbol = ? AND long_symbol = ?
        AND status IN ('ARMED', 'TRIGGERING', 'TRIGGERED')
      LIMIT 1
    `).get(input.account.profileId, input.shortSymbol, input.longSymbol) as { id: string } | undefined;
    if (duplicate) throw new TradingRuntimeError('carry_entry_already_armed', 409, duplicate.id);

    const id = `CARRY-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
    const now = new Date(this.now()).toISOString();
    this.database.prepare(`
      INSERT INTO carry_armed_entries (
        id, status, asset, short_symbol, long_symbol,
        credential_profile_id, credential_profile_label,
        strategy_json, gate_json, last_gate_reason, last_gate_metrics_json,
        triggered_strategy_id, error_reason, created_at, updated_at, triggered_at, cancelled_at
      ) VALUES (?, 'ARMED', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)
    `).run(
      id,
      strategy.asset,
      input.shortSymbol,
      input.longSymbol,
      input.account.profileId,
      input.account.label,
      JSON.stringify(strategy),
      JSON.stringify(input.gate),
      now,
      now,
    );
    return this.get(id)!;
  }

  async cancel(id: string, accountProfileId: string): Promise<CarryArmedEntry> {
    const entry = this.get(id);
    if (!entry) throw new TradingRuntimeError('carry_armed_entry_not_found', 404);
    if (entry.credentialProfileId !== accountProfileId) {
      throw new TradingRuntimeError('carry_armed_entry_account_not_active', 409);
    }
    if (entry.status === 'TRIGGERING') throw new TradingRuntimeError('carry_armed_entry_triggering', 409);
    if (TERMINAL_STATUSES.includes(entry.status)) return entry;

    if (entry.status === 'TRIGGERED') {
      if (!entry.triggeredStrategyId) throw new TradingRuntimeError('triggered_strategy_missing', 409);
      // Stop further entry through the existing execution engine. This intentionally does not
      // flatten already matched exposure; any existing position remains visible for manual review.
      await this.options.stopStrategy(entry.triggeredStrategyId);
    }

    const now = new Date(this.now()).toISOString();
    this.database.prepare(`
      UPDATE carry_armed_entries
      SET status = 'CANCELLED', cancelled_at = ?, updated_at = ?,
          last_gate_reason = 'manual_cancelled'
      WHERE id = ? AND status IN ('ARMED', 'TRIGGERED')
    `).run(now, now, id);
    this.retryAfter.delete(id);
    return this.get(id)!;
  }

  async tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise;
    const run = this.tickOnce().finally(() => {
      if (this.tickPromise === run) this.tickPromise = null;
    });
    this.tickPromise = run;
    return run;
  }

  private async tickOnce(): Promise<void> {
    const rows = this.database.prepare(`
      SELECT * FROM carry_armed_entries
      WHERE status IN ('ARMED', 'TRIGGERED')
      ORDER BY created_at ASC LIMIT 40
    `).all() as CarryArmedRow[];
    for (const row of rows) {
      const entry = rowToEntry(row);
      try {
        if (entry.status === 'ARMED') await this.evaluateArmed(entry);
        else await this.monitorTriggered(entry);
      } catch {
        this.recordDecision(entry.id, 'carry_gate_internal_error', null, true);
        this.retryAfter.set(entry.id, this.now() + 30_000);
      }
    }
  }

  private freshMarket(symbol: string): LiveMarket | null {
    if (this.options.connectionState && this.options.connectionState() !== 'healthy') return null;
    const market = this.options.market(symbol);
    if (!market || market.source !== 'gate_crossex_websocket') return null;
    const receivedAt = Date.parse(market.receivedAt);
    const sourceAt = Date.parse(market.updatedAt);
    const now = this.now();
    if (!Number.isFinite(receivedAt) || !Number.isFinite(sourceAt)
      || now - receivedAt > this.marketFreshnessMs
      || now - sourceAt > this.marketFreshnessMs
      || sourceAt - now > 2_000) return null;
    return market;
  }

  private gateSnapshot(entry: CarryArmedEntry): GateSnapshot {
    const shortMarket = this.freshMarket(entry.shortSymbol);
    const longMarket = this.freshMarket(entry.longSymbol);
    if (!shortMarket || !longMarket) return { passed: false, reason: 'market_data_unavailable_or_stale', metrics: null };
    const shortBid = new Decimal(shortMarket.bidPrice);
    const longAsk = new Decimal(longMarket.askPrice);
    if (!shortBid.gt(0) || !longAsk.gt(0)) return { passed: false, reason: 'market_data_unavailable_or_stale', metrics: null };
    const basisBps = shortBid.minus(longAsk).div(longAsk).mul(10_000).toNumber();
    const entryThreshold = Number(entry.strategy.entryBps ?? '0');
    if (!Number.isFinite(entryThreshold) || basisBps < entryThreshold) {
      return { passed: false, reason: 'basis_below_entry_threshold', metrics: null };
    }
    const decision = evaluateCarryEntryGate({
      database: this.database,
      config: entry.gate,
      shortMarket,
      longMarket,
      executableBasisBps: basisBps,
      nowMs: this.now(),
    });
    return { passed: decision.passed, reason: decision.reason, metrics: decision.metrics };
  }

  private async accountMatches(entry: CarryArmedEntry): Promise<boolean> {
    const active = await this.options.activeCredentialProfile();
    return active !== null && active.profileId === entry.credentialProfileId;
  }

  private async evaluateArmed(entry: CarryArmedEntry): Promise<void> {
    if ((this.retryAfter.get(entry.id) ?? 0) > this.now()) return;
    if (!this.options.liveTradingEnabled()) {
      this.recordDecision(entry.id, 'live_trading_locked', null);
      return;
    }
    if (!(await this.accountMatches(entry))) {
      this.recordDecision(entry.id, 'account_not_active', null);
      return;
    }
    const snapshot = this.gateSnapshot(entry);
    this.recordDecision(entry.id, snapshot.reason, snapshot.metrics);
    if (!snapshot.passed) return;

    const claimedAt = new Date(this.now()).toISOString();
    const claimed = this.database.prepare(`
      UPDATE carry_armed_entries
      SET status = 'TRIGGERING', last_gate_reason = 'passed', last_gate_metrics_json = ?, updated_at = ?
      WHERE id = ? AND status = 'ARMED'
    `).run(snapshot.metrics ? JSON.stringify(snapshot.metrics) : null, claimedAt, entry.id);
    if (claimed.changes !== 1) return;

    try {
      if (!(await this.accountMatches(entry))) {
        const now = new Date(this.now()).toISOString();
        this.database.prepare(`
          UPDATE carry_armed_entries SET status = 'ARMED', last_gate_reason = 'account_not_active', updated_at = ?
          WHERE id = ? AND status = 'TRIGGERING'
        `).run(now, entry.id);
        return;
      }
      const strategy = await this.options.startStrategy(entry.strategy);
      const triggeredAt = new Date(this.now()).toISOString();
      this.database.prepare(`
        UPDATE carry_armed_entries
        SET status = 'TRIGGERED', triggered_strategy_id = ?, triggered_at = ?, updated_at = ?, error_reason = NULL
        WHERE id = ? AND status = 'TRIGGERING'
      `).run(strategy.id, triggeredAt, triggeredAt, entry.id);
      this.retryAfter.delete(entry.id);
    } catch (error) {
      const code = error instanceof TradingRuntimeError ? error.code : 'strategy_start_failed';
      const now = new Date(this.now()).toISOString();
      if (TRANSIENT_START_ERRORS.has(code)) {
        this.database.prepare(`
          UPDATE carry_armed_entries
          SET status = 'ARMED', last_gate_reason = ?, updated_at = ?
          WHERE id = ? AND status = 'TRIGGERING'
        `).run(`start_retry:${code}`, now, entry.id);
        this.retryAfter.set(entry.id, this.now() + 30_000);
      } else {
        this.database.prepare(`
          UPDATE carry_armed_entries
          SET status = 'ERROR', error_reason = ?, updated_at = ?
          WHERE id = ? AND status = 'TRIGGERING'
        `).run(code, now, entry.id);
      }
    }
  }

  private async monitorTriggered(entry: CarryArmedEntry): Promise<void> {
    if (!entry.triggeredStrategyId || (this.retryAfter.get(entry.id) ?? 0) > this.now()) return;
    const strategy = await this.options.strategyState(entry.triggeredStrategyId);
    if (!strategy) {
      this.markError(entry.id, 'triggered_strategy_missing');
      return;
    }
    if (strategy.status === 'COMPLETED') {
      const now = new Date(this.now()).toISOString();
      this.database.prepare(`
        UPDATE carry_armed_entries
        SET status = 'COMPLETED', last_gate_reason = 'execution_completed', updated_at = ?
        WHERE id = ? AND status = 'TRIGGERED'
      `).run(now, entry.id);
      return;
    }
    if (strategy.status === 'STOPPED') {
      const now = new Date(this.now()).toISOString();
      this.database.prepare(`
        UPDATE carry_armed_entries SET status = 'CANCELLED', cancelled_at = ?, updated_at = ?
        WHERE id = ? AND status = 'TRIGGERED'
      `).run(now, now, entry.id);
      return;
    }
    if (strategy.status === 'PAUSED' || strategy.status === 'PAUSE_PENDING_REMOTE' || strategy.status === 'STOP_PENDING_REMOTE') {
      this.markError(entry.id, `execution_strategy_${strategy.status.toLowerCase()}`);
      return;
    }

    let snapshot: GateSnapshot;
    if (!this.options.liveTradingEnabled()) snapshot = { passed: false, reason: 'live_trading_locked', metrics: null };
    else if (!(await this.accountMatches(entry))) snapshot = { passed: false, reason: 'account_not_active', metrics: null };
    else snapshot = this.gateSnapshot(entry);
    this.recordDecision(entry.id, snapshot.reason, snapshot.metrics);
    if (snapshot.passed) return;

    try {
      await this.options.stopStrategy(entry.triggeredStrategyId);
    } catch {
      this.recordDecision(entry.id, `stop_retry:${snapshot.reason}`, snapshot.metrics, true);
      this.retryAfter.set(entry.id, this.now() + 3_000);
      return;
    }

    const now = new Date(this.now()).toISOString();
    if (!(strategy.progress > 0)) {
      // No matched exposure exists: return to the exact persisted authorization and wait again.
      this.database.prepare(`
        UPDATE carry_armed_entries
        SET status = 'ARMED', triggered_strategy_id = NULL, triggered_at = NULL,
            last_gate_reason = ?, last_gate_metrics_json = ?, error_reason = NULL, updated_at = ?
        WHERE id = ? AND status = 'TRIGGERED'
      `).run(`rearmed:${snapshot.reason}`, snapshot.metrics ? JSON.stringify(snapshot.metrics) : null, now, entry.id);
      this.retryAfter.set(entry.id, this.now() + 1_000);
      return;
    }

    // Some hedged exposure already exists. The execution strategy is stopped so it cannot add more;
    // do not silently re-arm because that would authorize a second position on top of the first.
    this.database.prepare(`
      UPDATE carry_armed_entries
      SET status = 'ERROR', error_reason = ?, last_gate_reason = ?, last_gate_metrics_json = ?, updated_at = ?
      WHERE id = ? AND status = 'TRIGGERED'
    `).run(
      `gate_lost_after_partial_entry_review_required:${snapshot.reason}`,
      snapshot.reason,
      snapshot.metrics ? JSON.stringify(snapshot.metrics) : null,
      now,
      entry.id,
    );
  }

  private markError(id: string, reason: string): void {
    const now = new Date(this.now()).toISOString();
    this.database.prepare(`
      UPDATE carry_armed_entries SET status = 'ERROR', error_reason = ?, updated_at = ?
      WHERE id = ? AND status IN ('ARMED', 'TRIGGERED')
    `).run(reason, now, id);
  }

  private recordDecision(
    id: string,
    reason: string,
    metrics: CarryEntryGateMetrics | null,
    force = false,
  ): void {
    const current = this.database.prepare(`
      SELECT last_gate_reason FROM carry_armed_entries
      WHERE id = ? AND status IN ('ARMED', 'TRIGGERED')
    `).get(id) as { last_gate_reason: string | null } | undefined;
    if (!current) return;
    const nowMs = this.now();
    const lastWriteAt = this.lastDecisionWriteAt.get(id) ?? 0;
    if (!force && current.last_gate_reason === reason && nowMs - lastWriteAt < 30_000) return;
    const now = new Date(nowMs).toISOString();
    this.database.prepare(`
      UPDATE carry_armed_entries
      SET last_gate_reason = ?, last_gate_metrics_json = ?, updated_at = ?
      WHERE id = ? AND status IN ('ARMED', 'TRIGGERED')
    `).run(reason, metrics ? JSON.stringify(metrics) : null, now, id);
    this.lastDecisionWriteAt.set(id, nowMs);
  }
}
