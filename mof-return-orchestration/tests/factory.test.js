const test = require('node:test');
const assert = require('node:assert/strict');
const { getConfig } = require('../src/config');
const { buildCarriers, createDryRunCarrier } = require('../src/carriers/factory');

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

test('the dry-run carrier logs a summary and never customer details', async () => {
    const lines = [];
    const logger = { log: (...args) => lines.push(args.join(' ')), warn() { } };
    const carrier = createDryRunCarrier('redbox', logger);

    await carrier.createReturnShipment(
        {
            returnId: 'gid://shopify/Return/1',
            reverseFulfillmentOrderId: 'gid://shopify/ReverseFulfillmentOrder/5',
            customer: {
                name: 'Sensitive Name',
                phone: '0500000000',
                email: 'secret@example.com',
                address: { line1: '99 Private Street', city: 'Riyadh' }
            },
            warehouse: { name: 'Warehouse A', address: { line1: '2 Depot Rd' } },
            items: [{ sku: 'S1', name: 'Scrub Top', quantity: 1 }]
        },
        { idempotencyKey: 'rfo:5' }
    );

    const output = lines.join('\n');
    assert.match(output, /rfo:5/);        // the useful identifiers are logged
    assert.match(output, /Warehouse A/);
    for (const secret of ['Sensitive Name', '0500000000', 'secret@example.com', '99 Private Street']) {
        assert.equal(output.includes(secret), false, `the log leaked: ${secret}`);
    }
});