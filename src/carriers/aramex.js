'use strict';

const name = 'aramex';

// Aramex's JSON projection of the Shipping Services API. The underlying
// service is SOAP-shaped; this endpoint accepts the same structure as JSON.
// const DEFAULT_ENDPOINT =
//   'https://ws.aramex.net/shippingapi.v2/shipping/service_1_0.svc/json';

/**
 * Aramex reports movement as UpdateCode / UpdateDescription pairs.
 * Exact codes must be confirmed with the Aramex account manager; unmapped
 * codes fall through to 'unknown' and are preserved on the raw payload.
 */
const STATUS_EVENT_MAP = Object.freeze({
  sh001: 'created',
  sh002: 'picked_up',
  sh003: 'in_transit',
  sh004: 'out_for_delivery',
  sh005: 'delivered',
  sh006: 'exception',
  sh007: 'cancelled',
  sh008: 'returned'
});

class AramexApiError extends Error {
  constructor(message, { operation, body } = {}) {
    super(message);
    this.name = 'AramexApiError';
    this.operation = operation;
    this.body = body;
  }
}

function normalizeEvent(raw = {}) {
  const code = String(raw.UpdateCode || raw.updateCode || '').trim().toLowerCase();
  const status = String(raw.Status || raw.status || raw.Event || raw.event || '')
    .trim()
    .toLowerCase();

  return {
    carrier: name,
    event: STATUS_EVENT_MAP[code] || STATUS_EVENT_MAP[status] || 'unknown',
    rawStatus: code || status || null,
    occurredAt:
      raw.UpdateDateTime || raw.updateDateTime || raw.EventDate || raw.eventDate || null,
    trackingNumber: raw.TrackingNumber || raw.trackingNumber || raw.AWBNumber || null,
    raw
  };
}

/**
 * Maps a neutral party descriptor onto Aramex's Shipper/Consignee shape.
 * For returns the roles are reversed: customer = Shipper, warehouse = Consignee.
 */
function toParty(party = {}) {
  return {
    Reference1: party.reference || '',
    AccountNumber: '',
    PartyAddress: {
      Line1: party.line1 || '',
      Line2: party.line2 || '',
      Line3: party.line3 || '',
      City: party.city || '',
      StateOrProvinceCode: party.state || '',
      CountryCode: party.countryCode || '',
      PostCode: party.postCode || ''
    },
    Contact: {
      Department: '',
      PersonName: party.name || '',
      Title: '',
      CompanyName: party.company || '',
      PhoneNumber1: party.phone || '',
      PhoneNumber1Ext: '',
      PhoneNumber2: '',
      PhoneNumber2Ext: '',
      FaxNumber: '',
      CellPhone: party.mobile || '',
      EmailAddress: party.email || '',
      Type: ''
    }
  };
}

function createAramexClient(config = {}) {
  const {
    endpoint,
    username,
    password,
    version = 'v1',
    accountNumber,
    accountPin,
    accountEntity,
    accountCountryCode,
    source = 24,
    fetchImpl = globalThis.fetch,
    timeoutMs = 20000,
    retries = 1,
    retryDelayMs = 500
  } = config;
  if (!endpoint) throw new Error('RedBox client requires an endpoint (use the RedBox sandbox base URL)');

  if (typeof fetchImpl !== 'function') {
    throw new Error('Aramex client requires a fetch implementation');
  }
  if (!username || !password) {
    throw new Error('Aramex client requires username/password issued by Aramex account management');
  }

  const baseUrl = String(endpoint).replace(/\/+$/, '');

  function clientInfo() {
    return {
      UserName: username,
      Password: password,
      Version: version,
      AccountNumber: accountNumber || '',
      AccountPin: accountPin || '',
      AccountEntity: accountEntity || '',
      AccountCountryCode: accountCountryCode || '',
      Source: source
    };
  }

  async function once(operation, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(`${baseUrl}/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...payload, ClientInfo: clientInfo() }),
        signal: controller.signal
      });

      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }

      if (!response.ok) {
        throw new AramexApiError(
          `Aramex ${operation} failed with status ${response.status}`,
          { operation, body }
        );
      }

      // Aramex signals application-level failures inside a 200 response.
      const hasErrors =
        body && typeof body === 'object' && body.HasErrors === true;
      if (hasErrors) {
        throw new AramexApiError(
          `Aramex ${operation} returned HasErrors=true`,
          { operation, body }
        );
      }

      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(operation, payload) {
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await once(operation, payload);
      } catch (error) {
        lastError = error;
        const retryable =
          error.name === 'AbortError' ||
          (error instanceof AramexApiError && !error.operation);
        if (!retryable || attempt === retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
      }
    }
    throw lastError;
  }

  return {
    name,

    /**
     * Books the reverse leg as a standard Aramex shipment with the shipper and
     * consignee reversed — customer as shipper, client warehouse as consignee.
     * There is no dedicated "return" endpoint in Aramex's API.
     */
    createReturnShipment({
      returnId,
      customer,
      warehouse,
      items = [],
      weight,
      description,
      productGroup = 'DOM',
      productType = 'PDX',
      paymentType = 'P',
      pickupDate
    } = {}) {
      const shipment = {
        Reference1: returnId,
        Reference2: '',
        Reference3: '',
        Shipper: toParty(customer),
        Consignee: toParty(warehouse),
        ThirdParty: {},
        ShippingDateTime: pickupDate || new Date().toISOString(),
        DueDate: pickupDate || new Date().toISOString(),
        Comments: `Return ${returnId || ''}`.trim(),
        PickupLocation: '',
        OperationsInstructions: '',
        PaymentType: paymentType,
        Details: {
          Dimensions: null,
          ActualWeight: { Value: weight ?? 0, Unit: 'KG' },
          ChargeableWeight: null,
          DescriptionOfGoods: description || 'Returned goods',
          GoodsOriginCountry: customer?.countryCode || '',
          NumberOfPieces: items.length || 1,
          ProductGroup: productGroup,
          ProductType: productType,
          PaymentOptions: '',
          CashOnDeliveryAmount: null,
          InsuranceAmount: null,
          CashAdditionalAmount: null,
          CashAdditionalAmountDescription: '',
          CustomsValueAmount: null,
          Items: items
        }
      };

      return call('CreateShipments', {
        Shipments: { Shipment: [shipment] },
        Transaction: { Reference1: returnId || '' }
      });
    },

    // --- Tracking / status ---
    trackShipments(shipments = []) {
      return call('TrackShipments', { Shipments: shipments });
    },
    getShipments(shipments = []) {
      return call('GetShipments', { Shipments: shipments });
    },

    normalizeEvent
  };
}

module.exports = {
  createAramexClient,
  name,
  normalizeEvent,
  toParty,
  AramexApiError,
  STATUS_EVENT_MAP,
  //DEFAULT_ENDPOINT
};