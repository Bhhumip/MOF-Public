'use strict';

// Sandbox only: creates a NORMAL (forward) RedBox shipment, so it can later be
// marked Delivered and used as the "original shipment" of an internal return.
//
//   node --env-file=.env scripts/redbox-create-shipment.js
//   node --env-file=.env scripts/redbox-create-shipment.js --body my-body.json
//
// The default body follows the RedBox "Create shipment" schema (POST /v3/shipments).
// Required there: reference, customer_name, customer_phone, cod_amount, cod_currency,
// and customer_address (or customer_national_address).
// Use --body file.json to send a different body.
const fs = require('node:fs');
const { getConfig } = require('../src/config'); // refuses production hosts

const CREATE_PATH = process.env.REDBOX_CREATE_SHIPMENT_PATH || '/shipments'; // POST /v3/shipments (unverified)

function defaultBody() {
    return {
        reference: `TEST-OUT-${Date.now()}`,
        cod_amount: 0,               // required by RedBox; 0 = no cash on delivery
        cod_currency: 'SAR',         // required by RedBox
        customer_name: 'Sandbox Customer',
        customer_phone: '+966500000000',
        customer_email: 'sandbox@example.com',
        customer_address: '1 Test St, Riyadh',
        customer_city: 'Riyadh',
        customer_country: 'SA',
        from_platform: 'shopify',
        weight_unit: 'kg',
        weight_value: 1,
        items: [{ name: 'Test item', sku: 'TEST-1', quantity: 1, unit_price: 1, currency: 'SAR' }],
        // Optional: a fixed locker/counter. Without it RedBox asks the customer to choose one.
        ...(process.env.REDBOX_TEST_POINT_ID ? { point_id: process.env.REDBOX_TEST_POINT_ID } : {})
    };
}

async function main() {
    const args = process.argv.slice(2);
    const bodyFile = args.includes('--body') ? args[args.indexOf('--body') + 1] : null;

    const config = getConfig();
    if (config.carrierMode !== 'sandbox') {
        throw new Error(`CARRIER_MODE must be "sandbox" (currently "${config.carrierMode}")`);
    }
    const rb = config.carriers.redbox;
    if (!rb.endpoint || !rb.bearerToken) throw new Error('REDBOX_API_ENDPOINT and REDBOX_BEARER_TOKEN are required');

    const body = bodyFile ? JSON.parse(fs.readFileSync(bodyFile, 'utf8')) : defaultBody();
    if (!body.reference) body.reference = `TEST-OUT-${Date.now()}`; // reference must be unique (409 otherwise)

    const url = `${String(rb.endpoint).replace(/\/+$/, '')}/${rb.apiVersion || 'v3'}${CREATE_PATH}`;
    console.error(`POST ${url}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${rb.bearerToken}` },
        body: JSON.stringify(body)
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    console.log(`HTTP ${response.status}`, JSON.stringify(json, null, 2));
    if (!response.ok || json?.success === false) process.exit(1);

    console.log('\nNext:');
    console.log(`  node --env-file=.env scripts/redbox-set-status.js ${json.tracking_number ?? '<tracking>'} Delivered`);
    console.log('  Then put this tracking number on the Shopify test order fulfillment (company: RedBox).');
}

main().catch((error) => {
    console.error('Failed:', error.message);
    process.exit(1);
});