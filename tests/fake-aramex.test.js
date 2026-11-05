'use strict';

// Runs the REAL Aramex client and the REAL tracking poller against scripts/fake-aramex.js.
// It proves the fake speaks the SOAP the app expects, and exercises the whole Aramex side of
// the flow (booking, pickup, scans, Return-Received) without any network or Aramex account.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAramexClient } = require('../src/carriers/aramex');
const { createMemoryJobStore } = require('../src/jobs');
const { createTrackingSync } = require('../src/tracking-sync');
const { createFakeAramex } = require('../scripts/fake-aramex');

const quiet = { log() { }, error() { }, warn() { }, info() { } };

async function start(t) {
    const fake = createFakeAramex({ logger: quiet });
    const port = await fake.listen(0, '127.0.0.1');
    t.after(() => fake.close());
    const base = `http://127.0.0.1:${port}/ShippingAPI.V2`;
    const client = createAramexClient({
        endpoint: `${base}/Shipping/Service_1_0.svc`,
        trackingEndpoint: `${base}/Tracking/Service_1_0.svc`,
        username: 'tester@example.com',
        password: 'secret',
        accountNumber: '6004826',
        accountPin: '123456',
        accountEntity: 'JED',
        accountCountryCode: 'SA',
        warehouseEmail: 'returns@example.com',
        paymentType: 'C', // collect on the warehouse account, as in the real setup
        paymentOptions: 'ARCC',
        statusMap: { SH014: 'created', SH005: 'returned' }, // what the server's ARAMEX_STATUS_MAP pins
        retries: 0
    });
    return { fake, client, port };
}

function returnShipment({ customerCity = 'Jeddah', warehouseCity = 'Jeddah', rfo = '1001' } = {}) {
    return {
        returnId: `gid://shopify/Return/${rfo}`,
        reverseFulfillmentOrderId: `gid://shopify/ReverseFulfillmentOrder/${rfo}`,
        orderName: '#1001',
        customer: {
            name: 'Test Customer', company: '', phone: '+966500000001', email: 'customer@example.com',
            address: { line1: '1 King Fahd Rd', line2: '', city: customerCity, state: '', postCode: '21589', countryCode: 'SA' }
        },
        warehouse: {
            name: 'Returns Warehouse', phone: '+966500000002',
            address: { line1: 'As Sarawat District', line2: '', city: warehouseCity, state: '', postCode: '21442', countryCode: 'SA' }
        },
        items: [{ sku: 'SKU-1', name: 'Scrub top', quantity: 1 }],
        weight: { value: 1, unit: 'KG' }
    };
}

test('booking returns an AWB and a label link, and a repeat of the same return is refused', async (t) => {
    const { client } = await start(t);
    const booking = await client.createReturnShipment(returnShipment());
    assert.match(booking.trackingNumber, /^99\d{9}$/);
    assert.match(booking.label.url, /\/labels\/99\d{9}\.pdf$/);
    assert.equal(booking.trackingUrl, null);

    await assert.rejects(client.createReturnShipment(returnShipment()), (error) => error.hasNotification('ERR30'));
});

test('a pickup is created once, and asking again answers ERR50 with the pickup id', async (t) => {
    const { client } = await start(t);
    const shipment = returnShipment();
    const booking = await client.createReturnShipment(shipment);

    const pickup = await client.createPickup(shipment, { awb: booking.trackingNumber });
    assert.match(pickup.pickupId, /^K\d{6}$/);

    await assert.rejects(client.createPickup(shipment, { awb: booking.trackingNumber }), (error) => {
        assert.ok(error.hasNotification('ERR50'));
        assert.ok(error.message.includes(pickup.pickupId));
        return true;
    });
});

test('a warehouse in another entity than the account gives ERR48, like the real test system', async (t) => {
    const { client } = await start(t);
    await assert.rejects(
        client.createReturnShipment(returnShipment({ warehouseCity: 'Riyadh' })),
        (error) => error.hasNotification('ERR48') && /\(RUH\)/.test(error.message)
    );
});

test('KNOWN LIMITATION: a customer outside the account entity books fine but the pickup is refused (ERR40)', async (t) => {
    // Mirrors the real behaviour found on the Aramex test system. The app sends its own account
    // entity as the pickup OriginEntity, so this will fail until the pickup uses the shipment's origin.
    const { client } = await start(t);
    const shipment = returnShipment({ customerCity: 'Riyadh' });
    const booking = await client.createReturnShipment(shipment);
    await assert.rejects(client.createPickup(shipment, { awb: booking.trackingNumber }), (error) => error.hasNotification('ERR40'));
});

