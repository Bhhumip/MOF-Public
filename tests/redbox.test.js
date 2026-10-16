const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createRedboxClient,
    pickOriginalTrackingNumber,
    normalizeEvent,
    RedboxApiError,
    RedboxContractError
} = require('../src/carriers/redbox');
const contract = require('../src/carriers/redbox-contract');

const quiet = { log() { }, warn() { }, error() { } };
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

function res(status, body) {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, async text() { return text; } };
}

/**
 * Routes by "METHOD /path?query". A route value may be a response, an Error, or an
 * array (replayed in order, last one repeats). Unrouted calls answer 404.
 */
function routed(routes) {
    const calls = [];
    const fn = async (url, options = {}) => {
        const path = new URL(url).pathname + new URL(url).search;
        const key = `${options.method || 'GET'} ${path}`;
        calls.push({ key, url, ...options, parsedBody: options.body ? JSON.parse(options.body) : undefined });
        let next = routes[key];
        if (Array.isArray(next)) next = next.length > 1 ? next.shift() : next[0];
        if (next === undefined) return res(404, { success: false, response_code: 404, msg: `no route ${key}` });
        if (next instanceof Error) throw next;
        return next;
    };
    fn.calls = calls;
    fn.keys = () => calls.map((c) => c.key);
    return fn;
}

function makeClient(fetchImpl, extra = {}) {
    return createRedboxClient({
        endpoint: 'https://stage.example.test', bearerToken: 'tok',
        fetchImpl, retryDelayMs: 0, logger: quiet, ...extra
    });
}

function strictClient(status) {
    const calls = [];
    const client = createRedboxClient({
        endpoint: 'https://stage.example.test', bearerToken: 't', requireOriginalShipment: true, retries: 0,
        logger: { warn() { }, log() { } },
        fetchImpl: async (url, options) => {
            calls.push(options.method);
            return { ok: false, status, text: async () => JSON.stringify({ success: false, response_code: status, msg: 'x' }) };
        }
    });
    return { client, calls };
}
const strictShipment = {
    orderName: '#1', reverseFulfillmentOrderId: 'gid://shopify/ReverseFulfillmentOrder/5',
    customer: { name: 'A', phone: '+966500000000' }, warehouse: { name: 'W' },
    originalTracking: [{ number: '111', company: 'RedBox' }]
};


const shipment = {
    returnId: 'gid://shopify/Return/1',
    reverseFulfillmentOrderId: 'gid://shopify/ReverseFulfillmentOrder/5',
    orderName: '#1090',
    customer: {
        name: 'Test Customer', phone: '0500000000', email: 'c@example.com',
        address: { line1: '1 Test St', line2: '', city: 'Riyadh', state: '', postCode: '11111', countryCode: 'SA' }
    },
    warehouse: {
        name: 'Warehouse A', phone: '0111111111',
        address: { line1: '2 Depot Rd', line2: '', city: 'Jeddah', state: '', postCode: '21000', countryCode: 'SA' }
    },
    items: [{ sku: 'S1', name: 'Scrub Top', quantity: 2 }],
    weight: { value: 1.2, unit: 'KG' }
};

const CREATED = {
    shipment_id: '5d3e8a3f6e5741666b9d689e',
    shipping_label_url: 'https://app.redboxsa.com/download/shipping-label/abc.pdf',
    success: true,
    tracking_number: '00000025'
};
const POST_RETURNS = 'POST /v3/shipments/returns';

// ---------- construction ----------

test('requires an endpoint, a token and a fetch implementation', () => {
    assert.throws(() => createRedboxClient({ bearerToken: 't' }), /endpoint/);
    assert.throws(() => createRedboxClient({ endpoint: 'https://x.test' }), /bearerToken/);
    assert.throws(
        () => createRedboxClient({ endpoint: 'https://x.test', bearerToken: 't', fetchImpl: null }), /fetch implementation/
    );
});

test('a null apiVersion (what config.js passes when unset) falls back to v3', async () => {
    const fetchImpl = routed({ 'GET /v3/shipments/42': res(200, {}) });
    await makeClient(fetchImpl, { apiVersion: null }).getShipment('42');
    assert.equal(fetchImpl.calls[0].url, 'https://stage.example.test/v3/shipments/42');
});

