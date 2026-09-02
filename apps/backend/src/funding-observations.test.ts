import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { FundingObservationStore } from './funding-observations.js';
import type { LiveMarket } from './market-hub.js';

function market(overrides: Partial<LiveMarket> = {}): LiveMarket {
  return {
    symbol: 'BINANCE_FUTURE_BTC_USDT',
    venue: 'BINANCE',
    asset: 'BTC',
    lastPrice: '100',
    bidPrice: '99.9',
    bidSize: '1',
    askPrice: '100.1',
    askSize: '1',
    open24h: '98',
    high24h: '102',
    low24h: '97',
    volume24h: '1',
    quoteVolume24h: '100',
    fundingRate: '0.0001',
    nextFundingAt: '2026-09-02T16:00:00.000Z',
    openInterest: '1',
    openInterestValue: '100',
    receivedAt: '2026-09-02T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:00.000Z',
    source: 'demo_seed',
    ...overrides,
  };
}

function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE funding_rate_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      funding_rate TEXT NOT NULL,
      next_funding_at TEXT NOT NULL,
      source TEXT NOT NULL
    )
  `);
  return db;
}

describe('FundingObservationStore', () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('does not persist ticker-live seed funding before a funding-channel change', () => {
    const db = database(); databases.push(db);
    const store = new FundingObservationStore(db, { now: () => Date.parse('2026-09-02T08:01:00.000Z') });
    const seed = market();
    store.primeMarkets([seed]);

    expect(store.observeMarket({ ...seed, source: 'gate_crossex_websocket' })).toBe(false);
    expect(store.readSeries(seed.symbol, '2026-09-01T00:00:00.000Z')).toEqual([]);
  });

  it('uses wall-clock observation time after a real funding change confirms the symbol', () => {
    const db = database(); databases.push(db);
    let now = Date.parse('2026-09-02T08:02:00.000Z');
    const store = new FundingObservationStore(db, { now: () => now });
    const seed = market();
    store.primeMarkets([seed]);

    const realFunding = { ...seed, fundingRate: '0.0002', source: 'gate_crossex_websocket' as const };
    expect(store.observeMarket(realFunding)).toBe(true);
    const [point] = store.readSeries(seed.symbol, '2026-09-01T00:00:00.000Z');
    expect(point?.observedAt).toBe('2026-09-02T08:02:00.000Z');
    expect(point?.fundingRate).toBe('0.0002');

    now += 10_000;
    expect(store.observeMarket(realFunding)).toBe(false);
    now += 20_000;
    expect(store.observeMarket(realFunding)).toBe(true);
  });

  it('persists a material funding move before the periodic interval elapses', () => {
    const db = database(); databases.push(db);
    let now = Date.parse('2026-09-02T08:02:00.000Z');
    const store = new FundingObservationStore(db, { now: () => now, minRateDeltaBps: 0.5 });
    const seed = market();
    store.primeMarkets([seed]);
    expect(store.observeMarket({ ...seed, fundingRate: '0.0002', source: 'gate_crossex_websocket' })).toBe(true);

    now += 1_000;
    // 0.00006 fraction = 0.6 bp.
    expect(store.observeMarket({ ...seed, fundingRate: '0.00026', source: 'gate_crossex_websocket' })).toBe(true);
    expect(store.readSeries(seed.symbol, '2026-09-01T00:00:00.000Z')).toHaveLength(2);
  });
});
