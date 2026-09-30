const test = require('node:test');
const assert = require('node:assert/strict');
const { getConfig } = require('../src/config');
const { buildCarriers } = require('../src/carriers/factory');

const base = { SHOPIFY_STORE_DOMAIN: 'dev.myshopify.com', SHOPIFY_ADMIN_ACCESS_TOKEN: 't', SHOPIFY_WEBHOOK_SECRET: 's' };
const quiet = { log() { }, warn() { } };

test('dry-run carriers need no credentials and never touch the network', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = () => { called = true; };
    try {
        const carriers = buildCarriers(getConfig(base), { logger: quiet });
        const result = await carriers.redbox.createReturnShipment({ returnId: 'r1' }, { idempotencyKey: 'rfo:1' });
        assert.equal(result.dryRun, true);
        assert.equal(called, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('sandbox mode without credentials disables carriers instead of crashing', () => {
    const carriers = buildCarriers(getConfig({ ...base, CARRIER_MODE: 'sandbox' }), { logger: quiet });
    assert.deepEqual(Object.keys(carriers), []);
});