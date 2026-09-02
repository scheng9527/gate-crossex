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
  now?: () => number;
}

interface LastPersistedObservation {
  observedAtMs: number;
  fundingRate: number;
}

interface LastSeenFunding {
  fundingRate: number;
  nextFundingAt: string;
}

const DEFAULT_MIN_INTERVAL_MS = 30_000;
const DEFAULT_MIN_RATE_DELTA_BPS = 0.5;

/**
 * Persist the funding-rate formation process from the existing CrossEx market stream.
 *
 * `LiveMarket.updatedAt` belongs to the ticker frame and intentionally does not advance on
 * funding/OI pushes because the strategy engine uses it as executable-price freshness evidence.
 * This store therefore timestamps observations with backend wall-clock time instead.
 *
 * The market hub is born with deterministic seed funding values. Call `primeMarkets()` before the
 * stream starts; a symbol is not eligible for persistence until a later market update changes its
 * funding rate or next-funding timestamp. That proves a real funding-channel frame has replaced
 * the seed. Once confirmed, intervening ticker updates can provide the requested periodic sample.
 */
export class FundingObservationStore {
  private readonly lastPersisted = new Map<string, LastPersistedObservation>();
  private readonly lastSeenFunding = new Map<string, LastSeenFunding>();
  private readonly confirmedFundingSymbols = new Set<string>();
  private readonly minIntervalMs: number;
  private readonly minRateDeltaBps: number;
  private readonly now: () => number;
  private readonly insertStatement: Database.Statement;

  constructor(
    private readonly database: Database.Database,
    options: FundingObservationStoreOptions = {},
  ) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.minRateDeltaBps = options.minRateDeltaBps ?? DEFAULT_MIN_RATE_DELTA_BPS;
    this.now = options.now ?? Date.now;
    this.insertStatement = database.prepare(`
      INSERT INTO funding_rate_observations (
        symbol, observed_at, funding_rate, next_funding_at, source
      ) VALUES (?, ?, ?, ?, ?)
    `);
  }

  /** Capture the hub's boot-time funding placeholders so they can never become research data. */
  primeMarkets(markets: readonly LiveMarket[]): void {
    for (const market of markets) {
      const rate = Number(market.fundingRate);
      if (!Number.isFinite(rate)) continue;
      this.lastSeenFunding.set(market.symbol, {
        fundingRate: rate,
        nextFundingAt: market.nextFundingAt,
      });
    }
  }

  observeMarket(market: LiveMarket): boolean {
    const rate = Number(market.fundingRate);
    if (!Number.isFinite(rate)) return false;

    const previousSeen = this.lastSeenFunding.get(market.symbol);
    const fundingChanged = previousSeen !== undefined && (
      previousSeen.fundingRate !== rate || previousSeen.nextFundingAt !== market.nextFundingAt
    );
    this.lastSeenFunding.set(market.symbol, {
      fundingRate: rate,
      nextFundingAt: market.nextFundingAt,
    });
    if (fundingChanged) this.confirmedFundingSymbols.add(market.symbol);

    // A ticker can become live before the first funding push. Do not persist its inherited seed.
    if (market.source !== 'gate_crossex_websocket' || !this.confirmedFundingSymbols.has(market.symbol)) {
      return false;
    }

    const observedAtMs = this.now();
    if (!Number.isFinite(observedAtMs) || observedAtMs <= 0) return false;
    const previous = this.lastPersisted.get(market.symbol);
    if (previous) {
      const elapsedMs = observedAtMs - previous.observedAtMs;
      const deltaBps = Math.abs(rate - previous.fundingRate) * 10_000;
      if (elapsedMs < this.minIntervalMs && deltaBps < this.minRateDeltaBps) return false;
    }

    const observedAt = new Date(observedAtMs).toISOString();
    this.insertStatement.run(
      market.symbol,
      observedAt,
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
