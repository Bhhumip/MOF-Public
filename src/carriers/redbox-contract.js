'use strict';

/**
 * RedBox request/response contract.
 *
 * Source: RedBox API V3 reference (docs.api.redboxsa.com), endpoints used:
 *   POST /v3/shipments/returns   "Create return shipment"
 *   GET  /v3/shipments/{id}      id = shipment_id OR tracking_number
 *   GET  /v3/shipments/{id}/label | /tracking-page | /status | /activities
 *   GET  /v3/shipments?page&page_size
 *   POST /v3/shipments/{id}/cancel
 *   POST /v3/webhooks            event: shipment.status.update | shipment.created
 *
 * Everything that depends on RedBox's field names lives here and nowhere else.
 *
 * Still to VERIFY in the RedBox sandbox (the docs are silent or ambiguous):
 *   - Return semantics. The docs call `sender_*` "the sender who will receive
 *     the return shipment" (i.e. the business/warehouse, defaulting to the
 *     business details) and `customer_*` the person returning the goods.
 *   - Accepted values: weight_unit, phone format, max length of `reference`.
 *   - The full list of status_code values (see STATUS_EVENT_MAP in redbox.js).
 *   - The docs prose mentions externalCarrierName / externalTrackingNumber for
 *     external returns, but neither field is in the schema. Ask RedBox.
 *   - Whether a duplicate `reference` really returns 409 on this endpoint.
 */

const confirmed = true; // schema taken from the official reference; sandbox verification pending

class RedboxContractError extends Error {
    constructor(code, message, details = {}) {
        super(message || code);
        this.name = 'RedboxContractError';
        this.code = code;
        Object.assign(this, details);
    }
}

function clean(value) {
    return value == null ? '' : String(value).trim();
}

/** "Line1, Line2, City, State, Postcode" -> one string (RedBox address fields are single strings). */
function joinAddress(address) {
    if (!address) return '';
    return [address.line1, address.line2, address.city, address.state, address.postCode]
        .map(clean)
        .filter(Boolean)
        .join(', ');
}

/** Shopify GIDs end in the numeric id: gid://shopify/ReverseFulfillmentOrder/5 -> "5". */
function gidTail(gid) {
    return clean(gid).split('/').pop();
}

/**
 * Human-readable AND unique per RFO, e.g. "RET-1090-5". RedBox treats
 * `reference` as the business's own order number and (per the error table)
 * rejects duplicates with 409, so it doubles as our duplicate guard.
 */
