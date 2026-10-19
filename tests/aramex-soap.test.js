const test = require('node:test');
const assert = require('node:assert/strict');

const {
    SOAP_ACTIONS,
    escapeXml,
    buildSoapEnvelope,
    getSoapFaultMessage,
    createAramexSoapTransport
} = require('../src/carriers/aramex-soap');

test('XML escaping handles reserved characters', () => {
    // Verifies that XML-reserved characters are encoded safely in shipment values.
    assert.equal(
        escapeXml(`A & B < C > D "quoted" 'value'`),
        'A &amp; B &lt; C &gt; D &quot;quoted&quot; &apos;value&apos;'
    );
});

test('SOAP envelope uses the Aramex namespace and preserves payload order', () => {
    // Verifies that the request wrapper uses the Aramex namespace and serializes fields in insertion order.
    const xml = buildSoapEnvelope('ShipmentCreationRequest', {
        ClientInfo: { UserName: 'test-user' },
        Transaction: { Reference1: 'return-123' }
    });

    assert.match(xml, /<soap:Envelope/);
    assert.match(xml, /xmlns="http:\/\/ws\.aramex\.net\/ShippingAPI\/v1\/"/);
    assert.ok(xml.indexOf('<ClientInfo>') < xml.indexOf('<Transaction>'));
    assert.match(xml, /<UserName>test-user<\/UserName>/);
    assert.match(xml, /<Reference1>return-123<\/Reference1>/);
});

test('SOAP transport posts XML to the service endpoint', async () => {
    // Verifies that the transport posts XML to the service URL with the expected CreateShipments SOAPAction.
    let captured;

    const transport = createAramexSoapTransport({
        endpoint: 'https://example.invalid/Service_1_0.svc',
        fetchImpl: async (url, options) => {
            captured = { url, ...options };

            return {
                ok: true,
                status: 200,
                async text() {
                    return '<soap:Envelope></soap:Envelope>';
                }
            };
        }
    });

    await transport.call('CreateShipments', 'ShipmentCreationRequest', {
        ClientInfo: { UserName: 'test-user' }
    });

    assert.equal(captured.url, 'https://example.invalid/Service_1_0.svc');
    assert.match(captured.headers['Content-Type'], /text\/xml/i);
    assert.equal(
        captured.headers.SOAPAction,
        `"${SOAP_ACTIONS.CreateShipments}"`
    );
    assert.match(captured.body, /<ShipmentCreationRequest/);
});

test('SOAP transport reports SOAP faults', async () => {
    // Verifies that a SOAP fault in an HTTP 200 response is surfaced as an error.
    const transport = createAramexSoapTransport({
        endpoint: 'https://example.invalid/Service_1_0.svc',
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            async text() {
                return '<soap:Envelope><soap:Body><soap:Fault><faultstring>Invalid credentials</faultstring></soap:Fault></soap:Body></soap:Envelope>';
            }
        })
    });

    await assert.rejects(
        () => transport.call('CreateShipments', 'ShipmentCreationRequest', {}),
        /Invalid credentials/
    );
});

test('SOAP fault parser returns null when there is no fault', () => {
    // Verifies that a normal SOAP response is not incorrectly classified as a SOAP fault.
    assert.equal(
        getSoapFaultMessage('<soap:Envelope><soap:Body/></soap:Envelope>'),
        null
    );
});

test('SOAP transport: a fault inside an HTTP 500 reports the fault reason, not just the status', async () => {
    const transport = createAramexSoapTransport({
        endpoint: 'https://example.invalid/Service_1_0.svc',
        fetchImpl: async () => ({
            ok: false,
            status: 500,
            async text() {
                return '<s:Envelope><s:Body><s:Fault><faultstring>Bad request XML</faultstring></s:Fault></s:Body></s:Envelope>';
            }
        })
    });

    await assert.rejects(
        () => transport.call('CreateShipments', 'ShipmentCreationRequest', {}),
        (error) => /Bad request XML/.test(error.message) && error.code === 'soap_fault' && error.outcomeUnknown === false
    );
});

test('SOAP transport: HTTP 5xx without a fault leaves the outcome unknown', async () => {
    const transport = createAramexSoapTransport({
        endpoint: 'https://example.invalid/Service_1_0.svc',
        fetchImpl: async () => ({ ok: false, status: 503, async text() { return 'Service Unavailable'; } })
    });

    await assert.rejects(
        () => transport.call('CreateShipments', 'ShipmentCreationRequest', {}),
        (error) => error.code === 'http_error' && error.status === 503 && error.outcomeUnknown === true
    );
});

test('SOAP transport: HTTP 4xx is a clean failure', async () => {
    const transport = createAramexSoapTransport({
        endpoint: 'https://example.invalid/Service_1_0.svc',
        fetchImpl: async () => ({ ok: false, status: 404, async text() { return 'Not found'; } })
    });

    await assert.rejects(
        () => transport.call('CreateShipments', 'ShipmentCreationRequest', {}),
        (error) => error.status === 404 && error.outcomeUnknown === false
    );
});

test('SOAP transport: a timeout is flagged outcomeUnknown', async () => {
    const transport = createAramexSoapTransport({
        endpoint: 'https://example.invalid/Service_1_0.svc',
        timeoutMs: 5,
        // Like real fetch: never answers, rejects with AbortError when the signal fires.
        fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })
    });

    await assert.rejects(
        () => transport.call('CreateShipments', 'ShipmentCreationRequest', {}),
        (error) => error.code === 'timeout' && error.outcomeUnknown === true && /timed out/.test(error.message)
    );
});

test('SOAP transport: a dropped connection is flagged outcomeUnknown', async () => {
    const transport = createAramexSoapTransport({
        endpoint: 'https://example.invalid/Service_1_0.svc',
        fetchImpl: async () => { throw new TypeError('fetch failed'); }
    });

    await assert.rejects(
        () => transport.call('CreateShipments', 'ShipmentCreationRequest', {}),
        (error) => error.code === 'network_error' && error.outcomeUnknown === true
    );
});