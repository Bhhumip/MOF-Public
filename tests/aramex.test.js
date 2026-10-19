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
        warehouseEmail: 'returns@example.com',
        fetchImpl,
        retries: 0
    });
}

// The carrier-neutral shape that return-shipment.js builds and the orchestrator
// passes to every adapter.
function validReturnShipment(overrides = {}) {
    return {
        returnId: 'return-test',
        reverseFulfillmentOrderId: 'rfo-test',
        orderName: '#1001',
        customer: {
            name: 'Test Customer',
            company: '',
            phone: '+966500000001',
            email: 'customer@example.com',
            address: { line1: '1 King Fahd Rd', line2: '', city: 'Riyadh', state: '', postCode: '12211', countryCode: 'SA' }
        },
        warehouse: {
            name: 'Returns Warehouse',
            phone: '+966500000002',
            address: { line1: '5 Warehouse St', line2: '', city: 'Riyadh', state: '', postCode: '12212', countryCode: 'SA' }
        },
        items: [{ sku: 'SKU-1', name: 'Scrub top', quantity: 2 }],
        weight: { value: 1, unit: 'KG' },
        ...overrides
    };
}

const testShipment = validReturnShipment();
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

    await client.createReturnShipment(validReturnShipment({ returnId: 'return-123' }));

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

    const input = validReturnShipment({ returnId: 'return-&-123' });
    input.customer.name = 'Customer & Sons';
    await client.createReturnShipment(input);

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
        () => client.createReturnShipment(validReturnShipment({ returnId: 'return-error' })),
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
        () => client.createReturnShipment(validReturnShipment({ returnId: 'return-http-error' })),
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

    const result = await client.createReturnShipment(validReturnShipment({ returnId: 'return-success' }));

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

test('Aramex sends Source in ClientInfo, right after AccountCountryCode', async () => {
    // The WSDL ClientInfo sequence ends ...AccountCountryCode, Source. Source is mandatory per the manual.
    let body;
    const client = createTestAramexClient(async (_url, options) => {
        body = options.body;
        return createMockResponse({
            body: '<ShipmentCreationResponse><HasErrors>false</HasErrors><Shipments><ProcessedShipment><HasErrors>false</HasErrors><ID>AWB-1</ID></ProcessedShipment></Shipments></ShipmentCreationResponse>'
        });
    });

    await client.createReturnShipment(testShipment);

    assert.match(body, /<AccountCountryCode>AE<\/AccountCountryCode><Source>24<\/Source>/);
});

test('Aramex sends a domestic OND shipment with nested address and weight', async () => {
    let body;
    const client = createTestAramexClient(async (_url, options) => {
        body = options.body;
        return createMockResponse({
            body: '<ShipmentCreationResponse><HasErrors>false</HasErrors><Shipments><ProcessedShipment><HasErrors>false</HasErrors><ID>AWB-1</ID></ProcessedShipment></Shipments></ShipmentCreationResponse>'
        });
    });

    await client.createReturnShipment(testShipment);

    assert.match(body, /<Line1>1 King Fahd Rd<\/Line1>/);
    assert.match(body, /<CountryCode>SA<\/CountryCode>/);
    assert.match(body, /<ActualWeight><Unit>KG<\/Unit><Value>1<\/Value><\/ActualWeight>/);
    assert.match(body, /<ProductGroup>DOM<\/ProductGroup><ProductType>OND<\/ProductType>/);
    assert.doesNotMatch(body, /<ThirdParty/);
});

test('Aramex makes no network call when required data is missing', async () => {
    let called = false;
    const client = createTestAramexClient(async () => {
        called = true;
        return createMockResponse({ body: '' });
    });
    const input = validReturnShipment();
    input.customer.address.line1 = '';

    await assert.rejects(
        () => client.createReturnShipment(input),
        (error) => error.code === 'invalid_shipment' && error.missing.includes('customer.address.line1')
    );
    assert.equal(called, false);
});

// ---- Response handling (Patch 2) -------------------------------------------------

function clientReturning(body) {
    return createTestAramexClient(async () => createMockResponse({ body }));
}

function successXml({ label = '<ShipmentLabel><LabelURL>https://files.example/label.pdf</LabelURL><LabelFileContents i:nil="true"/></ShipmentLabel>' } = {}) {
    return `<s:Envelope><s:Body><ShipmentCreationResponse xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
        <Transaction><Reference1>return-test</Reference1></Transaction>
        <Notifications/>
        <HasErrors>false</HasErrors>
        <Shipments><ProcessedShipment>
            <ID>AWB-777</ID><Reference1>return-test</Reference1>
            <HasErrors>false</HasErrors><Notifications/>
            ${label}
        </ProcessedShipment></Shipments>
    </ShipmentCreationResponse></s:Body></s:Envelope>`;
}

