import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerCarryResearchRoutes } from './carry-research-routes.js';
import type { FundingObservationStore } from './funding-observations.js';

function fakeStore(): FundingObservationStore {
  return {
    readSeries(symbol: string) {
      if (symbol !== 'BINANCE_FUTURE_BTC_USDT') return [];
      return [
        {
          symbol,
          observedAt: '2026-09-02T00:00:00.000Z',
          fundingRate: '0.0001',
          nextFundingAt: '2026-09-02T08:00:00.000Z',
          source: 'gate_crossex_websocket',
        },
        {
          symbol,
          observedAt: '2026-09-02T01:00:00.000Z',
          fundingRate: '0.0002',
          nextFundingAt: '2026-09-02T08:00:00.000Z',
          source: 'gate_crossex_websocket',
        },
      ];
    },
  } as unknown as FundingObservationStore;
}

describe('carry research routes', () => {
  it('requires the explicit read intent header', async () => {
    const app = Fastify();
    registerCarryResearchRoutes(app, fakeStore());

    const response = await app.inject({
      method: 'POST',
      url: '/api/markets/funding-observations',
      payload: { symbols: ['BINANCE_FUTURE_BTC_USDT'], durationHours: 24 },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'missing_read_intent' });
    await app.close();
  });

  it('returns locally observed formation points and a trajectory summary', async () => {
    const app = Fastify();
    registerCarryResearchRoutes(app, fakeStore());

    const response = await app.inject({
      method: 'POST',
      url: '/api/markets/funding-observations',
      headers: { 'x-gct-read-intent': 'funding-observations' },
      payload: { symbols: ['BINANCE_FUTURE_BTC_USDT'], durationHours: 24 },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.source).toBe('local_crossex_funding_observations');
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].symbol).toBe('BINANCE_FUTURE_BTC_USDT');
    expect(body.entries[0].status).toBe('ok');
    expect(body.entries[0].points).toHaveLength(2);
    expect(body.entries[0].summary.observationCount).toBe(2);
    await app.close();
  });

  it('rejects unsupported symbols before accessing the store', async () => {
    const app = Fastify();
    registerCarryResearchRoutes(app, fakeStore());

    const response = await app.inject({
      method: 'POST',
      url: '/api/markets/funding-observations',
      headers: { 'x-gct-read-intent': 'funding-observations' },
      payload: { symbols: ['NOT_A_CROSSEX_SYMBOL'], durationHours: 24 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_funding_observation_request' });
    await app.close();
  });
});
