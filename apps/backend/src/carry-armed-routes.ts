import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateStrategyInputSchema, TradingRuntimeError } from './trading-runtime.js';
import type { CarryArmedService } from './carry-armed-service.js';
import type { CarryEntryGateConfig } from './carry-entry-gate.js';

const FUTURE_SYMBOL = /^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/;
const finite = z.number().finite();
const GateSchema = z.object({
  enabled: z.literal(true),
  minFundingEdgeBps: finite.min(0).max(10_000),
  minCarryCushionBps: finite.min(-10_000).max(10_000),
  shortFundingIntervalHours: finite.gt(0).max(24),
  longFundingIntervalHours: finite.gt(0).max(24),
  shortExecutionFeeRate: finite.min(-0.1).max(0.1),
  longExecutionFeeRate: finite.min(-0.1).max(0.1),
  observationLookbackHours: z.number().int().min(1).max(24),
  minObservationCount: z.number().int().min(2).max(2_000),
  maxObservationAgeSeconds: z.number().int().min(30).max(3_600),
  requireShortNotDecaying: z.boolean(),
  requireLongNotRising: z.boolean(),
  minOpenInterestUsdPerLeg: finite.min(0).max(1e15),
  minSecondsToFunding: z.number().int().min(0).max(7_200),
});
const ArmRequestSchema = z.object({
  strategy: CreateStrategyInputSchema,
  gate: GateSchema,
  shortSymbol: z.string().regex(FUTURE_SYMBOL),
  longSymbol: z.string().regex(FUTURE_SYMBOL),
});
const IdSchema = z.object({ id: z.string().regex(/^CARRY-[A-Z0-9]{10}$/) });

export function registerCarryArmedRoutes(
  app: FastifyInstance,
  service: CarryArmedService,
  activeAccount: () => { profileId: string; label: string } | null,
): void {
  app.get('/api/carry/armed', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-read-intent'] !== 'carry-armed') {
        return reply.code(403).send({ error: 'missing_read_intent' });
      }
    },
  }, async () => ({ entries: service.list(), fetchedAt: new Date().toISOString() }));

  app.post('/api/carry/armed', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'arm-carry-entry') {
        return reply.code(403).send({ error: 'missing_trading_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = ArmRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_carry_arm_request',
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const account = activeAccount();
    if (!account) return reply.code(409).send({ error: 'credential_not_configured' });
    try {
      return service.arm({
        strategy: parsed.data.strategy,
        gate: parsed.data.gate as CarryEntryGateConfig,
        shortSymbol: parsed.data.shortSymbol,
        longSymbol: parsed.data.longSymbol,
        account,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'invalid_strategy', issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
      }
      if (error instanceof TradingRuntimeError) {
        return reply.code(error.statusCode).send({ error: error.code, ...(error.label ? { label: error.label } : {}) });
      }
      request.log.error({ error }, 'carry entry arm failed');
      return reply.code(500).send({ error: 'carry_arm_failed' });
    }
  });

  app.post('/api/carry/armed/:id/cancel', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandler: async (request, reply) => {
      if (request.headers['x-gct-trading-intent'] !== 'cancel-carry-entry') {
        return reply.code(403).send({ error: 'missing_trading_intent' });
      }
    },
  }, async (request, reply) => {
    const parsed = IdSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_carry_armed_id' });
    const account = activeAccount();
    if (!account) return reply.code(409).send({ error: 'credential_not_configured' });
    try {
      return service.cancel(parsed.data.id, account.profileId);
    } catch (error) {
      if (error instanceof TradingRuntimeError) {
        return reply.code(error.statusCode).send({ error: error.code, ...(error.label ? { label: error.label } : {}) });
      }
      request.log.error({ error }, 'carry entry cancel failed');
      return reply.code(500).send({ error: 'carry_cancel_failed' });
    }
  });
}
