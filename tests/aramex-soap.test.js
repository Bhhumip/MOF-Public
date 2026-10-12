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
