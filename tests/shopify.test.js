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