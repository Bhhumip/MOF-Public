const test = require('node:test');
const assert = require('node:assert/strict');
const { getConfig } = require('../src/config');

const base = { SHOPIFY_STORE_DOMAIN: 'dev.myshopify.com', SHOPIFY_ADMIN_ACCESS_TOKEN: 't', SHOPIFY_WEBHOOK_SECRET: 's' };

test('defaults to dry-run mode', () => {
    assert.equal(getConfig(base).carrierMode, 'dry-run');
});

test('live mode is blocked', () => {
    assert.throws(() => getConfig({ ...base, CARRIER_MODE: 'live' }), /blocked/);
});

test('production carrier hosts are rejected', () => {
    assert.throws(() => getConfig({ ...base, CARRIER_MODE: 'sandbox', REDBOX_API_ENDPOINT: 'https://api.redboxsa.com' }), /production host/);
    assert.throws(() => getConfig({ ...base, CARRIER_MODE: 'sandbox', ARAMEX_API_ENDPOINT: 'https://ws.aramex.net/shippingapi.v2/shipping/service_1_0.svc/json' }), /production host/);
});

test('a non-production endpoint is accepted', () => {
    const config = getConfig({ ...base, CARRIER_MODE: 'sandbox', REDBOX_API_ENDPOINT: 'https://sandbox.example.com' });
    assert.equal(config.carriers.redbox.endpoint, 'https://sandbox.example.com');
});
test('carrier endpoints have no production default', () => {
    const config = getConfig(base);
    assert.equal(config.carriers.redbox.endpoint, null);
    assert.equal(config.carriers.aramex.endpoint, null);
});