const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createHmac } = require('node:crypto');
const { createMemoryJobStore } = require('../src/jobs');
const {
    createRedboxWebhookHandler, verifyBearerToken, verifySharedSecret, verifyHmacSha256
} = require('../src/carriers/redbox-webhook');

const quiet = () => {
    const lines = { log: [], warn: [], error: [] };
    return { lines, log: (...a) => lines.log.push(a.join(' ')), warn: (...a) => lines.warn.push(a.join(' ')), error: (...a) => lines.error.push(a.join(' ')) };
};

function fakeRequest(body, { method = 'POST', headers = {} } = {}) {
    const raw = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const stream = Readable.from([Buffer.from(raw)]);
    stream.method = method;
    stream.headers = headers;
    return stream;
}
function fakeResponse() {
    return { status: null, body: '', writeHead(s) { this.status = s; }, end(c) { if (c) this.body += c; } };
}

const SECRET = 's3cret';
const auth = { authorization: `Bearer ${SECRET}` };

// The documented shipment.status.update payload
const evt = (overrides = {}) => ({
    shipment_id: '5d3e8a3f6e5741666b9d689e',
    tracking_number: '00000025',
    status_name: 'In Transit',
    status_label: 'In transit to warehouse',
    status_code: 'In Transit',
    date: '2026-10-12T10:00:00.000Z',
    customer_message: '',
    ...overrides
});

async function setup({ onEvent, findJob } = {}) {
    const jobStore = createMemoryJobStore();
    await jobStore.claim('rfo:5', { returnId: 'r1' });
    await jobStore.update('rfo:5', { status: 'booked', carrier: 'redbox', trackingNumber: '00000025', shipmentId: '5d3e8a3f6e5741666b9d689e' });
    const logger = quiet();
    const handle = createRedboxWebhookHandler({ verify: verifyBearerToken({ secret: SECRET }), jobStore, onEvent, findJob, logger });
    return { jobStore, handle, logger };
}
async function post(handle, body, headers = auth) {
    const response = fakeResponse();
    await handle(fakeRequest(body, { headers }), response);
    return response;
}
const eventRows = async (jobStore) => (await jobStore.list()).filter((j) => j.key.startsWith('redbox-event:'));

// ---------- authentication ----------

test('rejects a delivery without the registered Bearer token', async () => {
    const { handle, jobStore } = await setup();
    assert.equal((await post(handle, evt(), {})).status, 401);
    assert.equal((await post(handle, evt(), { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await post(handle, evt(), { authorization: SECRET })).status, 401); // missing "Bearer "
    assert.equal((await eventRows(jobStore)).length, 0);
});

test('verifyBearerToken refuses everything when no secret is configured', () => {
    assert.equal(verifyBearerToken({ secret: null })({ headers: { authorization: 'Bearer null' } }), false);
    assert.equal(verifyBearerToken({ secret: '' })({ headers: { authorization: 'Bearer ' } }), false);
});

test('only POST is accepted; non-JSON and oversized bodies are rejected', async () => {
    const { handle } = await setup();
    const get = fakeResponse();
    await handle(fakeRequest('', { method: 'GET', headers: auth }), get);
    assert.equal(get.status, 405);
    assert.equal((await post(handle, 'not json')).status, 400);
    assert.equal((await post(handle, 'x'.repeat(1024 * 1024 + 10))).status, 413);
});

// ---------- matching ----------

test('a RedBox event for a return job is persisted, acknowledged and recorded on the job', async () => {
    const seen = [];
    const { handle, jobStore } = await setup({ onEvent: async (event, job) => seen.push([event.event, job.key]) });

    const response = await post(handle, evt());

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { received: true, matched: true, duplicate: false });

    const job = await jobStore.get('rfo:5');
    assert.equal(job.carrierStatus, 'in_transit');
    assert.equal(job.carrierRawStatus, 'in transit');
    assert.equal(job.status, 'booked'); // orchestrator lifecycle untouched
    assert.deepEqual(seen, [['in_transit', 'rfo:5']]);

    const [row] = await eventRows(jobStore);
    assert.equal(row.status, 'applied');
    assert.equal(row.jobKey, 'rfo:5');
});

test('events for non-return shipments (e.g. outbound orders) are acknowledged and ignored, not stored', async () => {
    let calls = 0;
    const { handle, jobStore, logger } = await setup({ onEvent: async () => { calls += 1; } });

    const response = await post(handle, evt({ tracking_number: 'OUTBOUND-1', shipment_id: 'out-1' }));

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { received: true, matched: false });
    assert.equal((await eventRows(jobStore)).length, 0);
    assert.equal(calls, 0);
    assert.equal(logger.lines.warn.length, 0); // normal traffic, not a warning
});

test('a job is also found by shipment_id when the tracking number does not match', async () => {
    const { handle, jobStore } = await setup();
    await post(handle, evt({ tracking_number: 'DIFFERENT' }));
    assert.equal((await jobStore.get('rfo:5')).carrierStatus, 'in_transit');
});

test('only redbox jobs created by the orchestrator are matched (not event rows or other carriers)', async () => {
    const { handle, jobStore } = await setup();
    await jobStore.claim('rfo:6', {});
    await jobStore.update('rfo:6', { carrier: 'aramex', trackingNumber: 'AR-1' });
    const response = await post(handle, evt({ tracking_number: 'AR-1', shipment_id: 'zzz' }));
    assert.equal(JSON.parse(response.body).matched, false);
});

