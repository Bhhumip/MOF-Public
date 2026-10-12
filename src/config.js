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


const JOB_STORE_TYPES = ['sqlite', 'mongodb'];

function resolveJobStoreConfig(env) {
  const type = (env.JOB_STORE || 'sqlite').trim().toLowerCase();

  if (!JOB_STORE_TYPES.includes(type)) {
    throw new Error(
      `JOB_STORE must be one of: ${JOB_STORE_TYPES.join(', ')}`
    );
  }

  const uri = env.MONGODB_URI || null;

  if (type === 'mongodb' && !uri) {
    throw new Error(
      'MONGODB_URI is required when JOB_STORE=mongodb'
    );
  }

  return {
    type,
    sqlitePath: env.JOB_DB_PATH || './data/jobs.sqlite',
    mongodbUri: uri,
    mongodbDatabase: env.MONGODB_DATABASE || 'mof_return_orchestration'
  };
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
  const jobStore = resolveJobStoreConfig(env);
  const requiredVariables = [
    'SHOPIFY_STORE_DOMAIN',
    'SHOPIFY_ADMIN_ACCESS_TOKEN',
    'SHOPIFY_WEBHOOK_SECRET'
  ];
  const missingVariables = requiredVariables.filter((name) => !env[name]);
  const defaultItemWeightKg = env.DEFAULT_ITEM_WEIGHT_KG ? Number(env.DEFAULT_ITEM_WEIGHT_KG) : null;
  if (defaultItemWeightKg !== null && !(defaultItemWeightKg > 0)) {
    throw new Error('DEFAULT_ITEM_WEIGHT_KG must be a number greater than 0');
  }
  if (missingVariables.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVariables.join(', ')}`);
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  assertNotProductionEndpoint('RedBox', env.REDBOX_API_ENDPOINT);
  assertNotProductionEndpoint('Aramex', env.ARAMEX_SOAP_ENDPOINT);
  return {
    port,
    carrierMode,
    defaultItemWeightKg,
    jobStore,
    jobDbPath: jobStore.sqlitePath,

    shopify: {
      storeDomain: env.SHOPIFY_STORE_DOMAIN,
      adminAccessToken: env.SHOPIFY_ADMIN_ACCESS_TOKEN,
      apiVersion: env.SHOPIFY_API_VERSION || '2026-07',
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
        // SOAP endpoint only.
        endpoint: env.ARAMEX_SOAP_ENDPOINT || null,

        username: env.ARAMEX_USERNAME || null,
        password: env.ARAMEX_PASSWORD || null,
        version: env.ARAMEX_VERSION || 'v1',

        accountNumber: env.ARAMEX_ACCOUNT_NUMBER || null,
        accountPin: env.ARAMEX_ACCOUNT_PIN || null,
        accountEntity: env.ARAMEX_ACCOUNT_ENTITY || null,
        accountCountryCode: env.ARAMEX_ACCOUNT_COUNTRY_CODE || null,

        source: Number(env.ARAMEX_SOURCE || 24),

        trackingMode: env.ARAMEX_TRACKING_MODE || 'poll',
        pollIntervalMs: Number(
          env.ARAMEX_POLL_INTERVAL_MS || 15 * 60 * 1000
        )
      }
    }
  };
}

module.exports = { getConfig };