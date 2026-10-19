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

    assert.throws(
        () => getConfig({
            ...base,
            CARRIER_MODE: 'sandbox',
            ARAMEX_SOAP_ENDPOINT: 'https://ws.aramex.net/shippingapi.v2/shipping/service_1_0.svc'
        }),
        /production host/
    );

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


test('defaults to SQLite job storage', () => {
    const config = getConfig(base);

    assert.equal(config.jobStore.type, 'sqlite');
    assert.equal(config.jobStore.sqlitePath, './data/jobs.sqlite');
});

test('MongoDB storage requires a connection URI', () => {
    assert.throws(
        () => getConfig({ ...base, JOB_STORE: 'mongodb' }),
        /MONGODB_URI is required/
    );
});

test('MongoDB storage accepts its configuration', () => {
    const config = getConfig({
        ...base,
        JOB_STORE: 'mongodb',
        MONGODB_URI: 'mongodb://localhost:27017',
        MONGODB_DATABASE: 'mof_test'
    });

    assert.equal(config.jobStore.type, 'mongodb');
    assert.equal(config.jobStore.mongodbUri, 'mongodb://localhost:27017');
    assert.equal(config.jobStore.mongodbDatabase, 'mof_test');
});

test('unsupported job storage types are rejected', () => {
    assert.throws(
        () => getConfig({ ...base, JOB_STORE: 'unknown' }),
        /JOB_STORE must be one of/
    );
});
test('Aramex defaults to a domestic DOM/OND shipment', () => {
    const aramex = getConfig(base).carriers.aramex;

    assert.equal(aramex.productGroup, 'DOM');
    assert.equal(aramex.productType, 'OND');
    assert.equal(aramex.dimensionsCm, null);
});

test('Aramex product, payment and parcel size come from the environment', () => {
    const aramex = getConfig({
        ...base,
        ARAMEX_PRODUCT_GROUP: 'EXP',
        ARAMEX_PRODUCT_TYPE: 'PPX',
        ARAMEX_PAYMENT_TYPE: 'C',
        ARAMEX_PAYMENT_OPTIONS: 'ARCC',
        ARAMEX_PARCEL_CM: '30x20x10'
    }).carriers.aramex;

    assert.equal(aramex.productGroup, 'EXP');
    assert.equal(aramex.paymentType, 'C');
    assert.equal(aramex.paymentOptions, 'ARCC');
    assert.deepEqual(aramex.dimensionsCm, { length: 30, width: 20, height: 10 });
});

test('a malformed ARAMEX_PARCEL_CM is rejected', () => {
    assert.throws(() => getConfig({ ...base, ARAMEX_PARCEL_CM: '10x10' }), /ARAMEX_PARCEL_CM/);
});