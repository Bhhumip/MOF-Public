const test = require('node:test');
const assert = require('node:assert/strict');
const { createAramexClient } = require('../src/carriers/aramex');

function createMockResponse({ status = 200, body = '' } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return body;
        }
    };
}

function createTestAramexClient(fetchImpl) {
    return createAramexClient({
        endpoint: 'https://example.invalid/Shipping/Service_1_0.svc',
        username: 'test-user',
        password: 'test-password',
        accountNumber: '123456',
        accountPin: '123456',
        accountEntity: 'DXB',
        accountCountryCode: 'AE',
        fetchImpl,
        retries: 0
    });
}

// Shared shipment input used by response-validation tests.
const testShipment = {
    returnId: 'return-test',
    customer: {
        name: 'Test Customer',
        city: 'Dubai',
        countryCode: 'AE'
    },
    warehouse: {
        name: 'Returns Warehouse',
        city: 'Dubai',
        countryCode: 'AE'
    },
    items: [],
    weight: 1
};

test('Aramex CreateShipments sends a SOAP XML request', async () => {
    // Verifies that shipment creation sends XML with a SOAP envelope instead of a JSON request.
    let capturedRequest;

    const client = createTestAramexClient(async (url, options) => {
        capturedRequest = { url, ...options };

        return createMockResponse({
            body: `
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
            <soap:Body>
                <ShipmentCreationResponse xmlns="http://ws.aramex.net/ShippingAPI/v1/">
                    <HasErrors>false</HasErrors>
                    <Shipments>
                       <ProcessedShipment>
                        <HasErrors>false</HasErrors>
                        <ID>TEST-AWB-123</ID>
                    </ProcessedShipment>
                    </Shipments>
                </ShipmentCreationResponse>
            </soap:Body>
        </soap:Envelope>
    `
        });
    });

    await client.createReturnShipment({
        returnId: 'return-123',
        customer: {
            name: 'Test Customer',
            city: 'Dubai',
            countryCode: 'AE'
        },
        warehouse: {
            name: 'Returns Warehouse',
            city: 'Dubai',
            countryCode: 'AE'
        },
        items: [],
        weight: 1
    });

    assert.match(capturedRequest.url, /Service_1_0\.svc\/?$/i);
    assert.match(
        capturedRequest.headers['Content-Type'],
        /xml/i
    );
    assert.match(capturedRequest.body, /Envelope/i);
    assert.match(capturedRequest.body, /ShipmentCreationRequest/i);
    assert.match(capturedRequest.headers.SOAPAction, /CreateShipments/);
    assert.match(capturedRequest.body, /test-user/);
    assert.match(capturedRequest.body, /test-password/);
    assert.match(capturedRequest.body, /return-123/);
});

test('Aramex CreateShipments escapes special characters in XML values', async () => {
    // Verifies that special XML characters in shipment data are escaped rather than breaking the SOAP document.
    let capturedBody;

    const client = createTestAramexClient(async (_url, options) => {
        capturedBody = options.body;

        return createMockResponse({
            body: `
                <soap:Envelope>
                    <soap:Body>
                        <ShipmentCreationResponse>
                            <HasErrors>false</HasErrors>
                            <Shipments>
                                <ProcessedShipment>
                                    <HasErrors>false</HasErrors>
                                    <ID>TEST-AWB-123</ID>
                                </ProcessedShipment>
                            </Shipments>
                        </ShipmentCreationResponse>
                    </soap:Body>
                </soap:Envelope>
`
        });
    });

    await client.createReturnShipment({
        returnId: 'return-&-123',
        customer: {
            name: 'Customer & Sons',
            city: 'Dubai',
            countryCode: 'AE'
        },
        warehouse: {
            name: 'Returns Warehouse',
            city: 'Dubai',
            countryCode: 'AE'
        }
    });

    assert.match(capturedBody, /return-&amp;-123/);
    assert.match(capturedBody, /Customer &amp; Sons/);
});



test('Aramex rejects a shipment response with HasErrors=true', async () => {
    // Verifies that an application-level failure is rejected even when the HTTP status is 200.
    const client = createTestAramexClient(async () =>
        createMockResponse({
            body: `
                <soap:Envelope>
                    <soap:Body>
                        <ShipmentCreationResponse>
                            <HasErrors>true</HasErrors>
                        </ShipmentCreationResponse>
                    </soap:Body>
                </soap:Envelope>
            `
        })
    );

    await assert.rejects(
        () => client.createReturnShipment({ returnId: 'return-error' }),
        /incomplete or unsuccessful shipment response/
    );
});

test('Aramex rejects an HTTP error response', async () => {
    // Verifies that a non-success HTTP status becomes an Aramex API error.
    const client = createTestAramexClient(async () =>
        createMockResponse({
            status: 500,
            body: 'Internal Server Error'
        })
    );

    await assert.rejects(
        () => client.createReturnShipment({ returnId: 'return-http-error' }),
        /HTTP 500/
    );
});

