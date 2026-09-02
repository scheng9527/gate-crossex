import { buildApp } from './app.js';
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
const fundingObservations = new FundingObservationStore(database);
const unsubscribeFundingObservations = marketHub.subscribe((message) => {
  if (message.type !== 'market.update') return;
  fundingObservations.observeMarket(message.payload);
});

let app: Awaited<ReturnType<typeof buildApp>>;
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
    startMarketStream: true,
  });
} catch (error) {
  unsubscribeFundingObservations();
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
} catch (error) {
  app.log.error(error, 'failed to start local backend');
  await app.close().catch((closeError) => app.log.error(closeError, 'startup cleanup failed'));
  unsubscribeFundingObservations();
  prepareDatabaseForClose(database);
  database.close();
  processLock.release();
  process.exitCode = 1;
}