test('sends the bearer token and url-encodes ids', async () => {
    const fetchImpl = routed({ 'GET /v3/shipments/a%2Fb': res(200, {}) });
    await makeClient(fetchImpl).getShipment('a/b');
    assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer tok');
});

test('bearerToken may be a function (token rotation)', async () => {
    let n = 0;
    const fetchImpl = routed({ 'GET /v3/shipments/1': res(200, {}), 'GET /v3/shipments/2': res(200, {}) });
    const client = makeClient(fetchImpl, { bearerToken: async () => `tok-${++n}` });
    await client.getShipment('1');
    await client.getShipment('2');
    assert.deepEqual(fetchImpl.calls.map((c) => c.headers.Authorization), ['Bearer tok-1', 'Bearer tok-2']);
});

// ---------- retry policy ----------

test('GET retries on 5xx and then succeeds', async () => {
    const fetchImpl = routed({ 'GET /v3/shipments/7/status': [res(503, 'x'), res(502, 'x'), res(200, { status: 'Delivered' })] });
    assert.deepEqual(await makeClient(fetchImpl).getShipmentStatus('7'), { status: 'Delivered' });
    assert.equal(fetchImpl.calls.length, 3);
});

test('GET retries on 429 and on timeout', async () => {
    const fetchImpl = routed({ 'GET /v3/shipments/7': [res(429, ''), abortError(), res(200, { ok: 1 })] });
    await makeClient(fetchImpl).getShipment('7');
    assert.equal(fetchImpl.calls.length, 3);
});

test('GET does not retry a 404 and gives up after the configured retries', async () => {
    const f1 = routed({ 'GET /v3/shipments/x': res(404, { success: false, msg: 'nope' }) });
    await assert.rejects(() => makeClient(f1).getShipment('x'), (e) => e.status === 404);
    assert.equal(f1.calls.length, 1);

    const f2 = routed({ 'GET /v3/shipments/x': res(500, 'x') });
    await assert.rejects(() => makeClient(f2, { retries: 2 }).getShipment('x'), RedboxApiError);
    assert.equal(f2.calls.length, 3);
});

test('POST is never retried on 5xx', async () => {
    const fetchImpl = routed({ [POST_RETURNS]: [res(500, 'boom'), res(200, CREATED)] });
    await assert.rejects(
        () => makeClient(fetchImpl).createReturnShipment(shipment),
        (e) => e instanceof RedboxApiError && e.status === 500 && e.outcomeUnknown === false
    );
    assert.equal(fetchImpl.calls.length, 1);
});

test('a POST that gets no response is flagged outcomeUnknown and not retried', async () => {
    const fetchImpl = routed({ [POST_RETURNS]: [abortError(), res(200, CREATED)] });
    await assert.rejects(
        () => makeClient(fetchImpl).createReturnShipment(shipment),
        (e) => e.outcomeUnknown === true && e.code === 'outcome_unknown'
    );
    assert.equal(fetchImpl.calls.length, 1);
});

