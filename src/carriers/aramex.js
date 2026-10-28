'use strict';

const name = 'aramex';
const { createAramexSoapTransport, AramexSoapError, ARRAYS_NAMESPACE } = require('./aramex-soap');
const { buildShipment, toParty, AramexContractError } = require('./aramex-contract');
const { parseXml, child, children, descendant, childText } = require('./aramex-xml');
const { computePickupWindow, buildPickup } = require('./aramex-pickup');

/**
 * Aramex tracking: UpdateCode -> internal event.
 *
 * NOT FILLED IN ON PURPOSE. The tracking WSDL does not list the update codes
 * and the earlier sh001..sh008 table was a placeholder. Until Aramex confirms
 * its code list (or the first sandbox/production responses show it), codes are
 * classified from the UpdateDescription text (see DESCRIPTION_RULES) and every
 * classification is logged with the raw code so the codes can be pinned here
 * or through ARAMEX_STATUS_MAP (JSON, e.g. {"SH005":"returned"}).
 */
const STATUS_EVENT_MAP = Object.freeze({});

/**
 * Description -> event, first match wins. HEURISTIC, to be replaced by real
 * codes. A return travels customer -> warehouse, so "delivered" means the
 * parcel reached the warehouse: that is the internal `returned` event, which
 * the Shopify sync already tags as Return-Received. A parcel going BACK to the
 * customer (return to shipper) is an `exception` that needs a person.
 */
const DESCRIPTION_RULES = Object.freeze([
  [/\bcancel/i, 'cancelled'],
  [/return(ed)? to (the )?(shipper|sender|origin)|\brts\b/i, 'exception'],
  [/undeliver|not deliver|unable to deliver|attempt|refus|no one|not available|incorrect address|wrong address|address (not found|issue)|on hold|\bheld\b|damag|\blost\b|problem/i, 'exception'],
  [/out for delivery|with (the )?courier|delivery in progress/i, 'out_for_delivery'],
  [/\bdelivered\b/i, 'returned'],
  [/picked up|\bcollected\b|pick-?up completed|received from (the )?shipper/i, 'picked_up'],
  [/in transit|departed|arrived|transferred|processing|sorted|forwarded|\bat (the )?(origin|destination|hub|facility|station)/i, 'in_transit'],
  [/created|data received|booked|information received|awaiting|ready for pick/i, 'created']
]);

class AramexApiError extends Error {
  // code: 'carrier_rejected' (Aramex said HasErrors=true), 'incomplete_response',
  //       'not_configured', or a transport code ('timeout', 'network_error',
  //       'soap_fault', 'http_error').
  // outcomeUnknown: true when the request may have created something even though we
  //       got no clean answer. The orchestrator sends these to manual review.
  // notifications: Aramex's own [{code, message}] list (e.g. ERR50), when it sent one.
  constructor(message, { operation, body, status, code, outcomeUnknown = false, notifications = [] } = {}) {
    super(message);
    this.name = 'AramexApiError';
    this.operation = operation;
    this.body = body;
    this.status = status;
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
    this.notifications = notifications;
  }

  hasNotification(code) {
    return this.notifications.some((entry) => entry.code === code);
  }
}

