'use strict';

/**
 * Aramex sandbox runner. Run it ON THE SERVER (the whitelisted AWS Elastic IP).
 *
 *   node --env-file=.env scripts/try-aramex.js show              # print the 3 requests, send nothing
 *   node --env-file=.env scripts/try-aramex.js ship              # CreateShipments (sandbox)
 *   node --env-file=.env scripts/try-aramex.js pickup <AWB>      # CreatePickup for that AWB
 *   node --env-file=.env scripts/try-aramex.js track <AWB> ...   # TrackShipments
 *
 * Uses fake sample data (no real customer). The raw XML reply of every call is saved
 * in ./data/aramex-samples/ so it can become a test fixture (remove anything identifying).
 * getConfig() refuses production hosts and CARRIER_MODE=live.
 */
const fs = require('node:fs');
const path = require('node:path');
const { getConfig } = require('../src/config');
const { createAramexClient } = require('../src/carriers/aramex');

const config = getConfig();
const outDir = path.join(__dirname, '..', 'data', 'aramex-samples');
fs.mkdirSync(outDir, { recursive: true });

const sample = {
    returnId: `try-${Date.now()}`,
    reverseFulfillmentOrderId: 'try-rfo',
    orderName: '#TEST',
    customer: {
        name: 'Test Customer', company: '', phone: '+966500000001', email: 'customer@example.com',
        address: { line1: '1 King Fahd Rd', line2: '', city: 'Riyadh', state: '', postCode: '12211', countryCode: 'SA' }
    },
    warehouse: {
        name: 'Returns Warehouse', phone: '+966500000002',
        address: { line1: '5 Warehouse St', line2: '', city: 'Riyadh', state: '', postCode: '12212', countryCode: 'SA' }
    },
    items: [{ sku: 'SKU-1', name: 'Scrub top', quantity: 1 }],
    weight: { value: 1, unit: 'KG' }
};

// Wraps fetch so every request/response is printed and saved (credentials masked).
function recordingFetch(send) {
    return async (url, options) => {
        const requestXml = options.body.replace(/<(Password|AccountPin)>[^<]*</g, '<$1>***<');
        console.log(`\n>>> POST ${url}\n${requestXml}\n`);
        if (!send) return { ok: true, status: 200, text: async () => '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body/></soap:Envelope>' };
        const response = await fetch(url, options);
        const body = await response.text();
        const file = path.join(outDir, `${Date.now()}-${String(options.headers.SOAPAction).split('/').pop().replace(/"/g, '')}.xml`);
        fs.writeFileSync(file, body);
        console.log(`<<< HTTP ${response.status} (saved ${file})\n${body}\n`);
        return { ok: response.ok, status: response.status, text: async () => body };
    };
}

async function main() {
    const [command, ...args] = process.argv.slice(2);
    if (!['show', 'ship', 'pickup', 'track'].includes(command)) {
        console.error('Usage: scripts/try-aramex.js show | ship | pickup <AWB> | track <AWB>...');
        process.exit(1);
    }
    const client = createAramexClient({ ...config.carriers.aramex, fetchImpl: recordingFetch(command !== 'show') });
    const attempt = async (label, work) => {
        try { console.log(label, 'result:', JSON.stringify(await work(), null, 2)); }
        catch (error) { console.log(label, 'ERROR:', error.message, error.notifications ? JSON.stringify(error.notifications) : ''); }
    };

    if (command === 'show') {
        await attempt('ship', () => client.createReturnShipment(sample));
        await attempt('pickup', () => client.createPickup(sample, { awb: '00000000000' }));
        await attempt('track', () => client.trackShipments(['00000000000']));
    }
    if (command === 'ship') await attempt('ship', () => client.createReturnShipment(sample));
    if (command === 'pickup') await attempt('pickup', () => client.createPickup(sample, { awb: args[0] }));
    if (command === 'track') await attempt('track', async () => {
        const { results } = await client.trackShipments(args);
        return Object.fromEntries(Object.entries(results).map(([awb, list]) => [awb, list.map((raw) => client.normalizeEvent(raw))]));
    });
}

main();