import { buildApp } from './app.js';
import { registerCarryArmedRoutes } from './carry-armed-routes.js';
import { CarryArmedService } from './carry-armed-service.js';
import { registerCarryResearchRoutes } from './carry-research-routes.js';
import { loadConfig } from './config.js';
import { createSystemCredentialVault } from './credential-vault.js';
import { GateCrossExClient } from './crossex-client.js';
import { VenuePublicMarketDataClient } from '@gate-crossex/public-data';
import { openDatabase, prepareDatabaseForClose } from './database.js';
import { FundingObservationStore } from './funding-observations.js';
import { CrossExMarketHub } from './market-hub.js';
import { acquireBackendProcessLock } from './process-lock.js';
import { readHyperliquidPerpMetadata, writeHyperliquidPerpMetadata } from './repositories.js';
import { monitorWindowsServiceParent } from './service-parent-monitor.js';
import { TradingRuntimeError, type StrategyRecord } from './trading-runtime.js';
import { TradingSession } from './trading-session.js';

process.umask(0o077);
const config = loadConfig();
const processLock = acquireBackendProcessLock(config.dataDir);
let database: ReturnType<typeof openDatabase>;
try {
  database = openDatabase(config.databasePath, config.migrationsDir);
} catch (error) {
  processLock.release();
  throw error;
}

const marketHub = new CrossExMarketHub(config.gatePublicWebSocketUrl);
const tradingSession = new TradingSession();
const fundingObservations = new FundingObservationStore(database);
// Capture deterministic boot placeholders before any public socket event can turn a market live.
// The store will not persist a symbol until a later funding-channel change proves the seed was
// replaced by real data.
fundingObservations.primeMarkets(marketHub.snapshot().markets);
const unsubscribeFundingObservations = marketHub.subscribe((message) => {
  if (message.type !== 'market.update') return;
  fundingObservations.observeMarket(message.payload);
});

