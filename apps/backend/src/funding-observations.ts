import type Database from 'better-sqlite3';
import type { LiveMarket } from './market-hub.js';

export interface FundingObservation {
  symbol: string;
  observedAt: string;
  fundingRate: string;
  nextFundingAt: string;
  source: string;
}

export interface FundingObservationStoreOptions {
  minIntervalMs?: number;
  minRateDeltaBps?: number;
}

interface LastPersistedObservation {
  observedAtMs: number;
  fundingRate: number;
}

const DEFAULT_MIN_INTERVAL_MS = 30_000;
const DEFAULT_MIN_RATE_DELTA_BPS = 0.5;

export class FundingObservationStore {
  private readonly lastPersisted = new Map<string, LastPersistedObservation>();
  private readonly minIntervalMs: number;
  private readonly minRateDeltaBps: number;
  private readonly insertStatement: Database.Statement;

  constructor(
    private readonly database: Database.Database,
    options: FundingObservationStoreOptions = {},
  ) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.minRateDeltaBps = options.minRateDeltaBps ?? DEFAULT_MIN_RATE_DELTA_BPS;
    this.insertStatement = database.prepare(`
      INSERT INTO funding_rate_observations (
        symbol, observed_at, funding_rate, next_funding_at, source
      ) VALUES (?, ?, ?, ?, ?)
    `);
  }

  observeMarket(market: LiveMarket): boolean {
    if (market.source !== 'gate_crossex_websocket') return false;

    const rate = Number(market.fundingRate);
    const observedAtMs = Date.parse(market.updatedAt);
    if (!Number.isFinite(rate) || !Number.isFinite(observedAtMs)) return false;

    const previous = this.lastPersisted.get(market.symbol);
    if (previous) {
      const elapsedMs = observedAtMs - previous.observedAtMs;
      const deltaBps = Math.abs(rate - previous.fundingRate) * 10_000;
      if (elapsedMs < this.minIntervalMs && deltaBps < this.minRateDeltaBps) return false;
    }

    this.insertStatement.run(
      market.symbol,
      market.updatedAt,
      market.fundingRate,
      market.nextFundingAt,
      market.source,
    );
    this.lastPersisted.set(market.symbol, { observedAtMs, fundingRate: rate });
    return true;
  }

  readSeries(symbol: string, since: string, limit = 10_000): FundingObservation[] {
    const safeLimit = Math.max(1, Math.min(50_000, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT symbol, observed_at, funding_rate, next_funding_at, source
      FROM funding_rate_observations
      WHERE symbol = ? AND observed_at >= ?
      ORDER BY observed_at ASC
      LIMIT ?
    `).all(symbol, since, safeLimit) as Array<{
      symbol: string;
      observed_at: string;
      funding_rate: string;
      next_funding_at: string;
      source: string;
    }>;

    return rows.map((row) => ({
      symbol: row.symbol,
      observedAt: row.observed_at,
      fundingRate: row.funding_rate,
      nextFundingAt: row.next_funding_at,
      source: row.source,
    }));
  }

  readLatest(symbol: string): FundingObservation | null {
    const row = this.database.prepare(`
      SELECT symbol, observed_at, funding_rate, next_funding_at, source
      FROM funding_rate_observations
      WHERE symbol = ?
      ORDER BY observed_at DESC
      LIMIT 1
    `).get(symbol) as {
      symbol: string;
      observed_at: string;
      funding_rate: string;
      next_funding_at: string;
      source: string;
    } | undefined;

    return row ? {
      symbol: row.symbol,
      observedAt: row.observed_at,
      fundingRate: row.funding_rate,
      nextFundingAt: row.next_funding_at,
      source: row.source,
    } : null;
  }
}
