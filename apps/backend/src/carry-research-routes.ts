import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { summarizeFundingTrajectory } from './carry-analytics.js';
import type { FundingObservationStore } from './funding-observations.js';

const CROSSEX_FUTURE_SYMBOL = /^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/;
const FundingObservationRequestSchema = z.object({
  symbols: z.array(z.string().regex(CROSSEX_FUTURE_SYMBOL)).min(1).max(7),
  durationHours: z.number().int().min(1).max(72).default(24),
});

/**
 * Read-only research endpoints backed exclusively by locally persisted CrossEx public data.
 * They deliberately do not issue venue requests and cannot submit or mutate trading state.
 */
export function registerCarryResearchRoutes(
  app: FastifyInstance,
  observations: FundingObservationStore,
): void {
  app.post('/api/markets/funding-observations', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'funding-observations') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = FundingObservationRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_funding_observation_request' });

    const to = Date.now();
    const from = to - parsed.data.durationHours * 60 * 60_000;
    const since = new Date(from).toISOString();
    const entries = parsed.data.symbols.map((symbol) => {
      const series = observations.readSeries(symbol, since);
      const summary = summarizeFundingTrajectory(series, to);
      return {
        symbol,
        status: series.length > 0 ? ('ok' as const) : ('empty' as const),
        points: series.map((observation) => ({
          timestamp: Date.parse(observation.observedAt),
          rate: observation.fundingRate,
          nextFundingAt: observation.nextFundingAt,
        })).filter((point) => Number.isFinite(point.timestamp)),
        summary,
      };
    });

    return {
      entries,
      from,
      to,
      fetchedAt: new Date(to).toISOString(),
      source: 'local_crossex_funding_observations' as const,
    };
  });
}