test('Aramex extracts the tracking number from a successful SOAP response', async () => {
    // Verifies that the adapter extracts the shipment ID from the processed shipment response.
    const client = createTestAramexClient(async () =>
        createMockResponse({
            body: `
                <soap:Envelope>
                    <soap:Body>
                        <ShipmentCreationResponse>
                            <HasErrors>false</HasErrors>
                            <Shipments>
                               <ProcessedShipment>
                                    <HasErrors>false</HasErrors>
                                    <ID>TEST-AWB-123</ID>
                                </ProcessedShipment>
                            </Shipments>
                        </ShipmentCreationResponse>
                    </soap:Body>
                </soap:Envelope>
            `
        })
    );

    const result = await client.createReturnShipment({
        returnId: 'return-success'
    });

    assert.equal(result.HasErrors, false);
    assert.equal(result.trackingNumber, 'TEST-AWB-123');
});




// Verifies that a response missing HasErrors is rejected rather than treated as success.
test('Aramex rejects a response with missing HasErrors', async () => {
    const client = createTestAramexClient(() =>
        createMockResponse({
            body: `
                <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
                    <soap:Body>
                        <ShipmentCreationResponse xmlns="http://ws.aramex.net/ShippingAPI/v1/">
                            <Shipments>
                                <ProcessedShipment>
                                    <HasErrors>false</HasErrors>
                                    <ID>TEST-AWB-123</ID>
                                </ProcessedShipment>
                            </Shipments>
                        </ShipmentCreationResponse>
                    </soap:Body>
                </soap:Envelope>
            `
        })
    );

    await assert.rejects(
        client.createReturnShipment(testShipment),
        /incomplete or unsuccessful shipment response/
    );
});

// Verifies that a response without a processed shipment is rejected.
test('Aramex rejects a response without ProcessedShipment', async () => {
    const client = createTestAramexClient(() =>
        createMockResponse({
            body: `
                <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
                    <soap:Body>
                        <ShipmentCreationResponse xmlns="http://ws.aramex.net/ShippingAPI/v1/">
                            <HasErrors>false</HasErrors>
                            <Shipments/>
                        </ShipmentCreationResponse>
                    </soap:Body>
                </soap:Envelope>
            `
        })
    );

    await assert.rejects(
        client.createReturnShipment(testShipment),
        /incomplete or unsuccessful shipment response/
    );
});

// Verifies that shipment-level errors are rejected even when the overall response has no errors.
test('Aramex rejects a shipment with HasErrors=true', async () => {
    const client = createTestAramexClient(() =>
        createMockResponse({
            body: `
                <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
                    <soap:Body>
                        <ShipmentCreationResponse xmlns="http://ws.aramex.net/ShippingAPI/v1/">
                            <HasErrors>false</HasErrors>
                            <Shipments>
                                <ProcessedShipment>
                                    <HasErrors>true</HasErrors>
                                    <ID>TEST-AWB-123</ID>
                                </ProcessedShipment>
                            </Shipments>
                        </ShipmentCreationResponse>
                    </soap:Body>
                </soap:Envelope>
            `
        })
    );

    await assert.rejects(
        client.createReturnShipment(testShipment),
        /incomplete or unsuccessful shipment response/
    );
});

// Verifies that a processed shipment without an AWB ID is not reported as successful.
test('Aramex rejects a processed shipment without an AWB ID', async () => {
    const client = createTestAramexClient(() =>
        createMockResponse({
            body: `
                <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
                    <soap:Body>
                        <ShipmentCreationResponse xmlns="http://ws.aramex.net/ShippingAPI/v1/">
                            <HasErrors>false</HasErrors>
                            <Shipments>
                                <ProcessedShipment>
                                    <HasErrors>false</HasErrors>
                                </ProcessedShipment>
                            </Shipments>
                        </ShipmentCreationResponse>
                    </soap:Body>
                </soap:Envelope>
            `
        })
    );

    await assert.rejects(
        client.createReturnShipment(testShipment),
        /incomplete or unsuccessful shipment response/
    );
});

// Verifies that a complete response with both error flags false returns the AWB.
test('Aramex accepts a complete successful shipment response', async () => {
    const client = createTestAramexClient(() =>
        createMockResponse({
            body: `
                <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
                    <soap:Body>
                        <ShipmentCreationResponse xmlns="http://ws.aramex.net/ShippingAPI/v1/">
                            <HasErrors>false</HasErrors>
                            <Shipments>
                                <ProcessedShipment>
                                    <HasErrors>false</HasErrors>
                                    <ID>TEST-AWB-123</ID>
                                </ProcessedShipment>
                            </Shipments>
                        </ShipmentCreationResponse>
                    </soap:Body>
                </soap:Envelope>
            `
        })
    );

    const result = await client.createReturnShipment(testShipment);

    assert.equal(result.HasErrors, false);
    assert.equal(result.trackingNumber, 'TEST-AWB-123');
    assert.equal(result.ProcessedShipments[0].HasErrors, false);
});
