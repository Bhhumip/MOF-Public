const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const http = require('node:http');
const { getConfig } = require('./config');
//const { createSqliteJobStore } = require('./jobs-sqlite');
const { createWebhookHandler } = require('./webhooks');
const { createShopifyClient } = require('./shopify');
const { createReturnOrchestrator } = require('./returns');
const { createMongoJobStore } = require('./jobs-mongodb');
const { createManualReviewQueue } = require('./manual-review');
//const { createRedboxClient } = require('./carriers/redbox');
//const { createAramexClient } = require('./carriers/aramex');
const { createRedboxWebhookHandler, verifyBearerToken } = require('./carriers/redbox-webhook');
const { createStatusSync } = require('./status-sync');
const { buildCarriers } = require('./carriers/factory');
const { createTrackingSync } = require('./tracking-sync');
const { createPoller } = require('./poller');
const { createLogger } = require('./logger');
const { createCleanup } = require('./cleanup');
function createServer({ config = getConfig(), jobStore: injectedJobStore } = {}) {
  const shopify = createShopifyClient(config.shopify);
  const manualReviewQueue = createManualReviewQueue({
    shopify
  });

  // const carriers = {
  //   redbox: createRedboxClient(config.carriers.redbox),
  //   aramex: createAramexClient(config.carriers.aramex)
  // };
  const jobStore = injectedJobStore ?? (
    config.jobStore.type === 'mongodb'
      ? createMongoJobStore({
        uri: config.jobStore.mongodbUri,
        databaseName: config.jobStore.mongodbDatabase
      })
      : require('./jobs-sqlite').createSqliteJobStore(config.jobStore.sqlitePath)
  );

  const statusSync = createStatusSync({ shopify, enabled: config.shopify.statusSync });
  const rb = config.carriers.redbox;
  const handleRedboxWebhook = rb.webhookSecret
    ? createRedboxWebhookHandler({
      verify: verifyBearerToken({ secret: rb.webhookSecret }),
      jobStore,
      // onEvent: async (event, job) => {
      //   // An older event leaves carrierStatus unchanged: skip it, so Shopify never shows a stale status.
      //   const fresh = await jobStore.get(job.key);
      //   if (!fresh || fresh.carrierStatus !== event.event) return;

      //   await statusSync.recordEvent(fresh, event);

      //   if (['expired', 'exception', 'cancelled'].includes(event.event)) {
      //     console.warn(`[ops] ${fresh.key}: RedBox status "${event.rawStatus}" (${event.event})`);
      //     await jobStore.update(fresh.key, { needsAttention: event.event });
      //   }
      //   if (event.event === 'returned') {
      //     await jobStore.update(fresh.key, { awaitingInspection: true, returnedAt: event.occurredAt });
      //   }
      // }
      onEvent: async (event, job) => {
        const fresh = await jobStore.get(job.key);
        if (!fresh || fresh.carrierStatus !== event.event) return; // an older event: the job already moved on

        const sync = await statusSync.recordEvent(fresh, event);
        if (sync.error) await jobStore.update(fresh.key, { statusSyncError: sync.error });
        else if (sync.synced && fresh.statusSyncError) await jobStore.update(fresh.key, { statusSyncError: null });

        if (['returned', 'expired', 'exception', 'cancelled'].includes(event.event)) {
          console.warn(`[ops] ${fresh.key}: RedBox status "${event.rawStatus}" (${event.event})`);
          await jobStore.update(fresh.key, { needsAttention: event.event });
        }
      }
      // onEvent: async (event, job) => { /* ops alert, e.g. on 'expired' or 'exception' */ }
    })
    : null;


  const carriers = buildCarriers(config);

  const returns = createReturnOrchestrator({
    shopify,
    carriers,
    jobStore,
    defaultItemWeightKg: config.defaultItemWeightKg,
    statusSync,
    manualReviewQueue,
    testOrderTag: config.carrierMode === 'dry-run' ? null : config.testOrderTag,
    stuckJobMinutes: config.stuckJobMinutes
  });

  // Background work, started by start() only (tests that call createServer do not poll).
  // Every cycle: ask Aramex for new statuses, then retry anything that failed after booking.
  // Run it on ONE instance only (POLLER_ENABLED=false on the others).
  const aramex = carriers.aramex;
  const logger = createLogger();
  const canTrack = config.carrierMode !== 'dry-run' && typeof aramex?.trackShipments === 'function' &&
    config.carriers.aramex.trackingMode === 'poll' && Boolean(config.carriers.aramex.trackingEndpoint);
  const trackingSync = canTrack ? createTrackingSync({ jobStore, carrier: aramex, statusSync, logger }) : null;
  const cleanup = config.cleanup?.enabled && typeof jobStore.remove === 'function'
    ? createCleanup({ jobStore, ...config.cleanup, logger })
    : null;
  const poller = config.pollerEnabled && config.carrierMode !== 'dry-run'
    ? createPoller({
      intervalMs: config.carriers.aramex.pollIntervalMs,
      logger,
      task: async () => {
        if (trackingSync) logger.info('aramex tracking cycle', await trackingSync.runOnce());
        const retried = await returns.retryPending();
        if (Object.values(retried).some(Boolean)) logger.info('retry cycle', retried);
        if (config.reconcile.enabled) {
          const reconciled = await returns.reconcileMissing({ lookbackHours: config.reconcile.lookbackHours });
          if (reconciled.found || reconciled.errors) logger.info('reconcile cycle', reconciled);
        }
        // Throttled inside runOnce (once an hour), so it is cheap to call on every cycle.
        if (cleanup) {
          const cleaned = await cleanup.runOnce();
          if (cleaned.deleted || cleaned.wouldDelete || cleaned.errors) logger.info('cleanup cycle', cleaned);
        }
      }
    })
    : null;

  const handleWebhook = createWebhookHandler({
    webhookSecret: config.shopify.webhookSecret,
    orchestrator: returns
  });

  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === '/health') {
        // Also proves the job store is reachable (e.g. MongoDB Atlas), so a monitor sees a dead database.
        let store = 'ok';
        try {
          await jobStore.get('health-check');
        } catch (error) {
          console.error('[health] MongoDB job store check failed:', error);
          store = 'error';
        }
        response.writeHead(store === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          status: store === 'ok' ? 'ok' : 'degraded',
          jobStore: store,
          mode: config.carrierMode,
          poller: Boolean(poller?.active)
        }));
        return;
      }

      if (request.url === '/webhooks/shopify' || request.url === '/webhooks') {
        await handleWebhook(request, response);
        return;
      }

      if (request.url === '/returns' && request.method === 'POST') {
        const body = await new Promise((resolve) => {
          const chunks = [];
          request.on('data', (chunk) => chunks.push(chunk));
          request.on('end', () => resolve(Buffer.concat(chunks)));
        });
        const returnData = body.length ? JSON.parse(body.toString('utf8')) : {};
        const result = await returns.handle(returnData);
        response.writeHead(202, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(result));
        return;
      }

      if (request.url === '/webhooks/redbox' && handleRedboxWebhook) {
        await handleRedboxWebhook(request, response);
        return;
      }

      response.writeHead(404);
      response.end();
    } catch (error) {
      console.error('Unhandled request error', error);
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
      }
      response.end(JSON.stringify({ error: 'internal_error' }));
    }

  });
  server.poller = poller;
  server.jobStore = jobStore;
  server.returns = returns;


  server.on('close', () => {
    poller?.stop();
    Promise.resolve()
      .then(() => jobStore.close())
      .catch(error => {
        console.error('Failed to close job store', error);
      });
  });


  return server;
}