test('Aramex success: the label link is a label, and trackingUrl stays null', async () => {
    const result = await clientReturning(successXml()).createReturnShipment(testShipment);

    assert.equal(result.trackingNumber, 'AWB-777');
    assert.equal(result.shipmentId, 'AWB-777');
    assert.equal(result.trackingUrl, null);
    assert.deepEqual(result.label, { url: 'https://files.example/label.pdf', fileName: 'aramex-AWB-777.pdf' });
});

test('Aramex success without a label link gives label null, not an error', async () => {
    const result = await clientReturning(
        successXml({ label: '<ShipmentLabel><LabelURL i:nil="true"/><LabelFileContents i:nil="true"/></ShipmentLabel>' })
    ).createReturnShipment(testShipment);

    assert.equal(result.label, null);
    assert.equal(result.trackingNumber, 'AWB-777');
});

test('Aramex success parses a response that uses namespace prefixes', async () => {
    const xml = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
        <a:ShipmentCreationResponse xmlns:a="http://ws.aramex.net/ShippingAPI/v1/">
          <a:HasErrors>false</a:HasErrors>
          <a:Shipments><a:ProcessedShipment><a:ID>AWB-PFX</a:ID><a:HasErrors>false</a:HasErrors></a:ProcessedShipment></a:Shipments>
        </a:ShipmentCreationResponse></s:Body></s:Envelope>`;
    const result = await clientReturning(xml).createReturnShipment(testShipment);
    assert.equal(result.trackingNumber, 'AWB-PFX');
});

test('Aramex request-level rejection: the message carries Aramex codes and the error is carrier_rejected', async () => {
    const xml = `<ShipmentCreationResponse><Notifications>
        <Notification><Code>ERR01</Code><Message>Invalid account number</Message></Notification>
      </Notifications><HasErrors>true</HasErrors><Shipments/></ShipmentCreationResponse>`;

    await assert.rejects(
        () => clientReturning(xml).createReturnShipment(testShipment),
        (error) =>
            error.code === 'carrier_rejected' &&
            error.outcomeUnknown === false &&
            /ERR01 Invalid account number/.test(error.message)
    );
});

test('Aramex shipment-level rejection is read even when the request-level flag is false', async () => {
    const xml = `<ShipmentCreationResponse><HasErrors>false</HasErrors><Shipments><ProcessedShipment>
        <ID/><HasErrors>true</HasErrors>
        <Notifications><Notification><Code>ERR30</Code><Message>Line1 is empty</Message></Notification></Notifications>
      </ProcessedShipment></Shipments></ShipmentCreationResponse>`;

    await assert.rejects(
        () => clientReturning(xml).createReturnShipment(testShipment),
        (error) => error.code === 'carrier_rejected' && /ERR30 Line1 is empty/.test(error.message)
    );
});

test('Aramex warnings on a successful shipment are kept, not treated as failure', async () => {
    const xml = `<ShipmentCreationResponse><HasErrors>false</HasErrors><Shipments><ProcessedShipment>
        <ID>AWB-W</ID><HasErrors>false</HasErrors>
        <Notifications><Notification><Code>WRN01</Code><Message>Check weight</Message></Notification></Notifications>
      </ProcessedShipment></Shipments></ShipmentCreationResponse>`;

    const result = await clientReturning(xml).createReturnShipment(testShipment);
    assert.equal(result.trackingNumber, 'AWB-W');
    assert.deepEqual(result.notifications, [{ code: 'WRN01', message: 'Check weight' }]);
});

test('Aramex unreadable or incomplete 200 response is flagged outcomeUnknown', async () => {
    for (const body of ['<html>gateway page</html>', '<ShipmentCreationResponse><HasErrors>false</HasErrors></ShipmentCreationResponse>']) {
        await assert.rejects(
            () => clientReturning(body).createReturnShipment(testShipment),
            (error) => error.code === 'incomplete_response' && error.outcomeUnknown === true
        );
    }
});

test('Aramex matches the shipment by reference when several come back', async () => {
    const xml = `<ShipmentCreationResponse><HasErrors>false</HasErrors><Shipments>
        <ProcessedShipment><ID>OTHER</ID><Reference1>someone-else</Reference1><HasErrors>false</HasErrors></ProcessedShipment>
        <ProcessedShipment><ID>MINE</ID><Reference1>return-test</Reference1><HasErrors>false</HasErrors></ProcessedShipment>
      </Shipments></ShipmentCreationResponse>`;

    assert.equal((await clientReturning(xml).createReturnShipment(testShipment)).trackingNumber, 'MINE');
});

test('Aramex timeout surfaces as an outcomeUnknown error and is not retried', async () => {
    let calls = 0;
    const client = createTestAramexClient(async () => {
        calls += 1;
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    await assert.rejects(
        () => client.createReturnShipment(testShipment),
        (error) => error.code === 'timeout' && error.outcomeUnknown === true
    );
    assert.equal(calls, 1);
});