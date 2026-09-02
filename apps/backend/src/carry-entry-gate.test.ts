import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateCarryEntryGate, type CarryEntryGateConfig } from './carry-entry-gate.js';
import type { LiveMarket } from './market-hub.js';

const NOW = Date.parse('2026-09-02T12:00:00.000Z');

function market(overrides: Partial<LiveMarket> & Pick<LiveMarket, 'symbol' | 'venue' | 'fundingRate'>): LiveMarket {
  return {
    symbol: overrides.symbol,
    venue: overrides.venue,
    asset: 'BTC',
    lastPrice: '100',
    bidPrice: '100.10',
    bidSize: '1000',
    askPrice: '100.11',
    askSize: '1000',
    open24h: '99',
    high24h: '102',
    low24h: '98',
    volume24h: '100000',
    quoteVolume24h: '10000000',
    fundingRate: overrides.fundingRate,
    nextFundingAt: new Date(NOW + 60 * 60_000).toISOString(),
    openInterest: '10000',
    openInterestValue: '50000000',
    receivedAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    source: 'gate_crossex_websocket',
    ...overrides,
  };
}

const BASE_GATE: CarryEntryGateConfig = {
  enabled: true,
  minFundingEdgeBps: 5,
  minCarryCushionBps: 1,
  shortFundingIntervalHours: 8,
  longFundingIntervalHours: 8,
  shortExecutionFeeRate: 0.0001,
  longExecutionFeeRate: 0.0001,
  observationLookbackHours: 4,
  minObservationCount: 3,
  maxObservationAgeSeconds: 180,
  requireShortNotDecaying: true,
  requireLongNotRising: false,
  minOpenInterestUsdPerLeg: 5_000_000,
  minSecondsToFunding: 120,
};

function seedTrajectory(
  database: Database.Database,
  symbol: string,
  rates: Array<{ minutesAgo: number; rate: string }>,
): void {
  const insert = database.prepare(`
    INSERT INTO funding_rate_observations (symbol, observed_at, funding_rate, next_funding_at, source)
    VALUES (?, ?, ?, ?, 'gate_crossex_websocket')
  `);
  for (const point of rates) {
    insert.run(
      symbol,
      new Date(NOW - point.minutesAgo * 60_000).toISOString(),
      point.rate,
      new Date(NOW + 60 * 60_000).toISOString(),
    );
  }
}

describe('carry armed entry gate', () => {
  let database: Database.Database;
  const shortSymbol = 'BINANCE_FUTURE_BTC_USDT';
  const longSymbol = 'OKX_FUTURE_BTC_USDT';

  beforeEach(() => {
    database = new Database(':memory:');
    database.exec(`
      CREATE TABLE funding_rate_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        funding_rate TEXT NOT NULL,
        next_funding_at TEXT NOT NULL,
        source TEXT NOT NULL
      );
    `);
    seedTrajectory(database, shortSymbol, [
      { minutesAgo: 120, rate: '0.0007' },
      { minutesAgo: 60, rate: '0.0008' },
      { minutesAgo: 1, rate: '0.0010' },
    ]);
    seedTrajectory(database, longSymbol, [
      { minutesAgo: 120, rate: '0.0001' },
      { minutesAgo: 60, rate: '0.0001' },
      { minutesAgo: 1, rate: '0.0001' },
    ]);
  });

  afterEach(() => database.close());

  const evaluate = (options: {
    gate?: CarryEntryGateConfig;
    short?: LiveMarket;
    long?: LiveMarket;
    basisBps?: number;
  } = {}) => evaluateCarryEntryGate({
    database,
    config: options.gate ?? BASE_GATE,
    shortMarket: options.short ?? market({ symbol: shortSymbol, venue: 'BINANCE', fundingRate: '0.0010' }),
    longMarket: options.long ?? market({ symbol: longSymbol, venue: 'OKX', fundingRate: '0.0001' }),
    executableBasisBps: options.basisBps ?? 3,
    nowMs: NOW,
  });

  it('passes only after funding edge, trajectory, costs, OI, freshness, and timing all pass', () => {
    const decision = evaluate();
    expect(decision.passed).toBe(true);
    expect(decision.reason).toBe('passed');
    expect(decision.metrics.fundingEdgeBps8h).toBeCloseTo(9, 10);
    expect(decision.metrics.roundTripFeeBps).toBeCloseTo(4, 10);
    expect(decision.metrics.carryCushionBps8hProxy).toBeCloseTo(8, 10);
    expect(decision.metrics.shortFundingState).toBe('RISING');
  });

  it('fails closed when the current funding edge is below the user threshold', () => {
    const decision = evaluate({
      gate: { ...BASE_GATE, minFundingEdgeBps: 10 },
    });
    expect(decision.passed).toBe(false);
    expect(decision.reason).toBe('funding_edge_below_minimum');
  });

  it('rejects a decaying short-leg funding trajectory even when the current edge is still high', () => {
    database.prepare('DELETE FROM funding_rate_observations WHERE symbol = ?').run(shortSymbol);
    seedTrajectory(database, shortSymbol, [
      { minutesAgo: 120, rate: '0.0015' },
      { minutesAgo: 60, rate: '0.0013' },
      { minutesAgo: 1, rate: '0.0010' },
    ]);
    const decision = evaluate();
    expect(decision.passed).toBe(false);
    expect(decision.reason).toBe('short_funding_decaying');
  });

  it('rejects stale funding observations', () => {
    database.prepare('DELETE FROM funding_rate_observations').run();
    seedTrajectory(database, shortSymbol, [
      { minutesAgo: 120, rate: '0.0007' },
      { minutesAgo: 60, rate: '0.0008' },
      { minutesAgo: 10, rate: '0.0010' },
    ]);
    seedTrajectory(database, longSymbol, [
      { minutesAgo: 120, rate: '0.0001' },
      { minutesAgo: 60, rate: '0.0001' },
      { minutesAgo: 10, rate: '0.0001' },
    ]);
    const decision = evaluate();
    expect(decision.passed).toBe(false);
    expect(decision.reason).toBe('funding_observation_stale');
  });

  it('rejects insufficient open interest', () => {
    const decision = evaluate({
      long: market({
        symbol: longSymbol,
        venue: 'OKX',
        fundingRate: '0.0001',
        openInterestValue: '1000000',
      }),
    });
    expect(decision.passed).toBe(false);
    expect(decision.reason).toBe('open_interest_below_minimum');
  });

  it('rejects entry when either leg is too close to its next funding event', () => {
    const decision = evaluate({
      short: market({
        symbol: shortSymbol,
        venue: 'BINANCE',
        fundingRate: '0.0010',
        nextFundingAt: new Date(NOW + 30_000).toISOString(),
      }),
    });
    expect(decision.passed).toBe(false);
    expect(decision.reason).toBe('funding_window_too_close');
  });

  it('rejects a carry whose funding plus executable basis cannot cover the configured round trip', () => {
    const decision = evaluate({
      gate: {
        ...BASE_GATE,
        shortExecutionFeeRate: 0.0005,
        longExecutionFeeRate: 0.0005,
        minCarryCushionBps: 0,
      },
      basisBps: 0,
    });
    expect(decision.passed).toBe(false);
    expect(decision.reason).toBe('carry_cushion_below_minimum');
  });
});
