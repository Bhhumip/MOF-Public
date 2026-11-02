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

// "LxWxH" in centimetres, e.g. "10x10x10". Returns null when unset.
function parseParcelDimensions(value) {
  if (!value) return null;
  const parts = String(value).toLowerCase().split('x').map((part) => Number(part.trim()));
  if (parts.length !== 3 || parts.some((part) => !(part > 0))) {
    throw new Error('ARAMEX_PARCEL_CM must look like 10x10x10 (length x width x height, in cm)');
  }
  const [length, width, height] = parts;
  return { length, width, height };
}

// JSON object such as {"SH005":"returned"} that pins Aramex update codes to events.
const KNOWN_EVENTS = ['created', 'picked_up', 'in_transit', 'out_for_delivery', 'returned', 'exception', 'expired', 'cancelled'];
function parseStatusMap(value) {
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('ARAMEX_STATUS_MAP must be valid JSON, e.g. {"SH005":"returned"}');
  }
  const map = {};
  for (const [code, event] of Object.entries(parsed)) {
    if (!KNOWN_EVENTS.includes(event)) {
      throw new Error(`ARAMEX_STATUS_MAP: "${event}" is not one of ${KNOWN_EVENTS.join(', ')}`);
    }
    map[String(code).trim().toUpperCase()] = event;
  }
  return map;
}

function cleanup(env) {
  const retentionDays = number(env.CLEANUP_RETENTION_DAYS, 30);
  const eventRetentionDays = number(env.CLEANUP_EVENT_RETENTION_DAYS, 7);
  // A finished job is also the duplicate guard: keep it longer than Shopify retries a webhook (48 h).
  if (!(retentionDays >= 3)) throw new Error('CLEANUP_RETENTION_DAYS must be at least 3');
  if (!(eventRetentionDays >= 1)) throw new Error('CLEANUP_EVENT_RETENTION_DAYS must be at least 1');
  return {
    enabled: env.CLEANUP_ENABLED === 'true',
    dryRun: env.CLEANUP_DRY_RUN === 'true',
    retentionDays,
    eventRetentionDays
  };
}

