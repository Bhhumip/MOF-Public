const test = require('node:test');
const assert = require('node:assert/strict');
const { createShopifyClient } = require('../src/shopify');

function clientReturning(body) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push(JSON.parse(options.body));
        return { ok: true, status: 200, json: async () => body };
    };
    const client = createShopifyClient({
        storeDomain: 'test.myshopify.com', adminAccessToken: 't', apiVersion: '2026-01', fetchImpl
    });
    return { client, calls };
}

test('getOrderShipping returns id, name, tags and shippingLines', async () => {
    const { client, calls } = clientReturning({
        data: {
            order: {
                id: 'gid://shopify/Order/1', name: '#1001', tags: ['Paytabs', 'RedBox'],
                shippingLines: { nodes: [{ id: 'gid://shopify/ShippingLine/1', title: 'Standard', code: null, source: 'shopify', carrierIdentifier: null, custom: false }] }
            }
        }
    });
    const result = await client.getOrderShipping('1');
    assert.equal(calls[0].variables.id, 'gid://shopify/Order/1');
    assert.deepEqual(result.tags, ['Paytabs', 'RedBox']);
    assert.equal(result.shippingLines.length, 1);
});

test('getOrderShipping throws when the order does not exist', async () => {
    const { client } = clientReturning({ data: { order: null } });
    await assert.rejects(() => client.getOrderShipping('999'), /Order not found/);
});

test('getOrderShipping throws the GraphQL error message', async () => {
    const { client } = clientReturning({ errors: [{ message: 'Access denied for order field.' }] });
    await assert.rejects(() => client.getOrderShipping('1'), /Access denied/);
});

test('getReturnContext returns the return, order tags and RFO ids', async () => {
    const { client, calls } = clientReturning({
        data: {
            return: {
                id: 'gid://shopify/Return/1', status: 'OPEN',
                order: { id: 'gid://shopify/Order/9', name: '#1090', tags: ['aramex'] },
                reverseFulfillmentOrders: { nodes: [{ id: 'gid://shopify/ReverseFulfillmentOrder/5', status: 'OPEN' }] }
            }
        }
    });
    const result = await client.getReturnContext('gid://shopify/Return/1');
    assert.equal(calls[0].variables.id, 'gid://shopify/Return/1');
    assert.deepEqual(result.order.tags, ['aramex']);
    assert.equal(result.reverseFulfillmentOrders[0].id, 'gid://shopify/ReverseFulfillmentOrder/5');
});

test('getReturnContext returns null when the return cannot be read', async () => {
    const { client } = clientReturning({ data: { return: null } });
    assert.equal(await client.getReturnContext('gid://shopify/Return/404'), null);
});

test('getReturnContext requires an id', async () => {
    const { client } = clientReturning({ data: {} });
    await assert.rejects(() => client.getReturnContext(''), /return ID is required/);
});
test('getReturnShipmentDetails reshapes the return into a simple structure', async () => {
    const { client } = clientReturning({
        data: {
            return: {
                id: 'gid://shopify/Return/1',
                order: {
                    id: 'gid://shopify/Order/9', name: '#1090', email: 'a@example.com', phone: null,
                    shippingAddress: { name: 'Test Customer', company: null, address1: '1 Test St', address2: null, city: 'Riyadh', province: null, zip: '11111', countryCodeV2: 'SA', phone: null },
                    fulfillmentOrders: {
                        nodes: [{
                            id: 'gid://shopify/FulfillmentOrder/2',
                            assignedLocation: { name: 'Warehouse A', address1: '2 Depot Rd', address2: null, city: 'Jeddah', province: null, zip: '21000', countryCode: 'SA', phone: null },
                            lineItems: { nodes: [{ lineItem: { id: 'gid://shopify/LineItem/4' } }] }
                        }]
                    }
                },
                reverseFulfillmentOrders: {
                    nodes: [{
                        id: 'gid://shopify/ReverseFulfillmentOrder/5',
                        lineItems: { nodes: [{ totalQuantity: 2, fulfillmentLineItem: { lineItem: { id: 'gid://shopify/LineItem/4', sku: 'SKU1', name: 'Scrub Top', weight: { unit: 'GRAMS', value: 400 } } } }] }
                    }]
                }
            }
        }
    });
    const details = await client.getReturnShipmentDetails('gid://shopify/Return/1');
    assert.deepEqual(details.order.fulfillmentOrders[0].lineItemIds, ['gid://shopify/LineItem/4']);
    assert.equal(details.reverseFulfillmentOrders[0].lineItems[0].quantity, 2);
    assert.equal(details.reverseFulfillmentOrders[0].lineItems[0].sku, 'SKU1');
    assert.deepEqual(details.reverseFulfillmentOrders[0].lineItems[0].weight, { unit: 'GRAMS', value: 400 });
});

test('getReturnShipmentDetails returns null when the return cannot be read', async () => {
    const { client } = clientReturning({ data: { return: null } });
    assert.equal(await client.getReturnShipmentDetails('gid://shopify/Return/404'), null);
});

test('createReverseDeliveryWithShipping sends only fields Shopify accepts', async () => {
    const { client, calls } = clientReturning({
        data: { reverseDeliveryCreateWithShipping: { reverseDelivery: { id: 'gid://shopify/ReverseDelivery/1' }, userErrors: [] } }
    });
    const result = await client.createReverseDeliveryWithShipping({
        reverseFulfillmentOrderId: 'gid://shopify/ReverseFulfillmentOrder/5',
        trackingInput: { number: 'TRK1', company: 'redbox', url: 'https://t.example/1' },
        labelInput: { fileUrl: 'https://l.example/1.pdf', fileName: 'label.pdf' },
        notifyCustomer: true
    });
    const vars = calls[0].variables;
    assert.equal(result.id, 'gid://shopify/ReverseDelivery/1');
    assert.deepEqual(vars.trackingInput, { number: 'TRK1', url: 'https://t.example/1' }); // no company
    assert.deepEqual(vars.labelInput, { fileUrl: 'https://l.example/1.pdf' });            // no fileName
    assert.deepEqual(vars.reverseDeliveryLineItems, []);                                  // all items
    assert.equal(vars.notifyCustomer, true);
});

test('createReverseDeliveryWithShipping omits tracking and label when absent', async () => {
    const { client, calls } = clientReturning({
        data: { reverseDeliveryCreateWithShipping: { reverseDelivery: { id: 'x' }, userErrors: [] } }
    });
    await client.createReverseDeliveryWithShipping({ reverseFulfillmentOrderId: 'gid://shopify/ReverseFulfillmentOrder/5' });
    assert.equal(calls[0].variables.trackingInput, null);
    assert.equal(calls[0].variables.labelInput, null);
});

test('createReverseDeliveryWithShipping throws on userErrors', async () => {
    const { client } = clientReturning({
        data: { reverseDeliveryCreateWithShipping: { reverseDelivery: null, userErrors: [{ field: ['x'], message: 'Not allowed' }] } }
    });
    await assert.rejects(
        () => client.createReverseDeliveryWithShipping({ reverseFulfillmentOrderId: 'gid://shopify/ReverseFulfillmentOrder/5' }),
        /Not allowed/
    );
});

test('createReverseDeliveryWithShipping requires an RFO id', async () => {
    const { client } = clientReturning({ data: {} });
    await assert.rejects(() => client.createReverseDeliveryWithShipping({}), /reverse fulfillment order ID is required/);
});