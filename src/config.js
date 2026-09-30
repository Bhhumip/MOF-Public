const CARRIER_MODES = ['dry-run', 'sandbox', 'live'];
const PRODUCTION_CARRIER_HOSTS = ['api.redboxsa.com', 'ws.aramex.net'];

function resolveCarrierMode(env) {
  const mode = (env.CARRIER_MODE || 'dry-run').trim().toLowerCase();
  if (!CARRIER_MODES.includes(mode)) {
    throw new Error(`CARRIER_MODE must be one of: ${CARRIER_MODES.join(', ')}`);
  }
  if (mode === 'live') throw new Error('CARRIER_MODE=live is blocked during development');
  return mode;
}

function assertNotProductionEndpoint(name, endpoint) {
  if (!endpoint) return;
  let host;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    throw new Error(`${name} endpoint is not a valid URL: ${endpoint}`);
  }
  if (PRODUCTION_CARRIER_HOSTS.includes(host)) {
    throw new Error(`${name} endpoint points at a production host (${host}). Use the sandbox base URL.`);
  }
}
function getConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  const carrierMode = resolveCarrierMode(env);
  const requiredVariables = [
    'SHOPIFY_STORE_DOMAIN',
    'SHOPIFY_ADMIN_ACCESS_TOKEN',
    'SHOPIFY_WEBHOOK_SECRET'
  ];
  const missingVariables = requiredVariables.filter((name) => !env[name]);

  if (missingVariables.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVariables.join(', ')}`);
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  assertNotProductionEndpoint('RedBox', env.REDBOX_API_ENDPOINT);
  assertNotProductionEndpoint('Aramex', env.ARAMEX_API_ENDPOINT);
  return {
    port,
    carrierMode,
    shopify: {
      storeDomain: env.SHOPIFY_STORE_DOMAIN,
      adminAccessToken: env.SHOPIFY_ADMIN_ACCESS_TOKEN,
      apiVersion: env.SHOPIFY_API_VERSION || '2026-01',
      webhookSecret: env.SHOPIFY_WEBHOOK_SECRET,
      // Topics the middleware subscribes to. returns/request fires when a
      // customer initiates a return; returns/approve fires when the merchant
      // approves and the Reverse Fulfillment Order is created.
      webhookTopics: [
        'returns/request',
        'returns/approve',
        'returns/process',
        'reverse_fulfillment_orders/dispose'
      ]
    },
    carriers: {
      redbox: {
        endpoint: env.REDBOX_API_ENDPOINT || null,//'https://api.redboxsa.com',
        apiVersion: env.REDBOX_API_VERSION || null,//'v3',
        // Bearer token issued per business account by RedBox support /
        // account manager. Store in a secrets manager per §8.
        bearerToken: env.REDBOX_BEARER_TOKEN || null
      },
      aramex: {
        endpoint: env.ARAMEX_API_ENDPOINT || null,//'https://ws.aramex.net/shippingapi.v2/shipping/service_1_0.svc/json',
        username: env.ARAMEX_USERNAME || null,
        password: env.ARAMEX_PASSWORD || null,
        version: env.ARAMEX_VERSION || 'v1',
        accountNumber: env.ARAMEX_ACCOUNT_NUMBER || null,
        accountPin: env.ARAMEX_ACCOUNT_PIN || null,
        accountEntity: env.ARAMEX_ACCOUNT_ENTITY || null,
        accountCountryCode: env.ARAMEX_ACCOUNT_COUNTRY_CODE || null,
        source: Number(env.ARAMEX_SOURCE || 24),
        // Aramex webhook availability is unconfirmed. Default to polling
        // via TrackShipments until the account manager confirms otherwise.
        trackingMode: env.ARAMEX_TRACKING_MODE || 'poll',
        pollIntervalMs: Number(env.ARAMEX_POLL_INTERVAL_MS || 15 * 60 * 1000)
      }
    }
  };
}

module.exports = { getConfig };