const number = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));

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
  assertNotProductionEndpoint('Aramex tracking', env.ARAMEX_TRACKING_ENDPOINT);

  // Guard: the middleware refuses to start against any store but the one named here.
  const allowedStore = (env.ALLOWED_SHOPIFY_STORE || '').trim().toLowerCase();
  if (allowedStore && String(env.SHOPIFY_STORE_DOMAIN).trim().toLowerCase() !== allowedStore) {
    throw new Error(
      `SHOPIFY_STORE_DOMAIN (${env.SHOPIFY_STORE_DOMAIN}) is not the allowed store (${allowedStore}). Refusing to start.`
    );
  }
  return {
    port,
    carrierMode,
    defaultItemWeightKg,
    jobStore,
    jobDbPath: jobStore.sqlitePath,
    testOrderTag: (env.TEST_ORDER_TAG || '').trim() || null,
    pollerEnabled: env.POLLER_ENABLED !== 'false',
    // 127.0.0.1 when nginx sits in front (see deploy/); 0.0.0.0 reaches the app from outside.
    host: (env.HOST || '0.0.0.0').trim(),
    // A job "processing" for longer than this means the server stopped while handling it.
    stuckJobMinutes: number(env.STUCK_JOB_MINUTES, 15),
    // Finds approved returns whose webhook never arrived (server down, lost delivery).
    reconcile: {
      enabled: env.RECONCILE_ENABLED !== 'false',
      lookbackHours: number(env.RECONCILE_LOOKBACK_HOURS, 24)
    },
    cleanup: cleanup(env),

    shopify: {
      storeDomain: env.SHOPIFY_STORE_DOMAIN,
      adminAccessToken: env.SHOPIFY_ADMIN_ACCESS_TOKEN,
      apiVersion: env.SHOPIFY_API_VERSION || '2026-07',
      webhookSecret: env.SHOPIFY_WEBHOOK_SECRET,
      statusSync: env.SHOPIFY_STATUS_SYNC === 'true',

      // Topics the middleware subscribes to. returns/request fires when a
      // customer initiates a return; returns/approve fires when the merchant
      // approves and the Reverse Fulfillment Order is created.
      webhookTopics: [
        'returns/request',
        'returns/approve',
        'returns/process',
        'returns/cancel',
        'reverse_fulfillment_orders/dispose'
      ]
    },
    carriers: {
      redbox: {
        endpoint: env.REDBOX_API_ENDPOINT || null,          // https://stage.api.redboxsa.com
        apiVersion: env.REDBOX_API_VERSION || null,         // null => client uses v3
        bearerToken: env.REDBOX_BEARER_TOKEN || null,       // issued by RedBox support
        webhookSecret: env.REDBOX_WEBHOOK_SECRET || null,   // we choose it; RedBox echoes it back
        webhookSubscriber: env.REDBOX_WEBHOOK_SUBSCRIBER || null, // business name, required by RedBox
        allowUnconfirmedContract: env.REDBOX_ALLOW_UNCONFIRMED_CONTRACT === 'true',
        requireOriginalShipment: env.REDBOX_REQUIRE_ORIGINAL_SHIPMENT !== 'false',
      },
      aramex: {
        // SOAP endpoint only.
        endpoint: env.ARAMEX_SOAP_ENDPOINT || null,
        // Tracking is a separate Aramex service (…/tracking/service_1_0.svc).
        trackingEndpoint: env.ARAMEX_TRACKING_ENDPOINT || null,
        username: env.ARAMEX_USERNAME || null,
        password: env.ARAMEX_PASSWORD || null,
        version: env.ARAMEX_VERSION || 'v1',

        accountNumber: env.ARAMEX_ACCOUNT_NUMBER || null,
        accountPin: env.ARAMEX_ACCOUNT_PIN || null,
        accountEntity: env.ARAMEX_ACCOUNT_ENTITY || null,
        accountCountryCode: env.ARAMEX_ACCOUNT_COUNTRY_CODE || null,

        source: Number(env.ARAMEX_SOURCE || 24),

        // Domestic = DOM/OND; international = EXP plus a type such as PPX (manual, Appendix A).
        productGroup: env.ARAMEX_PRODUCT_GROUP || 'DOM',
        productType: env.ARAMEX_PRODUCT_TYPE || 'OND',
        // Who pays. Placeholder until the client confirms: P, C (+ ARCC/ASCC) or 3.
        paymentType: env.ARAMEX_PAYMENT_TYPE || 'P',
        paymentOptions: env.ARAMEX_PAYMENT_OPTIONS || '',
        // Parcel size sent with every return (Shopify does not provide it).
        dimensionsCm: parseParcelDimensions(env.ARAMEX_PARCEL_CM),
        // Used when Shopify has no phone/e-mail for the warehouse location.
        warehousePhone: env.ARAMEX_WAREHOUSE_PHONE || null,
        warehouseEmail: env.ARAMEX_WAREHOUSE_EMAIL || null,

        // false = do not send ForeignHAWB (our return id). Default true: it makes a repeat booking fail with ERR30.
        useForeignHawb: env.ARAMEX_USE_FOREIGN_HAWB !== 'false',
        // Offset of the Aramex station clock from UTC, in minutes (Saudi Arabia = 180).
        utcOffsetMinutes: number(env.ARAMEX_UTC_OFFSET_MINUTES, 180),
        // Pickup slot rules. Real values come from the Aramex entity's business hours.
        pickupWindow: {
          utcOffsetMinutes: number(env.ARAMEX_UTC_OFFSET_MINUTES, 180),
          openHour: number(env.ARAMEX_PICKUP_OPEN_HOUR, 9),
          lastPickupHour: number(env.ARAMEX_PICKUP_LAST_HOUR, 17),
          closeHour: number(env.ARAMEX_PICKUP_CLOSE_HOUR, 18),
          leadMinutes: number(env.ARAMEX_PICKUP_LEAD_MINUTES, 120),
          closedDays: (env.ARAMEX_PICKUP_CLOSED_DAYS ?? '5')
            .split(',').map((day) => day.trim()).filter(Boolean).map(Number)
        },
        // Pins Aramex update codes to internal events; unknown codes fall back to the description text.
        statusMap: parseStatusMap(env.ARAMEX_STATUS_MAP),
        statusHeuristics: env.ARAMEX_STATUS_HEURISTICS !== 'false',
        trackingMode: env.ARAMEX_TRACKING_MODE || 'poll',
        pollIntervalMs: Number(
          env.ARAMEX_POLL_INTERVAL_MS || 15 * 60 * 1000
        )
      }
    }
  };
}

module.exports = { getConfig };