'use strict';

// Read-only: prints what RedBox holds for a shipment (tracking number or id).
// Sandbox only, because config.js refuses production hosts.
const { getConfig } = require('../src/config');
const { createRedboxClient } = require('../src/carriers/redbox');

async function main() {
    const id = process.argv[2];
    if (!id) {
        console.error('Usage: node --env-file=.env scripts/inspect-redbox-shipment.js <tracking number or shipment id>');
        process.exit(1);
    }
    const redbox = createRedboxClient(getConfig().carriers.redbox);

    const show = async (label, call) => {
        console.log(`\n== ${label}`);
        try {
            console.log(JSON.stringify(await call(), null, 2));
        } catch (error) {
            console.log(`   failed: ${error.message}`);
        }
    };

    await show('shipment', () => redbox.getShipment(id));
    await show('status', () => redbox.getShipmentStatus(id));
    await show('label', () => redbox.getShipmentLabel(id));
    await show('tracking page', () => redbox.getTrackingPage(id));
    await show('activities', () => redbox.getShipmentActivities(id));
}

main().catch((error) => {
    console.error('Failed:', error.message);
    process.exit(1);
});