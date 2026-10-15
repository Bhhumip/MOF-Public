'use strict';

class ReturnShipmentError extends Error {
    constructor(code, message) {
        super(message || code);
        this.name = 'ReturnShipmentError';
        this.code = code;
    }
}

function toAddress(source) {
    if (!source) return null;
    return {
        line1: source.address1 || '',
        line2: source.address2 || '',
        city: source.city || '',
        state: source.province || '',
        postCode: source.zip || '',
        countryCode: source.countryCodeV2 || source.countryCode || ''
    };
}

const KG_PER_UNIT = Object.freeze({
    GRAMS: 0.001,
    KILOGRAMS: 1,
    OUNCES: 0.028349523125,
    POUNDS: 0.45359237
});

// Weight of ONE unit in kilograms, or null when unknown (missing, zero or an unknown unit).
function toKilograms(weight) {
    if (!weight || !(weight.value > 0)) return null;
    const factor = KG_PER_UNIT[weight.unit];
    return factor ? weight.value * factor : null;
}

// Real item weights times quantity. An item without a weight uses the configured
// default; with no default the whole total is unknown (null) rather than guessed.
function totalWeightKg(items, defaultItemWeightKg) {
    let total = 0;
    let estimated = false;
    for (const item of items) {
        let unitKg = toKilograms(item.weight);
        if (unitKg == null) {
            if (defaultItemWeightKg == null) return { kg: null, estimated: false };
            unitKg = defaultItemWeightKg;
            estimated = true;
        }
        total += unitKg * item.quantity;
    }
    return { kg: Math.max(Number(total.toFixed(3)), 0.001), estimated };
}

// Tracking numbers on the outbound fulfillment(s) that carried the returned items.
function collectOriginalTracking(fulfillments, returnedIds) {
    const found = [];
    for (const fulfillment of fulfillments || []) {
        const carriesReturnedItem = (fulfillment.lineItemIds || []).some((id) => returnedIds.has(id));
        if (!carriesReturnedItem) continue;
        for (const info of fulfillment.trackingInfo || []) {
            const number = String(info?.number ?? '').trim();
            if (number) found.push({ number, company: String(info.company ?? '').trim() });
        }
    }
    return found;
}

/**
 * Build the carrier-neutral object every adapter receives.
 * Throws ReturnShipmentError (with a code) when something every carrier
 * needs is missing, so the caller can send the case to manual review.
 */
function buildReturnShipment({ returnId, reverseFulfillmentOrderId, details, defaultItemWeightKg = null }) {
    const rfo = details.reverseFulfillmentOrders.find((entry) => entry.id === reverseFulfillmentOrderId);
    if (!rfo) throw new ReturnShipmentError('rfo_not_found');
    if (rfo.lineItems.length === 0) throw new ReturnShipmentError('no_return_items');

    const returnedIds = new Set(rfo.lineItems.map((item) => item.lineItemId).filter(Boolean));
    const locations = new Map();
    for (const fulfillmentOrder of details.order.fulfillmentOrders) {
        const holdsReturnedItem = fulfillmentOrder.lineItemIds.some((id) => returnedIds.has(id));
        if (holdsReturnedItem && fulfillmentOrder.assignedLocation) {
            locations.set(fulfillmentOrder.assignedLocation.name, fulfillmentOrder.assignedLocation);
        }
    }
    if (locations.size === 0) throw new ReturnShipmentError('no_warehouse');
    if (locations.size > 1) throw new ReturnShipmentError('multiple_warehouses');
    const [location] = locations.values();

    const order = details.order;
    const shipping = order.shippingAddress;
    const { kg, estimated } = totalWeightKg(rfo.lineItems, defaultItemWeightKg);


    return {
        returnId,
        reverseFulfillmentOrderId,
        orderName: order.name,
        customer: {
            name: shipping?.name || '',
            company: shipping?.company || '',
            phone: shipping?.phone || order.phone || '',
            email: order.email || '',
            address: toAddress(shipping)
        },
        warehouse: {
            name: location.name,
            phone: location.phone || '',
            address: toAddress(location)
        },
        items: rfo.lineItems.map((item) => ({ sku: item.sku, name: item.name, quantity: item.quantity })),
        weight: kg == null ? null : { value: kg, unit: 'KG' },
        weightEstimated: estimated,
        originalTracking: collectOriginalTracking(order.fulfillments, returnedIds),
    };
}

module.exports = { buildReturnShipment, ReturnShipmentError };