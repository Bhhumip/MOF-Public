const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReturnShipment, ReturnShipmentError } = require('../src/return-shipment');

const RFO = 'gid://shopify/ReverseFulfillmentOrder/5';

function makeDetails(overrides = {}) {
    return {
        returnId: 'gid://shopify/Return/1',
        order: {
            id: 'gid://shopify/Order/9', name: '#1090', email: 'a@example.com', phone: null,
            shippingAddress: { name: 'Test Customer', company: null, address1: '1 Test St', address2: null, city: 'Riyadh', province: null, zip: '11111', countryCodeV2: 'SA', phone: '0500000000' },
            fulfillmentOrders: [{
                id: 'gid://shopify/FulfillmentOrder/2',
                assignedLocation: { name: 'Warehouse A', address1: '2 Depot Rd', address2: null, city: 'Jeddah', province: null, zip: '21000', countryCode: 'SA', phone: null },
                lineItemIds: ['gid://shopify/LineItem/4', 'gid://shopify/LineItem/6']
            }],
            ...overrides.order
        },
        reverseFulfillmentOrders: overrides.reverseFulfillmentOrders || [{
            id: RFO,
            lineItems: [
                { lineItemId: 'gid://shopify/LineItem/4', sku: 'SKU1', name: 'Scrub Top', quantity: 2 },
                { lineItemId: 'gid://shopify/LineItem/6', sku: 'SKU2', name: 'Scrub Pants', quantity: 1 }
            ]
        }]
    };
}

test('builds a neutral object with customer, warehouse and items', () => {
    const shipment = buildReturnShipment({ returnId: 'gid://shopify/Return/1', reverseFulfillmentOrderId: RFO, details: makeDetails() });
    assert.equal(shipment.orderName, '#1090');
    assert.equal(shipment.customer.name, 'Test Customer');
    assert.equal(shipment.customer.phone, '0500000000');
    assert.equal(shipment.customer.address.city, 'Riyadh');
    assert.equal(shipment.warehouse.name, 'Warehouse A');
    assert.equal(shipment.warehouse.address.countryCode, 'SA');
    assert.deepEqual(shipment.items.map((item) => item.quantity), [2, 1]);
    assert.equal(shipment.weight, null);
});

test('weight comes from the configured per-item default', () => {
    const shipment = buildReturnShipment({ returnId: 'r', reverseFulfillmentOrderId: RFO, details: makeDetails(), defaultItemWeightKg: 0.5 });
    assert.deepEqual(shipment.weight, { value: 1.5, unit: 'KG' });
});

test('a missing customer address is allowed (the adapter decides if it needs one)', () => {
    const details = makeDetails({ order: { shippingAddress: null } });
    const shipment = buildReturnShipment({ returnId: 'r', reverseFulfillmentOrderId: RFO, details });
    assert.equal(shipment.customer.address, null);
});

test('an unknown RFO is rejected', () => {
    assert.throws(
        () => buildReturnShipment({ returnId: 'r', reverseFulfillmentOrderId: 'gid://shopify/ReverseFulfillmentOrder/999', details: makeDetails() }),
        (error) => error instanceof ReturnShipmentError && error.code === 'rfo_not_found'
    );
});

test('no warehouse is found when the returned items match no fulfillment order', () => {
    const details = makeDetails({ order: { fulfillmentOrders: [{ id: 'f', assignedLocation: { name: 'W' }, lineItemIds: ['gid://shopify/LineItem/999'] }] } });
    assert.throws(
        () => buildReturnShipment({ returnId: 'r', reverseFulfillmentOrderId: RFO, details }),
        (error) => error.code === 'no_warehouse'
    );
});

test('items from two locations are rejected as multiple_warehouses', () => {
    const details = makeDetails({
        order: {
            fulfillmentOrders: [
                { id: 'f1', assignedLocation: { name: 'Warehouse A', address1: 'x', city: 'c', zip: 'z', countryCode: 'SA' }, lineItemIds: ['gid://shopify/LineItem/4'] },
                { id: 'f2', assignedLocation: { name: 'Warehouse B', address1: 'y', city: 'c', zip: 'z', countryCode: 'SA' }, lineItemIds: ['gid://shopify/LineItem/6'] }
            ]
        }
    });
    assert.throws(
        () => buildReturnShipment({ returnId: 'r', reverseFulfillmentOrderId: RFO, details }),
        (error) => error.code === 'multiple_warehouses'
    );
});

test('an RFO with no items is rejected', () => {
    const details = makeDetails({ reverseFulfillmentOrders: [{ id: RFO, lineItems: [] }] });
    assert.throws(
        () => buildReturnShipment({ returnId: 'r', reverseFulfillmentOrderId: RFO, details }),
        (error) => error.code === 'no_return_items'
    );
});