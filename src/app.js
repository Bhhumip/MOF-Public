const http = require('node:http');
const { getConfig } = require('./config');
const { createSqliteJobStore } = require('./jobs-sqlite');
const { createWebhookHandler } = require('./webhooks');
const { createShopifyClient } = require('./shopify');
const { createReturnOrchestrator } = require('./returns');
const { createMongoJobStore } = require('./jobs-mongodb');
//const { createRedboxClient } = require('./carriers/redbox');
//const { createAramexClient } = require('./carriers/aramex');
const { createRedboxWebhookHandler, verifyBearerToken } = require('./carriers/redbox-webhook');
const { createStatusSync } = require('./status-sync');
const { buildCarriers } = require('./carriers/factory');
function createServer({ config = getConfig(), jobStore: injectedJobStore } = {}) {
  const shopify = createShopifyClient(config.shopify);

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
      : createSqliteJobStore(config.jobStore.sqlitePath)
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
    statusSync
    // manualReviewQueue: ...  // wire to ops queue per §8
  });

  const handleWebhook = createWebhookHandler({
    webhookSecret: config.shopify.webhookSecret,
    orchestrator: returns
  });

  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
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


  server.on('close', () => {
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
  server.listen(config.port, () => {
    console.log(`Returns middleware listening on port ${config.port}`);
  });
  return server;
}
if (require.main === module) {
  start();
}

module.exports = { createServer, start };