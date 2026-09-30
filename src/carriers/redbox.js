'use strict';

const name = 'redbox';

// const DEFAULT_BASE_URL = 'https://api.redboxsa.com';
// const DEFAULT_API_VERSION = 'v3';

/**
 * Internal, carrier-agnostic event vocabulary. Both adapters normalize into
 * this shape before the middleware writes status back to Shopify.
 */
const STATUS_EVENT_MAP = Object.freeze({
  created: 'created',
  pending: 'created',
  confirmed: 'created',
  picked_up: 'picked_up',
  'picked up': 'picked_up',
  in_transit: 'in_transit',
  'in transit': 'in_transit',
  out_for_delivery: 'out_for_delivery',
  'out for delivery': 'out_for_delivery',
  delivered: 'delivered',
  disposed: 'disposed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  returned: 'returned',
  exception: 'exception',
  failed: 'exception'
});

class RedboxApiError extends Error {
  constructor(message, { status, path, body } = {}) {
    super(message);
    this.name = 'RedboxApiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeEvent(raw = {}) {
  const status = String(raw.status ?? raw.state ?? raw.event ?? '')
    .trim()
    .toLowerCase();

  return {
    carrier: name,
    event: STATUS_EVENT_MAP[status] || 'unknown',
    rawStatus: status || null,
    occurredAt: raw.occurredAt || raw.timestamp || raw.updatedAt || null,
    trackingNumber: raw.trackingNumber || raw.tracking_number || null,
    raw
  };
}

function createRedboxClient(config = {}) {
  const {
    endpoint,//DEFAULT_BASE_URL,
    apiVersion = DEFAULT_API_VERSION,
    bearerToken,
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
    retries = 2,
    retryDelayMs = 300
  } = config;

  if (!endpoint) throw new Error('RedBox client requires an endpoint (use the RedBox sandbox base URL)');

  if (typeof fetchImpl !== 'function') {
    throw new Error('RedBox client requires a fetch implementation');
  }
  // Bearer token is issued per business account by RedBox support / account manager.
  if (!bearerToken) {
    throw new Error('RedBox client requires a bearerToken issued by RedBox support');
  }

  const baseUrl = `${String(endpoint).replace(/\/+$/, '')}/${apiVersion}`;

  async function once(path, { method = 'GET', body, headers = {}, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const forwardAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', forwardAbort);

    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bearer ${bearerToken}`,
          ...headers
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      const text = await response.text();
      const payload = text ? parseJson(text) : null;

      if (!response.ok) {
        throw new RedboxApiError(
          `RedBox ${method} ${path} failed with status ${response.status}`,
          { status: response.status, path, body: payload ?? text }
        );
      }
      return payload;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forwardAbort);
    }
  }

  // Retry only idempotent GETs. POSTs must not be blindly retried; callers
  // pass an Idempotency-Key and let the middleware queue/backoff strategy own it.
  async function request(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const attempts = method === 'GET' ? retries + 1 : 1;
    let lastError;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await once(path, { ...options, method });
      } catch (error) {
        lastError = error;
        const retryable =
          error.name === 'AbortError' ||
          (error instanceof RedboxApiError && (error.status === 429 || error.status >= 500));

        if (!retryable || attempt === attempts - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
      }
    }
    throw lastError;
  }

  return {
    name,

    /**
     * Books the reverse leg with RedBox (locker drop-off).
     *
     * NOTE: the write-side schema (POST /v3/shipments) is not in RedBox's
     * publicly mirrored documentation. `payload` is passed through as-is;
     * confirm the exact request shape with RedBox support once partner
     * credentials are issued, then map the client's return payload here.
     */
    createReturnShipment(payload, { idempotencyKey } = {}) {
      return request('/shipments', {
        method: 'POST',
        body: payload,
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}
      });
    },

    // --- Confirmed read surface (v3) ---
    getShipment(id) {
      return request(`/shipments/${encodeURIComponent(id)}`);
    },
    getShipmentStatus(id) {
      return request(`/shipments/${encodeURIComponent(id)}/status`);
    },
    getShipmentActivities(id) {
      return request(`/shipments/${encodeURIComponent(id)}/activities`);
    },
    getShipmentLabel(id) {
      return request(`/shipments/${encodeURIComponent(id)}/label`);
    },
    getTrackingPage(id) {
      return request(`/shipments/${encodeURIComponent(id)}/tracking-page`);
    },
    listPickupLocations(query = {}) {
      const params = new URLSearchParams(query).toString();
      return request(`/pickup-locations${params ? `?${params}` : ''}`);
    },
    listPointsByCity(cityCode) {
      return request(`/cities/${encodeURIComponent(cityCode)}/points`);
    },

    // --- Webhooks: RedBox supports these, so register rather than poll ---
    listWebhooks() {
      return request('/webhooks');
    },
    registerWebhook(payload) {
      return request('/webhooks', { method: 'POST', body: payload });
    },

    normalizeEvent
  };
}

module.exports = {
  createRedboxClient,
  name,
  normalizeEvent,
  RedboxApiError,
  STATUS_EVENT_MAP,
  // DEFAULT_BASE_URL,
  // DEFAULT_API_VERSION
};