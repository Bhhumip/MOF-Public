const http = require('node:http');
const { getConfig } = require('./config');
const { createWebhookHandler } = require('./webhooks');
const { createShopifyClient } = require('./shopify');
const { createReturnOrchestrator } = require('./returns');
//const { createRedboxClient } = require('./carriers/redbox');
//const { createAramexClient } = require('./carriers/aramex');
const { buildCarriers } = require('./carriers/factory');
function createServer({ config = getConfig() } = {}) {
  const shopify = createShopifyClient(config.shopify);

  // const carriers = {
  //   redbox: createRedboxClient(config.carriers.redbox),
  //   aramex: createAramexClient(config.carriers.aramex)
  // };
  const carriers = buildCarriers(config);

  const returns = createReturnOrchestrator({
    shopify,
    carriers,
    // manualReviewQueue: ...  // wire to ops queue per §8
  });

  const handleWebhook = createWebhookHandler({
    webhookSecret: config.shopify.webhookSecret,
    orchestrator: returns
  });

  return http.createServer(async (request, response) => {
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
}

function start() {
  const config = getConfig();
  console.log(`Carrier mode: ${config.carrierMode}`);
  console.log(`RedBox base URL: ${config.carriers.redbox.endpoint || '(not set)'}`);
  console.log(`Aramex base URL: ${config.carriers.aramex.endpoint || '(not set)'}`);
  const server = createServer({ config });
  server.listen(config.port, () => {
    console.log(`Returns middleware listening on port ${config.port}`);
  });
  return server;
}
if (require.main === module) {
  start();
}

module.exports = { createServer, start };