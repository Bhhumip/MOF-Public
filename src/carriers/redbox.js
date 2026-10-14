'use strict';

const defaultContract = require('./redbox-contract');
const { RedboxContractError } = defaultContract;

const name = 'redbox';

// Version is a path segment, not a host: safe to default. The HOST has no
// default on purpose (no production URL may ever be a fallback; see config.js).
// Sandbox: https://stage.api.redboxsa.com   Production: https://api.redboxsa.com (blocked by config.js)
const DEFAULT_API_VERSION = 'v3';

/**
 * Internal, carrier-agnostic event vocabulary. Both adapters normalize into
 * this shape before the middleware acts on a carrier event.
 *
 *  * Documented RedBox statuses (GET /shipments/{id}/status): Processing, In-Transit,
 * Deposited, R-Deposited, Delivered, Returned, Expired, In-transit-r, In-transit-ex,
 * Not-Delivered, Canceled, NotDeposited.
 * R-Deposited, In-transit-r, In-transit-ex, Not-Delivered and NotDeposited are left
 * UNMAPPED on purpose: the docs don't define them. They become 'unknown' with the raw
 * value preserved. 
 */
const STATUS_EVENT_MAP = Object.freeze({
  created: 'created',
  pending: 'created',
  confirmed: 'created',
  picked_up: 'picked_up',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  expired: 'expired', // parcel left in a locker past its stay (the customer never dropped it / never collected it)
  disposed: 'disposed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  returned: 'returned',
  exception: 'exception',
  failed: 'exception',
  processing: 'created',     // documented RedBox status
  deposited: 'deposited',   // documented RedBox status (parcel placed in a locker)
  r_waiting: 'created',   // seen in the sandbox: return booked, waiting for the customer (meaning to confirm with RedBox)
});

