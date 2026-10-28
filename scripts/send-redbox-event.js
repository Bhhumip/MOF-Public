'use strict';

// Sends a RedBox-style shipment.status.update delivery to OUR middleware, so you can
// check the Shopify side without waiting for RedBox to move a return manually.
//
//   node --env-file=.env scripts/send-redbox-event.js <return tracking number> <status> [minutes ago]
//   e.g. ... 191794157456 R-Deposited
//        ... 191794157456 In-transit-r
//        ... 191794157456 Returned
//
// Needs REDBOX_WEBHOOK_SECRET (the same one the middleware verifies).
// Optional MIDDLEWARE_REDBOX_WEBHOOK_URL, default http://localhost:3000/webhooks/redbox
const [tracking, status, minutes] = process.argv.slice(2);
const secret = process.env.REDBOX_WEBHOOK_SECRET;
const url = process.env.MIDDLEWARE_REDBOX_WEBHOOK_URL || 'http://localhost:3000/webhooks/redbox';

if (!tracking || !status || !secret) {
    console.error('Usage: node --env-file=.env scripts/send-redbox-event.js <tracking number> <status> [minutes ago]');
    console.error('Needs REDBOX_WEBHOOK_SECRET in .env');
    process.exit(1);
}

const body = {
    tracking_number: tracking,
    status_name: status,
    status_label: status,
    status_code: status,
    date: new Date(Date.now() - (Number(minutes) || 0) * 60000).toISOString(),
    customer_message: ''
};

fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body)
})
    .then(async (response) => console.log(`HTTP ${response.status}`, await response.text()))
    .catch((error) => { console.error('Failed:', error.message); process.exit(1); });