function buildReference(shipment) {
    const order = clean(shipment.orderName).replace(/^#/, '');
    const tail = gidTail(shipment.reverseFulfillmentOrderId);
    return ['RET', order, tail].filter(Boolean).join('-');
}

const omitEmpty = (object) =>
    Object.fromEntries(Object.entries(object).filter(([, value]) => value !== '' && value != null));

/**
 * Neutral returnShipment -> body for POST /v3/shipments/returns.
 *
 * Two modes, as documented by RedBox:
 *  - INTERNAL: `originalShipmentId` is a RedBox shipment. RedBox loads its
 *    details itself, so only the reference is sent (it is optional in that
 *    mode, but we want it for duplicate protection and support lookups).
 *  - EXTERNAL: no original shipment. RedBox needs reference, customer_name
 *    and customer_phone; everything else we know is sent along.
 *
 * Roles: customer_* = the customer returning the goods (from Shopify's shipping
 * address); sender_* = who receives the return = our warehouse (from the
 * fulfillment location). Missing sender_* fields are simply omitted; RedBox then
 * falls back to the business's own details.
 *
 * Throws RedboxContractError('invalid_shipment', { missing }) BEFORE any network
 * call when a required field is empty.
 */
function buildReturnShipmentRequest(shipment = {}, { originalShipmentId = null } = {}) {
    const reference = buildReference(shipment);

    if (originalShipmentId) {
        return { original_shipment_id: String(originalShipmentId), reference };
    }

    const { customer = {}, warehouse = {}, items = [], weight } = shipment;
    const customerAddress = customer.address || null;
    const warehouseAddress = warehouse.address || null;

    const body = omitEmpty({
        reference,
        customer_name: clean(customer.name),
        customer_phone: clean(customer.phone),
        customer_email: clean(customer.email),
        customer_address: joinAddress(customerAddress),
        customer_city: clean(customerAddress?.city),
        customer_country: clean(customerAddress?.countryCode),

        sender_name: clean(warehouse.name),
        sender_phone: clean(warehouse.phone),
        sender_address: joinAddress(warehouseAddress),

        weight_unit: weight && weight.value > 0 ? 'kg' : '', // accepted spellings unconfirmed
        weight_value: weight && weight.value > 0 ? weight.value : undefined,

        items: items.length
            ? items.map((item) =>
                omitEmpty({
                    name: clean(item.name) || clean(item.sku) || 'item',
                    sku: clean(item.sku),
                    quantity: item.quantity || 1
                    // description / unit_price / currency: not in the neutral object yet
                })
            )
            : undefined
    });

    const missing = ['reference', 'customer_name', 'customer_phone'].filter((field) => !body[field]);
    if (missing.length > 0) {
        throw new RedboxContractError(
            'invalid_shipment',
            `RedBox create-return is missing required field(s): ${missing.join(', ')}`,
            { missing }
        );
    }
    return body;
}

/**
 * Create / create-return response -> { shipmentId, trackingNumber, labelUrl }.
 *   { "shipment_id", "tracking_number", "shipping_label_url", "success": true }
 * Never report success without BOTH ids (Shopify needs the tracking number).
 */
function parseCreateShipmentResponse(response) {
    const body = response && typeof response === 'object' ? response : {};

    if (body.success === false) {
        throw new RedboxContractError(
            'carrier_reported_failure',
            `RedBox reported failure: ${clean(body.msg) || 'no message'}`,
            { body: response }
        );
    }

    const shipmentId = body.shipment_id ?? null;
    const trackingNumber = body.tracking_number ?? null;
    if (!shipmentId || !trackingNumber) {
        throw new RedboxContractError(
            'unrecognized_response',
            'RedBox response is missing shipment_id and/or tracking_number',
            { body: response }
        );
    }
    return {
        shipmentId: String(shipmentId),
        trackingNumber: String(trackingNumber),
        labelUrl: clean(body.shipping_label_url) || null
    };
}

const urlOrNull = (value) => (typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null);

/** GET /shipments/{id}/label -> { success, url } */
const parseLabelResponse = (response) => urlOrNull(response?.url);

/** GET /shipments/{id}/tracking-page -> { original_url, short_url, success } */
const parseTrackingPageResponse = (response) =>
    urlOrNull(response?.original_url) || urlOrNull(response?.short_url);

/** GET /shipments/{id} -> { shipment: { id, tracking_number, is_return, reference, status_code, ... } } */
function parseShipmentDetails(response) {
    const shipment = response?.shipment;
    if (!shipment?.id) return null;
    return {
        shipmentId: String(shipment.id),
        trackingNumber: shipment.tracking_number ? String(shipment.tracking_number) : null,
        isReturn: Boolean(shipment.is_return),
        reference: shipment.reference ?? null
    };
}

/** GET /shipments?page&page_size -> { shipments: [...], paging: { total_pages } } */
function parseShipmentList(response) {
    return {
        shipments: Array.isArray(response?.shipments) ? response.shipments : [],
        totalPages: Number(response?.paging?.total_pages) || 1
    };
}

/**
 * POST /v3/webhooks body. One event per registration. `headers` are the headers
 * RedBox will send WITH every delivery to target_url, which is how deliveries
 * are authenticated: we choose a secret and check for it (see verifyBearerToken).
 */
function buildWebhookRegistration({ event, targetUrl, subscriber, originalId, secret } = {}) {
    return {
        event,
        headers: {
            Authorization: `Bearer ${secret}`,
            'Content-Type': 'application/json'
        },
        original_id: originalId,
        subscriber,
        target_url: targetUrl
    };
}

/**
 * Webhook delivery body (event shipment.status.update):
 *   shipment_id, tracking_number, status_name, status_label, status_code,
 *   date (ISO), customer_message
 * -> flat object understood by normalizeEvent. RedBox sends no event id, so the
 * receiver de-duplicates on tracking number + status + date.
 */
function parseWebhookEvent(body = {}) {
    return {
        eventId: null,
        status: body.status_code ?? body.status_name ?? body.status_label ?? null,
        statusName: body.status_name ?? null,
        statusLabel: body.status_label ?? null,
        occurredAt: body.date ?? null,
        trackingNumber: body.tracking_number ?? null,
        shipmentId: body.shipment_id ?? null,
        raw: body
    };
}

module.exports = {
    confirmed,
    RedboxContractError,
    joinAddress,
    buildReference,
    buildReturnShipmentRequest,
    parseCreateShipmentResponse,
    parseLabelResponse,
    parseTrackingPageResponse,
    parseShipmentDetails,
    parseShipmentList,
    buildWebhookRegistration,
    parseWebhookEvent
};