'use strict';

const name = 'aramex';
const { createAramexSoapTransport, AramexSoapError } = require('./aramex-soap');
const { buildShipment, toParty, AramexContractError } = require('./aramex-contract');
const { parseXml, child, children, descendant, childText } = require('./aramex-xml');
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
  // code: 'carrier_rejected' (Aramex said HasErrors=true), 'incomplete_response',
  //       or a transport code ('timeout', 'network_error', 'soap_fault', 'http_error').
  // outcomeUnknown: true when the request may have created a shipment even though we
  //       got no clean answer. The orchestrator sends these to manual review.
  constructor(message, { operation, body, status, code, outcomeUnknown = false } = {}) {
    super(message);
    this.name = 'AramexApiError';
    this.operation = operation;
    this.body = body;
    this.status = status;
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}

function normalizeEvent(raw = {}) {
  const code = String(raw.UpdateCode || raw.updateCode || '')
    .trim()
    .toLowerCase();

  const status = String(
    raw.Status || raw.status || raw.Event || raw.event || ''
  ).trim().toLowerCase();

  return {
    carrier: name,
    event: STATUS_EVENT_MAP[code] || STATUS_EVENT_MAP[status] || 'unknown',
    rawStatus: code || status || null,
    occurredAt:
      raw.UpdateDateTime ||
      raw.updateDateTime ||
      raw.EventDate ||
      raw.eventDate ||
      null,
    trackingNumber:
      raw.TrackingNumber || raw.trackingNumber || raw.AWBNumber || null,
    raw
  };
}


