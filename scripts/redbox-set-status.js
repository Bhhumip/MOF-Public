'use strict';

// Sandbox only: asks RedBox to move a shipment to a new status, so RedBox
// itself fires the shipment.status.update webhook at our middleware.
//
//   node --env-file=.env scripts/redbox-set-status.js <tracking number or shipment id> <status>
//
// Statuses: Received, In-Transit, Deposited, Delivered, Expired,
//           In-Transit-ex, Not-Delivered, Not-Deposited
const { getConfig } = require('../src/config');
const { createRedboxClient } = require('../src/carriers/redbox');
const contract = require('../src/carriers/redbox-contract');

const DEFAULT_URL = 'https://stage.redboxsa.com/api/business/v1/dev/change-shipment-status';
const ALLOWED_HOSTS = ['stage.redboxsa.com']; // this dev endpoint must never point anywhere else
const STATUSES = [
    'Received', 'In-Transit', 'Deposited', 'Delivered',
    'Expired', 'In-Transit-ex', 'Not-Delivered', 'Not-Deposited'
];

async function main() {
    const [idOrTracking, statusArg] = process.argv.slice(2);
    if (!idOrTracking || !statusArg) {
        console.error('Usage: node --env-file=.env scripts/redbox-set-status.js <tracking number or shipment id> <status>');
        console.error(`Statuses: ${STATUSES.join(', ')}`);
        process.exit(1);
    }

    // Accept any casing, send RedBox's exact spelling.
    const status = STATUSES.find((s) => s.toLowerCase() === statusArg.toLowerCase());
    if (!status) throw new Error(`Unsupported status "${statusArg}". Use one of: ${STATUSES.join(', ')}`);

    const config = getConfig();
    if (config.carrierMode !== 'sandbox') {
        throw new Error(`CARRIER_MODE must be "sandbox" (currently "${config.carrierMode}")`);
    }

    const url = process.env.REDBOX_DEV_STATUS_URL || DEFAULT_URL;
    const host = new URL(url).hostname.toLowerCase();
    if (!ALLOWED_HOSTS.includes(host)) throw new Error(`Refusing to call ${host}: not the RedBox stage host`);

    const rb = config.carriers.redbox;
    const apiKey = process.env.REDBOX_DEV_API_KEY || rb.bearerToken;
    if (!apiKey) throw new Error('Set REDBOX_BEARER_TOKEN (or REDBOX_DEV_API_KEY)');

    // The dev endpoint wants a shipment_id; GET /shipments/{id} accepts either id or tracking number.
    const details = contract.parseShipmentDetails(await createRedboxClient(rb).getShipment(idOrTracking));
    if (!details) throw new Error(`RedBox has no shipment for "${idOrTracking}"`);
    console.error(`Shipment ${details.shipmentId} tracking=${details.trackingNumber} is_return=${details.isReturn}`);
    if (!details.isReturn) console.error('Warning: this is NOT a return shipment (outbound parcel).');

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ shipment_id: details.shipmentId, status })
    });
    console.log(`-> ${status}: HTTP ${response.status}`, await response.text());
    if (!response.ok) process.exit(1);
}

main().catch((error) => {
    console.error('Failed:', error.message);
    process.exit(1);
});