let app: Awaited<ReturnType<typeof buildApp>>;
let carryArmed: CarryArmedService | null = null;
try {
  const credentialVault = await createSystemCredentialVault(config.credentialEnvPath, {
    disableKeychain: process.env.GCT_DISABLE_OS_KEYCHAIN === '1',
  });
  app = await buildApp({
    config,
    database,
    credentialVault,
    crossExGateway: new GateCrossExClient(fetch, Date.now, config.gateRestBaseUrl),
    publicMarketGateway: new VenuePublicMarketDataClient(fetch, Date.now, {
      hyperliquidMetadataStore: {
        read: () => readHyperliquidPerpMetadata(database),
        write: (snapshot) => writeHyperliquidPerpMetadata(database, snapshot),
      },
    }),
    marketHub,
    tradingSession,
    startMarketStream: true,
  });
  registerCarryResearchRoutes(app, fundingObservations);

  // Use Fastify's in-process request path instead of bypassing the established execution route.
  // A triggered carry entry therefore crosses the same credential, instrument, margin, leverage,
  // order-reconciliation and StrategyEngine boundaries as a manual /api/strategies launch.
  const internalHost = [...config.allowedHosts][0] ?? '127.0.0.1';
  const activeAccount = async (): Promise<{ profileId: string; label: string } | null> => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/onboarding/connection',
      headers: { host: internalHost },
    });
    if (response.statusCode < 200 || response.statusCode >= 300) return null;
    const payload = response.json() as {
      activeProfileId?: unknown;
      label?: unknown;
      profiles?: Array<{ id?: unknown; label?: unknown; active?: unknown }>;
    };
    if (typeof payload.activeProfileId !== 'string') return null;
    const profile = payload.profiles?.find((item) => item.active === true && item.id === payload.activeProfileId);
    const label = typeof profile?.label === 'string'
      ? profile.label
      : typeof payload.label === 'string' ? payload.label : 'Gate CrossEx';
    return { profileId: payload.activeProfileId, label };
  };
  const startStrategy = async (strategy: Parameters<CarryArmedService['arm']>[0]['strategy']): Promise<StrategyRecord> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: {
        host: internalHost,
        'x-gct-trading-intent': 'start-strategy',
        'content-type': 'application/json',
      },
      payload: strategy as object,
    });
    const payload = response.json() as Record<string, unknown>;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const code = typeof payload.error === 'string' ? payload.error : 'strategy_start_failed';
      const label = typeof payload.label === 'string' ? payload.label : undefined;
      throw new TradingRuntimeError(code, response.statusCode, label);
    }
    return payload as unknown as StrategyRecord;
  };
  const strategyState = async (strategyId: string): Promise<{ status: string; progress: number } | null> => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/strategies',
      headers: { host: internalHost },
    });
    if (response.statusCode < 200 || response.statusCode >= 300) return null;
    const payload = response.json() as { strategies?: unknown };
    if (!Array.isArray(payload.strategies)) return null;
    const found = payload.strategies.find((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      return (candidate as { id?: unknown }).id === strategyId;
    }) as { status?: unknown; progress?: unknown } | undefined;
    if (!found || typeof found.status !== 'string' || typeof found.progress !== 'number' || !Number.isFinite(found.progress)) return null;
    return { status: found.status, progress: found.progress };
  };
  const stopStrategy = async (strategyId: string): Promise<void> => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/strategies/${encodeURIComponent(strategyId)}/stop`,
      headers: { host: internalHost, 'x-gct-trading-intent': 'stop-strategy' },
    });
    if (response.statusCode >= 200 && response.statusCode < 300) return;
    const payload = response.json() as Record<string, unknown>;
    const code = typeof payload.error === 'string' ? payload.error : 'strategy_stop_failed';
    const label = typeof payload.label === 'string' ? payload.label : undefined;
    throw new TradingRuntimeError(code, response.statusCode, label);
  };

  carryArmed = new CarryArmedService(database, {
    market: (symbol) => marketHub.market(symbol),
    connectionState: () => marketHub.connectionState(),
    liveTradingEnabled: () => tradingSession.liveTradingEnabled,
    activeCredentialProfile: activeAccount,
    startStrategy,
    strategyState,
    stopStrategy,
  });
  registerCarryArmedRoutes(app, carryArmed, activeAccount);
} catch (error) {
  await carryArmed?.stop().catch(() => undefined);
  unsubscribeFundingObservations();
  marketHub.stop();
  database.close();
  processLock.release();
  throw error;
}

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down local backend');
  try {
    // Stop future carry claims before app.close() begins cancelling/quiescing live orders.
    await carryArmed?.stop();
    await app.close();
    unsubscribeFundingObservations();
    prepareDatabaseForClose(database);
    database.close();
  } catch (error) {
    app.log.error(error, 'shutdown cleanup failed');
  } finally {
    stopServiceParentMonitor?.();
    processLock.release();
  }
}

// npm/shell process groups can forward the same signal after the OS has already delivered it
// directly. Keep these handlers installed so a duplicate cannot restore Node's default
// immediate-termination behavior while asynchronous order quiescence is still running.
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
const stopServiceParentMonitor = monitorWindowsServiceParent(
  () => void shutdown('Windows service parent exited'),
);

// Last-resort safety net: this process may hold live exchange orders, so an error escaping every
// handler must still run app.close() — that path cancels resting strategy quotes — before exit.
function emergencyExit(kind: string, error: unknown): void {
  try {
    app.log.fatal({ err: error }, `${kind}; attempting emergency shutdown`);
  } catch {
    console.error(kind, error);
  }
  setTimeout(() => process.exit(1), 30_000).unref();
  void shutdown(kind).finally(() => process.exit(1));
}

process.on('unhandledRejection', (reason) => emergencyExit('unhandledRejection', reason));
process.on('uncaughtException', (error) => emergencyExit('uncaughtException', error));

try {
  await app.listen({ host: config.host, port: config.port });
  carryArmed?.start();
} catch (error) {
  app.log.error(error, 'failed to start local backend');
  await carryArmed?.stop().catch(() => undefined);
  await app.close().catch((closeError) => app.log.error(closeError, 'startup cleanup failed'));
  unsubscribeFundingObservations();
  prepareDatabaseForClose(database);
  database.close();
  processLock.release();
  process.exitCode = 1;
}