test('a login problem is reported as ERR75 on every service', async (t) => {
    const { fake, client } = await start(t);
    fake.mode.bookingError = 'login';
    await assert.rejects(client.createReturnShipment(returnShipment()), (error) => error.hasNotification('ERR75'));
});

test('a slow pickup is still created: the app times out, then ERR50 proves it exists', async (t) => {
    const { fake, port } = await start(t);
    fake.mode.pickupDelayMs = 400;
    const base = `http://127.0.0.1:${port}/ShippingAPI.V2`;
    const slowClient = createAramexClient({
        endpoint: `${base}/Shipping/Service_1_0.svc`, trackingEndpoint: `${base}/Tracking/Service_1_0.svc`,
        username: 'u', password: 'p', accountNumber: '6004826', accountPin: '1', accountEntity: 'JED', accountCountryCode: 'SA',
        warehouseEmail: 'returns@example.com', paymentType: 'C', paymentOptions: 'ARCC', timeoutMs: 100, retries: 0
    });
    const shipment = returnShipment();
    const booking = await slowClient.createReturnShipment(shipment);

    await assert.rejects(slowClient.createPickup(shipment, { awb: booking.trackingNumber }), (error) => {
        assert.equal(error.outcomeUnknown, true);
        assert.equal(error.code, 'timeout');
        return true;
    });
    fake.mode.pickupDelayMs = 0;
    await assert.rejects(slowClient.createPickup(shipment, { awb: booking.trackingNumber }), (error) => error.hasNotification('ERR50'));
});

test('the poller follows a shipment through every scan up to Return-Received', async (t) => {
    const { fake, client } = await start(t);
    const jobStore = createMemoryJobStore();
    const synced = [];
    const statusSync = { async recordEvent(job, event) { synced.push(event.event); return { synced: true }; } };
    const sync = createTrackingSync({ jobStore, carrier: client, statusSync, logger: quiet });

    const booking = await client.createReturnShipment(returnShipment());
    const key = 'rfo:gid://shopify/ReverseFulfillmentOrder/1001';
    await jobStore.claim(key, { carrier: 'aramex' });
    await jobStore.update(key, { status: 'booked', trackingNumber: booking.trackingNumber });

    assert.deepEqual(await sync.runOnce(), { checked: 1, changed: 1, unknown: 0, errors: 0 });
    assert.equal((await jobStore.get(key)).carrierStatus, 'created');
    assert.deepEqual(await sync.runOnce(), { checked: 1, changed: 0, unknown: 0, errors: 0 }); // nothing new

    // The invented FK00x codes are not pinned, so these go through the description heuristics.
    for (const expected of ['picked_up', 'in_transit', 'out_for_delivery']) {
        fake.advance(booking.trackingNumber);
        await sync.runOnce();
        assert.equal((await jobStore.get(key)).carrierStatus, expected);
    }

    fake.advance(booking.trackingNumber); // delivered = the return reached the warehouse
    await sync.runOnce();
    const done = await jobStore.get(key);
    assert.equal(done.carrierStatus, 'returned');
    assert.equal(done.carrierStatusRaw, 'SH005');
    assert.equal(done.needsAttention, 'returned');
    assert.equal(done.awaitingInspection, true);
    assert.deepEqual(synced, ['created', 'picked_up', 'in_transit', 'out_for_delivery', 'returned']);

    // A finished shipment is not asked about again.
    assert.deepEqual(await sync.runOnce(), { checked: 0, changed: 0, unknown: 0, errors: 0 });
});

test('an exception scan asks for a person, and a shipment cannot go past its last step', async (t) => {
    const { fake, client } = await start(t);
    const jobStore = createMemoryJobStore();
    const sync = createTrackingSync({ jobStore, carrier: client, logger: quiet });
    const booking = await client.createReturnShipment(returnShipment({ rfo: '2002' }));
    const key = 'rfo:gid://shopify/ReverseFulfillmentOrder/2002';
    await jobStore.claim(key, { carrier: 'aramex' });
    await jobStore.update(key, { status: 'booked', trackingNumber: booking.trackingNumber });

    fake.advance(booking.trackingNumber, 'exception');
    await sync.runOnce();
    const job = await jobStore.get(key);
    assert.equal(job.carrierStatus, 'exception');
    assert.equal(job.needsAttention, 'exception');

    assert.equal(fake.advance(booking.trackingNumber, 'nonsense').ok, false);
});