// Aramex dates carry no time zone ("2026-10-21T10:15:00"); they are station local time.
function toIsoWithOffset(value, utcOffsetMinutes = 180) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/(Z|[+-]\d{2}:\d{2})$/.test(text)) return text;
  const sign = utcOffsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(utcOffsetMinutes);
  const pad = (n) => String(n).padStart(2, '0');
  return `${text.replace(/\.\d+$/, '')}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/**
 * One Aramex TrackingResult -> the internal event shape shared with RedBox.
 * options: statusMap ({ CODE: event }), heuristics (default true), utcOffsetMinutes.
 */
function normalizeEvent(raw = {}, { statusMap = {}, heuristics = true, utcOffsetMinutes = 180 } = {}) {
  const code = String(raw.UpdateCode ?? raw.updateCode ?? '').trim().toUpperCase();
  const description = String(raw.UpdateDescription ?? raw.updateDescription ?? '').trim();

  let event = statusMap[code] || STATUS_EVENT_MAP[code] || null;
  let classifiedBy = event ? 'code' : null;
  if (!event && heuristics && description) {
    const rule = DESCRIPTION_RULES.find(([pattern]) => pattern.test(description));
    if (rule) {
      event = rule[1];
      classifiedBy = 'description';
    }
  }

  return {
    carrier: name,
    event: event || 'unknown',
    classifiedBy,
    rawStatus: code || description || null,
    occurredAt: toIsoWithOffset(raw.UpdateDateTime ?? raw.updateDateTime, utcOffsetMinutes),
    trackingNumber: raw.WaybillNumber ?? raw.trackingNumber ?? null,
    // status_name is what the Shopify sync shows as the carrier's own wording.
    raw: { ...raw, status_name: description || code || null }
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
/**
 * Parse a CreatePickup response (WSDL: PickupCreationResponse).
 *   HasErrors, Notifications, ProcessedPickup > ID, GUID, Reference1
 * ID is the collection reference number; GUID is what CancelPickup needs.
 */
function parsePickupCreationResponse(xml) {
  const response = descendant(parseXml(xml), 'PickupCreationResponse');
  const pickup = child(response, 'ProcessedPickup');
  return {
    HasErrors: parseBoolean(childText(response, 'HasErrors')),
    Notifications: parseNotifications(child(response, 'Notifications')),
    ProcessedPickup: pickup
      ? { ID: childText(pickup, 'ID') || null, GUID: childText(pickup, 'GUID') || null }
      : null,
    rawXml: xml
  };
}

/**
 * Parse a TrackShipments response (tracking WSDL: ShipmentTrackingResponse).
 *   HasErrors, Notifications,
 *   TrackingResults > KeyValueOfstringArrayOfTrackingResult* > Key (the waybill),
 *                                                              Value > TrackingResult*
 * Returns { HasErrors, Notifications, results: { <waybill>: [TrackingResult...] } }.
 * A waybill Aramex does not know comes back with an empty list (or not at all):
 * that is "nothing yet", not an error.
 */
function parseTrackingResponse(xml) {
  const response = descendant(parseXml(xml), 'ShipmentTrackingResponse');
  const results = {};
  for (const entry of child(response, 'TrackingResults')?.children ?? []) {
    if (!entry.name.startsWith('KeyValueOf')) continue;
    const waybill = childText(entry, 'Key');
    if (!waybill) continue;
    results[waybill] = children(child(entry, 'Value'), 'TrackingResult').map((node) => ({
      WaybillNumber: childText(node, 'WaybillNumber') || waybill,
      UpdateCode: childText(node, 'UpdateCode') || null,
      UpdateDescription: childText(node, 'UpdateDescription') || null,
      UpdateDateTime: childText(node, 'UpdateDateTime') || null,
      UpdateLocation: childText(node, 'UpdateLocation') || null,
      Comments: childText(node, 'Comments') || null,
      ProblemCode: childText(node, 'ProblemCode') || null
    }));
  }
  return {
    HasErrors: parseBoolean(childText(response, 'HasErrors')),
    Notifications: parseNotifications(child(response, 'Notifications')),
    results,
    rawXml: xml
  };
}

// The Transaction element has five REQUIRED references in every Aramex WSDL
// (a missing one is a deserialization fault), so all five are always sent.
function transaction(reference = '') {
  return {
    Reference1: String(reference).slice(0, 50),
    Reference2: '',
    Reference3: '',
    Reference4: '',
    Reference5: ''
  };
}


function createAramexClient(config = {}) {
  const {
    endpoint,
    trackingEndpoint,
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
    useForeignHawb = true,
    pickupWindow = {},
    pickupLocation,
    pickupVehicle,
    statusMap = {},
    statusHeuristics = true,
    utcOffsetMinutes = 180,
    now = () => new Date(),
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

  const transport = createAramexSoapTransport({ endpoint, fetchImpl, timeoutMs });
  // Tracking is a different Aramex service URL. Created only when the URL is known,
  // so booking works before the tracking URL is.
  const trackingTransport = trackingEndpoint
    ? createAramexSoapTransport({ endpoint: trackingEndpoint, fetchImpl, timeoutMs })
    : null;

  // Tracking ClientInfo has NO Source element (see the tracking WSDL).
  function clientInfo({ withSource = true } = {}) {
    return {
      UserName: username,
      Password: password,
      Version: version,
      AccountNumber: accountNumber || '',
      AccountPin: accountPin || '',
      AccountEntity: accountEntity || '',
      AccountCountryCode: accountCountryCode || '',
      ...(withSource && { Source: source })
    };
  }

  // Runs a transport call and converts transport errors to AramexApiError.
  async function call(transportToUse, operation, wrapper, request) {
    try {
      return await transportToUse.call(operation, wrapper, request);
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
        useForeignHawb,
        fallbackPhone: warehousePhone,
        fallbackEmail: warehouseEmail
      });
      const returnId = returnShipment.returnId;

      const request = {
        ClientInfo: clientInfo(),
        Transaction: transaction(returnId),
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
            notifications,
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

    /**
     * Step 2 of a return: ask Aramex to collect the parcel from the customer.
     * Needs the AWB from createReturnShipment. Separate from the booking on purpose:
     * a failed pickup never undoes a booked shipment, it is retried / reviewed.
     */
    async createPickup(returnShipment = {}, { awb } = {}) {
      const window = computePickupWindow(now(), { utcOffsetMinutes, ...pickupWindow });
      const pickup = buildPickup(returnShipment, {
        awb,
        accountEntity,
        window,
        ...(productGroup && { productGroup }),
        ...(productType && { productType }),
        ...(paymentType && { paymentType }),
        ...(dimensionsCm && { dimensionsCm }),
        ...(pickupLocation && { location: pickupLocation }),
        ...(pickupVehicle && { vehicle: pickupVehicle }),
        fallbackEmail: warehouseEmail
      });

      const xml = await call(transport, 'CreatePickup', 'PickupCreationRequest', {
        ClientInfo: clientInfo(),
        Transaction: transaction(returnShipment.returnId),
        Pickup: pickup,
        LabelInfo: { ReportID: 9201, ReportType: 'URL' }
      });

      const result = parsePickupCreationResponse(xml);
      const reasons = describeNotifications(result.Notifications);
      const failureMessage =
        'Aramex CreatePickup returned an unsuccessful response' + (reasons ? `: ${reasons}` : '');

      if (result.HasErrors === true) {
        throw new AramexApiError(failureMessage, {
          operation: 'CreatePickup',
          code: 'carrier_rejected',
          notifications: result.Notifications,
          body: result
        });
      }
      if (result.HasErrors !== false || !result.ProcessedPickup?.ID) {
        throw new AramexApiError(failureMessage, {
          operation: 'CreatePickup',
          code: 'incomplete_response',
          outcomeUnknown: true,
          notifications: result.Notifications,
          body: result
        });
      }

      return {
        pickupId: result.ProcessedPickup.ID,
        pickupGuid: result.ProcessedPickup.GUID,
        pickupDate: window.pickupDate,
        readyTime: window.readyTime,
        notifications: result.Notifications
      };
    },

    /**
     * Latest tracking status for up to ~50 AWBs in one call.
     * Returns { results: { AWB: [TrackingResult...] } }. An AWB Aramex does not know
     * is simply absent / empty: that means "nothing yet", not an error.
     */
    async trackShipments(awbs = [], { lastOnly = true } = {}) {
      if (!trackingTransport) {
        throw new AramexApiError('Aramex tracking endpoint (ARAMEX_TRACKING_ENDPOINT) is not configured', {
          operation: 'TrackShipments',
          code: 'not_configured'
        });
      }
      const list = [...new Set(awbs.map(String).filter(Boolean))];
      if (list.length === 0) return { results: {}, notifications: [] };

      const xml = await call(trackingTransport, 'TrackShipments', 'ShipmentTrackingRequest', {
        ClientInfo: clientInfo({ withSource: false }),
        Transaction: transaction(),
        // .NET string array: every <string> carries the Arrays namespace.
        Shipments: { string: list.map((awb) => ({ '@xmlns': ARRAYS_NAMESPACE, '#text': awb })) },
        GetLastTrackingUpdateOnly: Boolean(lastOnly)
      });

      const result = parseTrackingResponse(xml);
      if (result.HasErrors === true) {
        throw new AramexApiError(
          `Aramex TrackShipments returned errors: ${describeNotifications(result.Notifications)}`,
          { operation: 'TrackShipments', code: 'carrier_rejected', notifications: result.Notifications, body: result }
        );
      }
      return { results: result.results, notifications: result.Notifications };
    },

    // Shipment retrieval requires its own verified SOAP request contract.
    async getShipments() {
      throw new AramexApiError(
        'Aramex GetShipments SOAP request has not been configured yet',
        { operation: 'GetShipments' }
      );
    },

    normalizeEvent: (raw) => normalizeEvent(raw, { statusMap, heuristics: statusHeuristics, utcOffsetMinutes })
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
  parseShipmentCreationResponse,
  parsePickupCreationResponse,
  parseTrackingResponse,
  transaction
};
