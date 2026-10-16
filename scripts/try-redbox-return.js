'use strict';

// Sandbox diagnostic: what does RedBox hold for an outbound shipment, and will it accept a return for it?
// Prints no customer data. With --try-return it CREATES a sandbox return shipment.
const { getConfig } = require('../src/config'); // refuses production hosts

const rb = getConfig().carriers.redbox;
const base = `${String(rb.endpoint).replace(/\/+$/, '')}/${rb.apiVersion || 'v3'}`;

async function call(method, path, body) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${rb.bearerToken}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: response.status, body: json };
}

const summary = (result) =>
    result.body?.success
        ? { shipment_id: result.body.shipment_id, tracking_number: result.body.tracking_number }
        : result.body?.msg ?? result.body;

async function main() {
    const tracking = process.argv[2];
    const tryReturn = process.argv.includes('--try-return');
    if (!tracking) {
        console.error('Usage: node --env-file=.env scripts/try-redbox-return.js <outbound tracking number> [--try-return]');
        process.exit(1);
    }
    console.log(`Endpoint: ${rb.endpoint}`);

    const found = await call('GET', `/shipments/${encodeURIComponent(tracking)}`);
    const s = found.body?.shipment;
    console.log(
        'GET shipment ->', found.status,
        s ? { id: s.id, status: s.status_name, is_return: s.is_return, reference: s.reference } : (found.body?.msg ?? found.body)
    );
    if (!s || !tryReturn) return;

    const ref = `DIAG-${Date.now()}`;
    const byId = await call('POST', '/shipments/returns', { original_shipment_id: s.id, reference: ref });
    console.log('POST return, original = shipment id ->', byId.status, summary(byId));
    if (byId.status !== 404) return;

    const byTracking = await call('POST', '/shipments/returns', { original_shipment_id: tracking, reference: `${ref}-T` });
    console.log('POST return, original = tracking number ->', byTracking.status, summary(byTracking));
}

main().catch((error) => { console.error('Failed:', error.message); process.exit(1); });