function start() {
  const config = getConfig();
  console.log(`Carrier mode: ${config.carrierMode}`);
  console.log(`RedBox base URL: ${config.carriers.redbox.endpoint || '(not set)'}`);
  console.log(`Aramex base URL: ${config.carriers.aramex.endpoint || '(not set)'}`);
  const server = createServer({ config });
  console.log(`Status sync: ${config.shopify.statusSync ? 'ON' : 'OFF'}`);
  console.log(`Test-order guard: ${config.testOrderTag && config.carrierMode !== 'dry-run' ? config.testOrderTag : 'off'}`);

  server.listen(config.port, config.host, () => {
    console.log(`Returns middleware listening on ${config.host}:${config.port}`);
    if (server.poller) {
      server.poller.start();
      console.log(`Poller: ON every ${config.carriers.aramex.pollIntervalMs} ms (Aramex tracking ${config.carriers.aramex.trackingEndpoint ? 'enabled' : 'disabled: ARAMEX_TRACKING_ENDPOINT not set'})`);
    } else {
      console.log('Poller: OFF');
    }
  });
  // systemd/pm2 stop the app with SIGTERM: stop polling, let open requests finish, then exit.
  // Work cut off by a stop is picked up again by the stuck-job sweep after the restart.
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.poller?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  return server;

}
if (require.main === module) {
  start();
}

module.exports = { createServer, start };