function parseBoolean(text) {
  if (text == null) return null;
  const value = text.toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

// <Notifications><Notification><Code/><Message/></Notification>...</Notifications>
function parseNotifications(node) {
  return children(node, 'Notification').map((entry) => ({
    code: childText(entry, 'Code') || null,
    message: childText(entry, 'Message') || null
  }));
}

/**
 * Parse a CreateShipments response (WSDL: ShipmentCreationResponse).
 *
 *   ShipmentCreationResponse
 *     HasErrors, Notifications            <- request level
 *     Shipments > ProcessedShipment*
 *       ID, Reference1, HasErrors, Notifications   <- shipment level
 *       ShipmentLabel > LabelURL, LabelFileContents
 *
 * Request-level and shipment-level fields are read as DIRECT children, so the
 * two HasErrors flags and the two Notifications lists can never be mixed up.
 * A field that is missing or marked nil comes back as null (never as false).
 */
function parseShipmentCreationResponse(xml) {
  const response = descendant(parseXml(xml), 'ShipmentCreationResponse');

  const processedShipments = children(child(response, 'Shipments'), 'ProcessedShipment').map((node) => {
    const label = child(node, 'ShipmentLabel');
    return {
      ID: childText(node, 'ID') || null,
      Reference1: childText(node, 'Reference1') || null,
      HasErrors: parseBoolean(childText(node, 'HasErrors')),
      Notifications: parseNotifications(child(node, 'Notifications')),
      LabelURL: childText(label, 'LabelURL') || null,
      LabelFileContents: childText(label, 'LabelFileContents') || null
    };
  });

  return {
    carrier: name,
    HasErrors: parseBoolean(childText(response, 'HasErrors')),
    Notifications: parseNotifications(child(response, 'Notifications')),
    ProcessedShipments: processedShipments,
    rawXml: xml
  };
}

// One request carries one shipment, but match by our reference when several come back.
function pickProcessedShipment(processedShipments, reference) {
  return processedShipments.find((entry) => reference && entry.Reference1 === reference)
    ?? processedShipments[0]
    ?? null;
}

// "ERR01 Invalid account; ERR30 Line1 is empty": the reasons Aramex gave, in one line.
function describeNotifications(notifications) {
  return notifications
    .map((entry) => [entry.code, entry.message].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('; ');
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
    productGroup,
    productType,
    paymentType,
    paymentOptions,
    dimensionsCm,
    warehousePhone,
    warehouseEmail,
    fetchImpl = globalThis.fetch,
    timeoutMs = 20000
  } = config;

  if (!endpoint) {
    throw new Error('Aramex client requires a SOAP service endpoint');
  }

  if (!username || !password) {
    throw new Error(
      'Aramex client requires username/password issued by Aramex account management'
    );
  }

  const transport = createAramexSoapTransport({
    endpoint,
    fetchImpl,
    timeoutMs
  });

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

  return {
    name,

    // Receives the carrier-neutral returnShipment built by return-shipment.js.
    // The mapping and the required-field checks live in aramex-contract.js.
    async createReturnShipment(returnShipment = {}) {
      // May throw AramexContractError('invalid_shipment', { missing }) before any
      // network call; the orchestrator routes that to manual review.
      const shipment = buildShipment(returnShipment, {
        // Only defined values are passed, so the contract defaults still apply.
        ...(productGroup && { productGroup }),
        ...(productType && { productType }),
        ...(paymentType && { paymentType }),
        ...(paymentOptions != null && { paymentOptions }),
        ...(dimensionsCm && { dimensionsCm }),
        fallbackPhone: warehousePhone,
        fallbackEmail: warehouseEmail
      });
      const returnId = returnShipment.returnId;


      const request = {
        ClientInfo: clientInfo(),
        Transaction: {
          Reference1: returnId || ''
        },
        Shipments: {
          Shipment: [shipment]
        },
        LabelInfo: {
          ReportID: 9201,
          ReportType: 'URL'
        }
      };

      try {
        const xml = await transport.call(
          'CreateShipments',
          'ShipmentCreationRequest',
          request
        );

        const result = parseShipmentCreationResponse(xml);
        const processedShipment = pickProcessedShipment(result.ProcessedShipments, returnId);
        const notifications = [
          ...result.Notifications,
          ...(processedShipment?.Notifications ?? [])
        ];
        const reasons = describeNotifications(notifications);
        const failureMessage =
          'Aramex CreateShipments returned an incomplete or unsuccessful shipment response' +
          (reasons ? `: ${reasons}` : '');

        // 1. Aramex said no (either level). Nothing was created, so a retry cannot duplicate.
        if (result.HasErrors === true || processedShipment?.HasErrors === true) {
          throw new AramexApiError(failureMessage, {
            operation: 'CreateShipments',
            code: 'carrier_rejected',
            body: result
          });
        }

        // 2. Not a clear "yes" either: a missing flag, a missing shipment or a missing AWB.
        // Aramex may have created the shipment, so this must be reconciled, not retried.
        if (
          result.HasErrors !== false ||
          !processedShipment ||
          processedShipment.HasErrors !== false ||
          !processedShipment.ID
        ) {
          throw new AramexApiError(failureMessage, {
            operation: 'CreateShipments',
            code: 'incomplete_response',
            outcomeUnknown: true,
            body: result
          });
        }

        // Success. LabelURL is a link to the label PDF, NOT a tracking page, so
        // trackingUrl stays null. The label uses the same shape as the RedBox adapter.
        return {
          ...result,
          shipmentId: processedShipment.ID,
          trackingNumber: processedShipment.ID,
          trackingUrl: null,
          label: processedShipment.LabelURL
            ? { url: processedShipment.LabelURL, fileName: `aramex-${processedShipment.ID}.pdf` }
            : null,
          notifications
        };
      } catch (error) {
        if (error instanceof AramexSoapError) {
          throw new AramexApiError(error.message, {
            operation: error.operation,
            status: error.status,
            body: error.body,
            code: error.code,
            outcomeUnknown: error.outcomeUnknown
          });
        }

        throw error;
      }
    },

    // Tracking uses a separate Aramex service contract and will be integrated separately.
    async trackShipments() {
      throw new AramexApiError(
        'Aramex tracking SOAP service has not been configured yet',
        { operation: 'TrackShipments' }
      );
    },

    // Shipment retrieval requires its own verified SOAP request contract.
    async getShipments() {
      throw new AramexApiError(
        'Aramex GetShipments SOAP request has not been configured yet',
        { operation: 'GetShipments' }
      );
    },

    normalizeEvent
  };
}

module.exports = {
  createAramexClient,
  name,
  normalizeEvent,
  toParty,
  AramexContractError,
  AramexApiError,
  STATUS_EVENT_MAP,
  parseShipmentCreationResponse
};