test('RedBox error messages are surfaced', async () => {
    const fetchImpl = routed({ [POST_RETURNS]: res(400, { success: false, response_code: 400, msg: "Bad Request: 'customer_phone' is required" }) });
    await assert.rejects(() => makeClient(fetchImpl).createReturnShipment(shipment), /customer_phone' is required/);
});

// ---------- guard ----------

test('booking is refused when the contract is flagged unconfirmed (no network call)', async () => {
    const fetchImpl = routed({ [POST_RETURNS]: res(200, CREATED) });
    const client = makeClient(fetchImpl, { contract: { ...contract, confirmed: false } });
    await assert.rejects(() => client.createReturnShipment(shipment), (e) => e.code === 'schema_unconfirmed');
    await assert.rejects(() => client.registerWebhook({}), (e) => e.code === 'schema_unconfirmed');
    assert.equal(fetchImpl.calls.length, 0);
});

test('allowUnconfirmedContract lets an unconfirmed contract through (sandbox experiments)', async () => {
    const fetchImpl = routed({ [POST_RETURNS]: res(200, CREATED), 'GET /v3/shipments/5d3e8a3f6e5741666b9d689e/tracking-page': res(200, {}) });
    const client = makeClient(fetchImpl, { contract: { ...contract, confirmed: false }, allowUnconfirmedContract: true });
    assert.equal((await client.createReturnShipment(shipment)).trackingNumber, '00000025');
});

// ---------- booking: external return ----------

test('books an external return: POST /v3/shipments/returns with the documented fields', async () => {
    const fetchImpl = routed({
        [POST_RETURNS]: res(200, CREATED),
        'GET /v3/shipments/5d3e8a3f6e5741666b9d689e/tracking-page': res(200, { original_url: 'https://app.redboxsa.com/package-tracking?n=00000025', short_url: 'https://bit.ly/x', success: true })
    });
    const booking = await makeClient(fetchImpl).createReturnShipment(shipment, { idempotencyKey: 'rfo:5' });

    const post = fetchImpl.calls[0];
    assert.equal(post.headers['Content-Type'], 'application/json');
    assert.equal(post.headers['Idempotency-Key'], undefined); // not documented by RedBox; `reference` is the guard
    assert.deepEqual(post.parsedBody, {
        reference: 'RET-1090-5',
        customer_name: 'Test Customer',
        customer_phone: '0500000000',
        customer_email: 'c@example.com',
        customer_address: '1 Test St, Riyadh, 11111',
        customer_city: 'Riyadh',
        customer_country: 'SA',
        sender_name: 'Warehouse A',
        sender_phone: '0111111111',
        sender_address: '2 Depot Rd, Jeddah, 21000',
        weight_unit: 'kg',
        weight_value: 1.2,
        items: [{ name: 'Scrub Top', sku: 'S1', quantity: 2 }]
    });

    // the shape returns.js consumes
    assert.equal(booking.trackingNumber, '00000025');
    assert.equal(booking.shipmentId, '5d3e8a3f6e5741666b9d689e');
    assert.equal(booking.trackingUrl, 'https://app.redboxsa.com/package-tracking?n=00000025');
    assert.deepEqual(booking.label, { url: CREATED.shipping_label_url, fileName: 'redbox-00000025.pdf' });
    assert.equal(booking.recovered, false);
    assert.equal(booking.dryRun, undefined);
});

test('the label comes from the create response: no extra label call', async () => {
    const fetchImpl = routed({ [POST_RETURNS]: res(200, CREATED) });
    await makeClient(fetchImpl).createReturnShipment(shipment);
    assert.ok(!fetchImpl.keys().some((k) => k.endsWith('/label')));
});

test('if the create response has no label URL, the label endpoint is tried', async () => {
    const { shipping_label_url, ...noLabel } = CREATED;
    const fetchImpl = routed({
        [POST_RETURNS]: res(200, noLabel),
        'GET /v3/shipments/5d3e8a3f6e5741666b9d689e/label': res(200, { success: true, url: 'https://app.redboxsa.com/l.pdf' })
    });
    const booking = await makeClient(fetchImpl).createReturnShipment(shipment);
    assert.equal(booking.label.url, 'https://app.redboxsa.com/l.pdf');
});

test('tracking-page failure does not fail an already-created booking', async () => {
    const fetchImpl = routed({ [POST_RETURNS]: res(200, CREATED), 'GET /v3/shipments/5d3e8a3f6e5741666b9d689e/tracking-page': res(500, 'x') });
    const booking = await makeClient(fetchImpl, { retries: 0 }).createReturnShipment(shipment);
    assert.equal(booking.trackingNumber, '00000025');
    assert.equal(booking.trackingUrl, null);
});

test('tracking url falls back to the short url', () => {
    assert.equal(contract.parseTrackingPageResponse({ short_url: 'https://bit.ly/x' }), 'https://bit.ly/x');
    assert.equal(contract.parseTrackingPageResponse({}), null);
});

// ---------- booking: internal return ----------

test('with an original RedBox shipment, only original_shipment_id + reference are sent', async () => {
    const fetchImpl = routed({
        'GET /v3/shipments/00099': res(200, { shipment: { id: 'orig-1', tracking_number: '00099', is_return: false }, success: true }),
        [POST_RETURNS]: res(200, CREATED)
    });
    await makeClient(fetchImpl).createReturnShipment({ ...shipment, originalTrackingNumber: '00099' });
    assert.deepEqual(fetchImpl.calls.find((c) => c.key === POST_RETURNS).parsedBody, {
        original_shipment_id: 'orig-1', reference: 'RET-1090-5'
    });
});

test('an unknown original tracking number falls back to an external return', async () => {
    const fetchImpl = routed({ [POST_RETURNS]: res(200, CREATED) }); // GET .../00099 -> 404
    await makeClient(fetchImpl, { retries: 0 }).createReturnShipment({ ...shipment, originalTrackingNumber: '00099' });
    const body = fetchImpl.calls.find((c) => c.key === POST_RETURNS).parsedBody;
    assert.equal(body.original_shipment_id, undefined);
    assert.equal(body.customer_name, 'Test Customer');
});

test('an explicit originalShipmentId needs no lookup', async () => {
    const fetchImpl = routed({ [POST_RETURNS]: res(200, CREATED) });
    await makeClient(fetchImpl).createReturnShipment({ ...shipment, originalShipmentId: 'orig-9' });
    assert.equal(fetchImpl.calls[0].parsedBody.original_shipment_id, 'orig-9');
    assert.ok(!fetchImpl.keys().some((k) => k.startsWith('GET /v3/shipments/orig')));
});

// ---------- duplicate protection (409) ----------

const DUP = res(409, { success: false, response_code: 409, msg: "Conflict: resource with reference 'RET-1090-5' already exists" });

test('a 409 duplicate reference reuses the existing shipment found in the list', async () => {
    const fetchImpl = routed({
        [POST_RETURNS]: DUP,
        'GET /v3/shipments?page=1&page_size=50': res(200, {
            success: true, paging: { current_page: 1, total_pages: 1 },
            shipments: [{ id: 'other', reference: 'X', tracking_number: '1' }, { id: 'sid-7', reference: 'RET-1090-5', tracking_number: 'T-7' }]
        })
    });
    const booking = await makeClient(fetchImpl).createReturnShipment(shipment);
    assert.equal(booking.recovered, true);
    assert.equal(booking.shipmentId, 'sid-7');
    assert.equal(booking.trackingNumber, 'T-7');
    assert.equal(fetchImpl.keys().filter((k) => k === POST_RETURNS).length, 1); // never re-POSTed
});

test('a 409 whose shipment cannot be found is reported, not swallowed', async () => {
    const fetchImpl = routed({
        [POST_RETURNS]: DUP,
        'GET /v3/shipments?page=1&page_size=50': res(200, { success: true, paging: { total_pages: 1 }, shipments: [] })
    });
    await assert.rejects(() => makeClient(fetchImpl).createReturnShipment(shipment), (e) => e.code === 'already_exists_unresolved');
});

test('the list scan is bounded by maxPages', async () => {
    const fetchImpl = routed({
        'GET /v3/shipments?page=1&page_size=50': res(200, { shipments: [], paging: { total_pages: 99 } }),
        'GET /v3/shipments?page=2&page_size=50': res(200, { shipments: [], paging: { total_pages: 99 } })
    });
    assert.equal(await makeClient(fetchImpl).findShipmentByReference('nope', { maxPages: 2 }), null);
    assert.equal(fetchImpl.calls.length, 2);
});

// ---------- request / response validation ----------

test('a missing customer phone is rejected BEFORE any network call', async () => {
    const noPhone = { ...shipment, customer: { ...shipment.customer, phone: '' } };
    const fetchImpl = routed({ [POST_RETURNS]: res(200, CREATED) });
    await assert.rejects(
        () => makeClient(fetchImpl).createReturnShipment(noPhone),
        (e) => e instanceof RedboxContractError && e.code === 'invalid_shipment' && e.missing.includes('customer_phone')
    );
    assert.equal(fetchImpl.calls.length, 0);
});

test('sender_* is simply omitted when the warehouse has no phone (RedBox falls back to the business)', () => {
    const body = contract.buildReturnShipmentRequest({ ...shipment, warehouse: { ...shipment.warehouse, phone: '' } });
    assert.equal('sender_phone' in body, false);
    assert.equal(body.sender_name, 'Warehouse A');
});

test('weight and items are omitted when unknown', () => {
    const body = contract.buildReturnShipmentRequest({ ...shipment, weight: null, items: [] });
    assert.equal('weight_value' in body || 'weight_unit' in body || 'items' in body, false);
});

test('reference is human-readable and unique per RFO', () => {
    assert.equal(contract.buildReference(shipment), 'RET-1090-5');
    const other = { ...shipment, reverseFulfillmentOrderId: 'gid://shopify/ReverseFulfillmentOrder/6' };
    assert.notEqual(contract.buildReference(other), contract.buildReference(shipment));
});

test('success:false in a 200 body is an error, not a booking', async () => {
    const fetchImpl = routed({ [POST_RETURNS]: res(200, { success: false, msg: 'not eligible' }) });
    await assert.rejects(
        () => makeClient(fetchImpl).createReturnShipment(shipment),
        (e) => e.code === 'carrier_reported_failure' && /not eligible/.test(e.message)
    );
});

test('a response missing shipment_id or tracking_number is never a success', async () => {
    for (const body of [{ success: true, tracking_number: '1' }, { success: true, shipment_id: 'a' }, { success: true }]) {
        const fetchImpl = routed({ [POST_RETURNS]: res(200, body) });
        await assert.rejects(() => makeClient(fetchImpl).createReturnShipment(shipment), (e) => e.code === 'unrecognized_response');
    }
});

// ---------- other endpoints ----------

test('cancelShipment POSTs to /cancel (only allowed before deposit)', async () => {
    const fetchImpl = routed({ 'POST /v3/shipments/00000025/cancel': res(200, { success: true }) });
    assert.deepEqual(await makeClient(fetchImpl).cancelShipment('00000025'), { success: true });
});

test('webhook registration sends the documented body with our auth header', async () => {
    const fetchImpl = routed({ 'POST /v3/webhooks': res(200, { success: true, webhook_id: 'w1' }) });
    await makeClient(fetchImpl).registerWebhook({
        event: 'shipment.status.update', targetUrl: 'https://mw.example.test/webhooks/redbox',
        subscriber: 'Medical Outfit', originalId: 'mof-returns-status', secret: 's3cret'
    });
    assert.deepEqual(fetchImpl.calls[0].parsedBody, {
        event: 'shipment.status.update',
        headers: { Authorization: 'Bearer s3cret', 'Content-Type': 'application/json' },
        original_id: 'mof-returns-status',
        subscriber: 'Medical Outfit',
        target_url: 'https://mw.example.test/webhooks/redbox'
    });
});

test('deleteWebhook uses DELETE /webhooks/{original_id}', async () => {
    const fetchImpl = routed({ 'DELETE /v3/webhooks/mof-returns-status': res(200, { success: true }) });
    await makeClient(fetchImpl).deleteWebhook('mof-returns-status');
    assert.equal(fetchImpl.calls[0].method, 'DELETE');
});

// ---------- event normalisation ----------

test('normalizeEvent reads RedBox status_code and maps known statuses', () => {
    assert.equal(normalizeEvent({ status_code: 'Delivered' }).event, 'delivered');
    assert.equal(normalizeEvent({ status_code: 'Expired' }).event, 'expired');
    assert.equal(normalizeEvent({ status: 'In Transit' }).event, 'in_transit');
    assert.equal(normalizeEvent({ status_name: 'Picked Up', tracking_number: 'T1', date: '2026-10-12T10:00:00Z' }).event, 'picked_up');
    assert.equal(normalizeEvent({ status_code: 'Delivered', tracking_number: 'T1' }).trackingNumber, 'T1');
});

test('unmapped statuses become unknown with the raw value preserved', () => {
    const e = normalizeEvent({ status_code: 'LOCKER_FULL' });
    assert.equal(e.event, 'unknown');
    assert.equal(e.rawStatus, 'locker_full');
    assert.equal(normalizeEvent({}).event, 'unknown');
});

test('documented RedBox statuses map as intended; undefined ones stay unknown', () => {

    const expected = {
        Processing: 'created', 'In-Transit': 'in_transit', Deposited: 'deposited',
        Delivered: 'delivered', Returned: 'returned', Expired: 'expired', Canceled: 'cancelled'
    };
    for (const [status, event] of Object.entries(expected)) {
        assert.equal(normalizeEvent({ status_code: status }).event, event, status);
    }
    const nowMapped = { 'R-Deposited': 'dropped_off', 'In-transit-r': 'collected_from_point', 'In-transit-ex': 'returning_to_origin', 'Not-Delivered': 'returned_to_origin', NotDeposited: 'exception', 'Not-Deposited': 'exception' };
    for (const [status, event] of Object.entries(nowMapped)) {
        assert.equal(normalizeEvent({ status_name: status }).event, event, status);
    }
    assert.equal(normalizeEvent({ status_name: 'Locker full' }).event, 'unknown');
});

test('phone numbers are sent without spaces or punctuation', () => {
    const { buildReturnShipmentRequest } = require('../src/carriers/redbox-contract');
    const body = buildReturnShipmentRequest({
        orderName: '#1', reverseFulfillmentOrderId: 'gid://shopify/ReverseFulfillmentOrder/5',
        customer: { name: 'A', phone: '+966 54 666-9163' },
        warehouse: { name: 'W', phone: '(011) 123 4567' }
    });
    assert.equal(body.customer_phone, '+966546669163');
    assert.equal(body.sender_phone, '0111234567');
});


test('tracking page: the real sandbox field names are understood', () => {
    const { parseTrackingPageResponse } = require('../src/carriers/redbox-contract');
    assert.equal(
        parseTrackingPageResponse({ url_bitly: 'https://rdbx.me/x', url_original: 'https://stage.redboxsa.com/package-tracking/abc' }),
        'https://stage.redboxsa.com/package-tracking/abc'
    );
    assert.equal(parseTrackingPageResponse({ url_bitly: 'https://rdbx.me/x' }), 'https://rdbx.me/x');
    assert.equal(parseTrackingPageResponse({ original_url: 'https://a.example/1' }), 'https://a.example/1');
});

test('the real sandbox status R-Waiting maps to created even when status_code is numeric', () => {

    assert.equal(normalizeEvent({ status_name: 'R-Waiting', status_code: 202 }).event, 'created');
});

test('status selection: textual code first, then name, numeric code last', () => {
    const { pickStatus } = require('../src/carriers/redbox-contract');
    assert.equal(pickStatus({ status_code: 'Delivered', status_name: 'x' }), 'Delivered');
    assert.equal(pickStatus({ status_code: 202, status_name: 'R-Waiting' }), 'R-Waiting');
    assert.equal(pickStatus({ status_code: '202', status_name: 'R-Waiting' }), 'R-Waiting');
    assert.equal(pickStatus({ status_code: 202 }), 202);
    assert.equal(pickStatus({}), null);
});

test('strict mode: an unknown original shipment is refused and nothing is POSTed', async () => {
    const { client, calls } = strictClient(404);
    await assert.rejects(() => client.createReturnShipment(strictShipment), (e) => e.code === 'original_shipment_not_found');
    assert.equal(calls.every((method) => method === 'GET'), true);
});

test('strict mode: a RedBox outage during lookup is not mistaken for "not found"', async () => {
    const { client } = strictClient(500);
    await assert.rejects(() => client.createReturnShipment(strictShipment), (e) => e.status === 500);
});

test('two different outbound tracking numbers are ambiguous', () => {
    assert.equal(pickOriginalTrackingNumber([{ number: '1', company: 'RedBox' }, { number: '1', company: 'RedBox' }]), '1');
    assert.equal(pickOriginalTrackingNumber([{ number: '1', company: 'Other' }, { number: '2', company: 'RedBox' }]), '2');
    assert.equal(pickOriginalTrackingNumber([]), null);
    assert.throws(
        () => pickOriginalTrackingNumber([{ number: '1', company: 'RedBox' }, { number: '2', company: 'RedBox' }]),
        (e) => e.code === 'multiple_original_shipments'
    );
});

test('RedBox refusing an internal return is a review case, not a generic failure', async () => {
    const fetchImpl = routed({
        'GET /v3/shipments/00099': res(200, { shipment: { id: 'orig-1', tracking_number: '00099', is_return: false }, success: true }),
        [POST_RETURNS]: res(404, { success: false, msg: 'Not Found: Shipment not exist' })
    });
    await assert.rejects(
        () => makeClient(fetchImpl).createReturnShipment({ ...shipment, originalTrackingNumber: '00099' }),
        (e) => e.code === 'original_shipment_rejected'
    );
});