'use strict';

const name = 'aramex';
const { createAramexSoapTransport, AramexSoapError } = require('./aramex-soap');

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
  constructor(message, { operation, body, status } = {}) {
    super(message);
    this.name = 'AramexApiError';
    this.operation = operation;
    this.body = body;
    this.status = status;
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

// Maps a neutral party descriptor to Aramex's Shipper or Consignee structure.
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

// Extracts simple text values from a SOAP response, allowing namespace prefixes.
function getXmlText(xml, elementName) {
  const escapedName = elementName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(
    `<(?:[\\w.-]+:)?${escapedName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escapedName}\\s*>`,
    'i'
  );
  const match = xml.match(expression);

  if (!match) return null;

  return match[1]
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

// Converts the common shipment-creation response fields while retaining the original XML.
function parseShipmentCreationResponse(xml) {
  // Extract the response wrapper so shipment-level fields cannot be
  // mistaken for fields belonging to the overall response.
  const responseMatch = xml.match(
    /<(?:[\w.-]+:)?ShipmentCreationResponse\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?ShipmentCreationResponse\s*>/i
  );

  const responseXml = responseMatch?.[1] || '';

  // Exclude the Shipments container before reading the overall HasErrors flag.
  const responseWithoutShipments = responseXml
    .replace(
      /<(?:[\w.-]+:)?Shipments\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?Shipments\s*>/i,
      ''
    )
    .replace(
      /<(?:[\w.-]+:)?Shipments\b[^>]*\/\s*>/i,
      ''
    );

  const hasErrorsText = getXmlText(
    responseWithoutShipments,
    'HasErrors'
  );
  const hasErrors = hasErrorsText === null
    ? null
    : hasErrorsText.toLowerCase() === 'true';

  const processedShipmentMatch = xml.match(
    /<(?:[\w.-]+:)?ProcessedShipment\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?ProcessedShipment\s*>/i
  );
  const processedShipmentXml = processedShipmentMatch?.[1] || '';
  // Read the individual shipment status as well as the overall response status.
  const shipmentHasErrorsText = getXmlText(
    processedShipmentXml,
    'HasErrors'
  );

  const shipmentHasErrors = shipmentHasErrorsText === null
    ? null
    : shipmentHasErrorsText.toLowerCase() === 'true';

  const trackingNumber = getXmlText(processedShipmentXml, 'ID');
  const trackingUrl = getXmlText(processedShipmentXml, 'LabelURL');
  const label = getXmlText(processedShipmentXml, 'LabelFileContents');

  const notifications = [];
  const notificationExpression =
    /<(?:[\w.-]+:)?Notification\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Notification\s*>/gi;

  for (const match of xml.matchAll(notificationExpression)) {
    const message = getXmlText(match[1], 'Message');
    const code = getXmlText(match[1], 'Code');

    notifications.push({ code, message });
  }

  return {
    carrier: name,
    HasErrors: hasErrors,
    Notifications: notifications,
    ProcessedShipments: processedShipmentMatch
      ? [{
        ID: trackingNumber,
        LabelURL: trackingUrl,
        LabelFileContents: label,
        LabelFileContents: label,
        HasErrors: shipmentHasErrors
      }]
      : [],
    trackingNumber,
    trackingUrl,
    label,
    rawXml: xml
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
      AccountCountryCode: accountCountryCode || ''
    };
  }

  return {
    name,

    async createReturnShipment({
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
      const shippingDateTime = pickupDate || new Date().toISOString();

      const shipment = {
        Reference1: returnId || '',
        Reference2: '',
        Reference3: '',
        Shipper: toParty(customer),
        Consignee: toParty(warehouse),
        ThirdParty: {},
        ShippingDateTime: shippingDateTime,
        DueDate: shippingDateTime,
        Comments: `Return ${returnId || ''}`.trim(),
        PickupLocation: '',
        OperationsInstructions: '',
        PaymentType: paymentType,
        Details: {
          Dimensions: null,
          ActualWeight: {
            Value: weight ?? 0,
            Unit: 'KG'
          },
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

        // A shipment must not be reported as successful unless the overall
        // response and the individual shipment both explicitly report no errors.
        const processedShipment = result.ProcessedShipments[0];

        if (
          result.HasErrors !== false ||
          !processedShipment ||
          processedShipment.HasErrors !== false ||
          !processedShipment.ID
        ) {
          throw new AramexApiError(
            'Aramex CreateShipments returned an incomplete or unsuccessful shipment response',
            {
              operation: 'CreateShipments',
              body: result
            }
          );
        }

        return {
          ...result,
          trackingNumber: processedShipment.ID
        };
      } catch (error) {
        if (error instanceof AramexSoapError) {
          throw new AramexApiError(error.message, {
            operation: error.operation,
            status: error.status,
            body: error.body
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
  AramexApiError,
  STATUS_EVENT_MAP,
  parseShipmentCreationResponse
};
