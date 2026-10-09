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
    const totalQuantity = rfo.lineItems.reduce((sum, item) => sum + item.quantity, 0);

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
        weight: defaultItemWeightKg == null
            ? null
            : { value: Number((defaultItemWeightKg * totalQuantity).toFixed(3)), unit: 'KG' },
        description: `Return for order ${order.name}`
    };
}

module.exports = { buildReturnShipment, ReturnShipmentError };