// ---------- duplicates and ordering ----------

test('a redelivered event is acknowledged but applied only once', async () => {
    let calls = 0;
    const { handle } = await setup({ onEvent: async () => { calls += 1; } });
    const first = await post(handle, evt({ status_code: 'Delivered' }));
    const second = await post(handle, evt({ status_code: 'Delivered' }));
    assert.equal(JSON.parse(first.body).duplicate, false);
    assert.equal(JSON.parse(second.body).duplicate, true);
    assert.equal(calls, 1);
});

test('different statuses for the same shipment are different events', async () => {
    let calls = 0;
    const { handle } = await setup({ onEvent: async () => { calls += 1; } });
    await post(handle, evt({ status_code: 'Picked Up', date: '2026-10-12T09:00:00Z' }));
    await post(handle, evt({ status_code: 'In Transit', date: '2026-10-12T10:00:00Z' }));
    assert.equal(calls, 2);
});

test('an older event does not overwrite a newer carrier status', async () => {
    const { handle, jobStore } = await setup();
    await post(handle, evt({ status_code: 'Delivered', date: '2026-10-12T12:00:00Z' }));
    await post(handle, evt({ status_code: 'In Transit', date: '2026-10-12T09:00:00Z' }));
    assert.equal((await jobStore.get('rfo:5')).carrierStatus, 'delivered');
    const stale = (await eventRows(jobStore)).find((r) => r.event === 'in_transit');
    assert.equal(stale.status, 'stale');
});

// ---------- statuses and failure containment ----------

test('an Expired parcel is recorded as expired (ops should know)', async () => {
    const seen = [];
    const { handle, jobStore } = await setup({ onEvent: async (event) => seen.push(event.event) });
    await post(handle, evt({ status_code: 'Expired', status_name: 'Expired' }));
    assert.equal((await jobStore.get('rfo:5')).carrierStatus, 'expired');
    assert.deepEqual(seen, ['expired']);
});

test('an unmapped RedBox status is stored as unknown and raises a warning', async () => {
    const { handle, jobStore, logger } = await setup();
    await post(handle, evt({ status_code: 'locker_full', status_name: 'Locker full' }));
    const job = await jobStore.get('rfo:5');
    assert.equal(job.carrierStatus, 'unknown');
    assert.equal(job.carrierRawStatus, 'locker_full');
    assert.ok(logger.lines.warn.some((l) => /unmapped RedBox status "locker_full"/.test(l)));
});

test('a failing onEvent hook is contained: still 200, event marked failed', async () => {
    const { handle, jobStore } = await setup({ onEvent: async () => { throw new Error('ops queue down'); } });
    const response = await post(handle, evt({ status_code: 'Delivered' }));
    assert.equal(response.status, 200);
    const [row] = await eventRows(jobStore);
    assert.equal(row.status, 'failed');
    assert.match(row.error, /ops queue down/);
});

test('if the event cannot be persisted the sender gets a 500 so it can retry', async () => {
    const jobStore = { list: async () => [{ key: 'rfo:5', carrier: 'redbox', trackingNumber: '00000025' }], claim: async () => { throw new Error('db down'); } };
    const handle = createRedboxWebhookHandler({ verify: () => true, jobStore, logger: quiet() });
    assert.equal((await post(handle, evt())).status, 500);
});

test('if the job lookup itself fails the sender gets a 500 so it can retry', async () => {
    const handle = createRedboxWebhookHandler({
        verify: () => true, jobStore: {}, findJob: async () => { throw new Error('db down'); }, logger: quiet()
    });
    assert.equal((await post(handle, evt())).status, 500);
});

// ---------- helpers ----------

test('shared-secret and HMAC helpers still work for gateway setups', () => {
    assert.equal(verifySharedSecret({ secret: 'k', headerName: 'x-t' })({ headers: { 'x-t': 'k' } }), true);
    assert.equal(verifySharedSecret({ secret: 'k', headerName: 'x-t' })({ headers: {} }), false);
    const body = Buffer.from('{"a":1}');
    const good = createHmac('sha256', 'k').update(body).digest('hex');
    assert.equal(verifyHmacSha256({ secret: 'k' })({ headers: { 'x-redbox-signature': good } }, body), true);
    assert.equal(verifyHmacSha256({ secret: 'k' })({ headers: { 'x-redbox-signature': 'bad' } }, body), false);
});

test('a handler cannot be built without verification or a store', () => {
    assert.throws(() => createRedboxWebhookHandler({ jobStore: {} }), /verify/);
    assert.throws(() => createRedboxWebhookHandler({ verify: () => true }), /jobStore/);
});


test('maps RedBox return-specific statuses', async () => {
    const { handle, jobStore } = await setup();

    await post(handle, evt({
        status_code: 'R-Deposited',
        status_name: 'R-Deposited',
        date: '2026-10-14T08:00:00Z'
    }));

    assert.equal(
        (await jobStore.get('rfo:5')).carrierStatus,
        'dropped_off'
    );

    await post(handle, evt({
        status_code: 'In-Transit-R',
        status_name: 'In-Transit-R',
        date: '2026-10-14T09:00:00Z'
    }));

    assert.equal(
        (await jobStore.get('rfo:5')).carrierStatus,
        'collected_from_point'
    );
});