class RedboxApiError extends Error {
  constructor(message, { status, path, body, code, outcomeUnknown = false } = {}) {
    super(message);
    this.name = 'RedboxApiError';
    this.status = status;
    this.path = path;
    this.body = body;
    this.code = code;
    // true => the request may have reached RedBox and created a shipment.
    // Callers must reconcile before retrying.
    this.outcomeUnknown = outcomeUnknown;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function lookupEvent(status) {
  return STATUS_EVENT_MAP[status] || STATUS_EVENT_MAP[status.replace(/[\s-]+/g, '_')] || 'unknown';
}

function normalizeEvent(raw = {}) {
  const status = String(raw.status ?? defaultContract.pickStatus(raw) ?? raw.state ?? raw.event ?? '')
    .trim()
    .toLowerCase();

  return {
    carrier: name,
    event: status ? lookupEvent(status) : 'unknown',
    rawStatus: status || null,
    occurredAt: raw.occurredAt || raw.date || raw.timestamp || raw.updatedAt || null,
    trackingNumber: raw.trackingNumber || raw.tracking_number || null,
    shipmentId: raw.shipmentId || raw.shipment_id || null,
    raw
  };
}

function createRedboxClient(config = {}) {
  const {
    endpoint,
    bearerToken,
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
    retries = 2,
    retryDelayMs = 300,
    contract = defaultContract,
    allowUnconfirmedContract = false,
    logger = console
  } = config;
  // config.js passes `null` when the env var is unset; a destructuring default
  // only covers `undefined`, so normalise explicitly (null produced ".../null/...").
  const apiVersion = config.apiVersion || DEFAULT_API_VERSION;

  if (!endpoint) {
    throw new Error('RedBox client requires an endpoint (use the RedBox sandbox base URL)');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('RedBox client requires a fetch implementation');
  }
  // Bearer token is issued per business account by RedBox support.
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
      // bearerToken may be a function if you ever need to rotate tokens at runtime.
      const token = typeof bearerToken === 'function' ? await bearerToken() : bearerToken;
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bearer ${token}`,
          ...headers
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      const text = await response.text();
      const payload = text ? parseJson(text) : null;

      if (!response.ok) {
        // RedBox error format: { success: false, response_code, msg }
        const detail = payload && typeof payload === 'object' && payload.msg ? `: ${payload.msg}` : '';
        throw new RedboxApiError(
          `RedBox ${method} ${path} failed with status ${response.status}${detail}`,
          { status: response.status, path, body: payload ?? text }
        );
      }
      return payload;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forwardAbort);
    }
  }

  // GETs are idempotent and are retried on timeout / 429 / 5xx.
  // POSTs are attempted exactly once. If a POST fails WITHOUT an HTTP response
  // (timeout, dropped connection) the shipment may still have been created, so
  // that error is flagged `outcomeUnknown` instead of looking like a clean failure.
  async function request(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const attempts = method === 'GET' ? retries + 1 : 1;
    let lastError;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await once(path, { ...options, method });
      } catch (error) {
        lastError = error;

        if (method !== 'GET' && !(error instanceof RedboxApiError)) {
          throw new RedboxApiError(
            `RedBox ${method} ${path} got no response (${error.name}); the shipment may or may not exist`,
            { path, code: 'outcome_unknown', outcomeUnknown: true }
          );
        }

        const retryable =
          error.name === 'AbortError' ||
          (error instanceof RedboxApiError && (error.status === 429 || error.status >= 500));

        if (!retryable || attempt === attempts - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
      }
    }
    throw lastError;
  }

  const enc = encodeURIComponent;

  // `id` below can be a shipment_id OR a tracking_number (per the RedBox docs).
  const getShipment = (id) => request(`/shipments/${enc(id)}`);
  const getShipmentStatus = (id) => request(`/shipments/${enc(id)}/status`);
  const getShipmentActivities = (id) => request(`/shipments/${enc(id)}/activities`);
  const getShipmentLabel = (id) => request(`/shipments/${enc(id)}/label`);
  const getTrackingPage = (id) => request(`/shipments/${enc(id)}/tracking-page`);
  const listShipments = ({ page = 1, pageSize = 50 } = {}) =>
    request(`/shipments?page=${page}&page_size=${pageSize}`);

  /**
   * The original outbound shipment, when RedBox delivered the order, lets RedBox
   * build the return from its own records ("internal" return). Shopify's
   * fulfillment tracking number is the lookup key (GET accepts a tracking number).
   * Any failure (404, network) just falls back to an "external" return.
   */
  async function lookupOriginalShipmentId(trackingNumber) {
    try {
      const details = contract.parseShipmentDetails(await getShipment(trackingNumber));
      return details ? details.shipmentId : null;
    } catch (error) {
      logger.warn(`[redbox] original shipment ${trackingNumber} not found, using external return: ${error.message}`);
      return null;
    }
  }

  /**
   * After a 409 ("reference already exists") the shipment exists but the create
   * call did not return it. The docs offer no lookup by reference, so scan the
   * shipment list (bounded). Newest-first ordering is not documented.
   */
  async function findShipmentByReference(reference, { maxPages = 5, pageSize = 50 } = {}) {
    for (let page = 1; page <= maxPages; page += 1) {
      const { shipments, totalPages } = contract.parseShipmentList(await listShipments({ page, pageSize }));
      const hit = shipments.find((shipment) => shipment.reference === reference);
      if (hit) {
        return {
          success: true,
          shipment_id: hit.id ?? hit.shipment_id,
          tracking_number: hit.tracking_number
        };
      }
      if (page >= totalPages) break;
    }
    return null;
  }

  /**
   * Books the reverse leg with RedBox via POST /v3/shipments/returns.
   *
   * Returns the shape returns.js consumes:
   *   { carrier, shipmentId, trackingNumber, trackingUrl, label: {url,fileName}|null, recovered, raw }
   *
   * Duplicate protection: RedBox rejects a repeated `reference` with 409. On a 409
   * we try to recover the existing shipment instead of failing or double-booking.
   * The label comes back in the create response; the tracking URL is fetched
   * afterwards, best-effort. Failing to fetch it never fails an existing booking.
   */
  async function createReturnShipment(shipment) {
    if (!contract.confirmed && !allowUnconfirmedContract) {
      throw new RedboxContractError(
        'schema_unconfirmed',
        'RedBox schema is not confirmed; refusing to book. See src/carriers/redbox-contract.js.'
      );
    }

    // Optional: neutral shipment may carry the original outbound shipment.
    let originalShipmentId = shipment.originalShipmentId || null;
    if (!originalShipmentId && shipment.originalTrackingNumber) {
      originalShipmentId = await lookupOriginalShipmentId(shipment.originalTrackingNumber);
    }

    const body = contract.buildReturnShipmentRequest(shipment, { originalShipmentId });

    let created;
    let recovered = false;
    try {
      created = await request('/shipments/returns', { method: 'POST', body });
    } catch (error) {
      if (!(error instanceof RedboxApiError) || error.status !== 409) throw error;
      created = await findShipmentByReference(body.reference);
      if (!created) {
        throw new RedboxApiError(
          `RedBox says reference ${body.reference} already exists but the shipment could not be found`,
          { status: 409, code: 'already_exists_unresolved', body: error.body }
        );
      }
      recovered = true;
      logger.warn(`[redbox] reference ${body.reference} already existed; reusing shipment ${created.shipment_id}`);
    }

    const { shipmentId, trackingNumber, labelUrl: createdLabelUrl } = contract.parseCreateShipmentResponse(created);

    let labelUrl = createdLabelUrl;
    if (!labelUrl) {
      try {
        labelUrl = contract.parseLabelResponse(await getShipmentLabel(shipmentId));
      } catch (error) {
        logger.warn(`[redbox] label not available for shipment ${shipmentId}: ${error.message}`);
      }
    }

    let trackingUrl = null;
    try {
      trackingUrl = contract.parseTrackingPageResponse(await getTrackingPage(shipmentId));
    } catch (error) {
      logger.warn(`[redbox] tracking page not available for shipment ${shipmentId}: ${error.message}`);
    }

    return {
      carrier: name,
      shipmentId,
      trackingNumber,
      trackingUrl,
      label: labelUrl ? { url: labelUrl, fileName: `redbox-${trackingNumber}.pdf` } : null,
      recovered,
      raw: created
    };
  }

  return {
    name,
    createReturnShipment,

    getShipment,
    getShipmentStatus,
    getShipmentActivities,
    getShipmentLabel,
    getTrackingPage,
    listShipments,
    findShipmentByReference,

    /** Only the business's own shipments, and only before they are deposited (409 otherwise). */
    cancelShipment(id) {
      return request(`/shipments/${enc(id)}/cancel`, { method: 'POST' });
    },

    listPickupLocations() {
      return request('/pickup-locations');
    },
    listPointsByCity(cityCode, type = 'locker') {
      return request(`/cities/${enc(cityCode)}/points?type=${enc(type)}`);
    },

    // --- Webhooks: RedBox pushes status changes, so register rather than poll ---
    listWebhooks() {
      return request('/webhooks');
    },
    async registerWebhook(options = {}) {
      if (!contract.confirmed && !allowUnconfirmedContract) {
        throw new RedboxContractError('schema_unconfirmed', 'RedBox schema is not confirmed; refusing to register.');
      }
      return request('/webhooks', { method: 'POST', body: contract.buildWebhookRegistration(options) });
    },
    deleteWebhook(originalId) {
      return request(`/webhooks/${enc(originalId)}`, { method: 'DELETE' });
    },

    normalizeEvent
  };
}

module.exports = {
  createRedboxClient,
  name,
  normalizeEvent,
  RedboxApiError,
  RedboxContractError,
  STATUS_EVENT_MAP,
  DEFAULT_API_VERSION
};