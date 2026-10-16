'use strict';

// Local stand-in for RedBox. DEVELOPMENT ONLY. Run: node scripts/fake-redbox.js
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.FAKE_REDBOX_PORT || 4000);
const TOKEN = process.env.FAKE_REDBOX_TOKEN || 'fake-redbox-token';
const MODE = process.env.FAKE_REDBOX_MODE || 'ok'; // 'fail500': creating a return answers 500
const NEED_DELIVERED = process.env.FAKE_REDBOX_REQUIRE_DELIVERED === 'true'; // mimic "only delivered parcels can be returned"
const shipments = new Map();
const webhooks = new Map();
let counter = Number(process.env.FAKE_REDBOX_START || Date.now() % 10000000);

function newShipment(fields) {
    counter += 1;
    const id = crypto.randomBytes(12).toString('hex');
    const shipment = {
        id,
        tracking_number: `FAKE${String(counter).padStart(8, '0')}`,
        status_code: 202,
        status_name: 'Processing',
        is_return: false,
        ...fields
    };
    shipments.set(id, shipment);
    return shipment;
}

// Delivered outbound parcels to return against. Put these tracking numbers on test orders.
newShipment({ reference: 'OUT-A', tracking_number: 'FAKEOUT0001', status_name: 'Delivered', status_code: 'Delivered' });
newShipment({ reference: 'OUT-B', tracking_number: 'FAKEOUT0002', status_name: 'Delivered', status_code: 'Delivered' });

function find(idOrTracking) {
    return (
        shipments.get(idOrTracking) ||
        [...shipments.values()].find((s) => s.tracking_number === idOrTracking) ||
        null
    );
}

function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}
const fail = (res, status, msg) => send(res, status, { success: false, response_code: status, msg });

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) return resolve({});
            try { resolve(JSON.parse(text)); } catch { reject(new Error('invalid json')); }
        });
        req.on('error', reject);
    });
}

// Test helper (not part of RedBox): make "RedBox" push a status change to the registered webhook.
// Test helper (not part of RedBox): make "RedBox" push a status change to the registered webhook.
async function push({ tracking_number, status, minutes_ago = 0, numeric = false }) {
    const shipment = find(tracking_number);
    if (!shipment) return { ok: false, error: 'unknown tracking number' };
    shipment.status_name = status;
    const sent = [];
    for (const hook of webhooks.values()) {
        if (hook.event !== 'shipment.status.update') continue;
        const payload = {
            shipment_id: shipment.id,
            tracking_number: shipment.tracking_number,
            status_name: status,
            status_label: status,
            status_code: numeric ? 202 : status,
            date: new Date(Date.now() - minutes_ago * 60000).toISOString(),
            customer_message: ''
        };
        // DEV ONLY: the register script insists on https, but the local middleware speaks plain http.
        const target = hook.target_url.replace(/^https:\/\/(localhost|127\.0\.0\.1)/, 'http://$1');
        try {
            const response = await fetch(target, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...hook.headers },
                body: JSON.stringify(payload)
            });
            sent.push({ target, httpStatus: response.status });
        } catch (error) {
            sent.push({ target, error: error.message });
        }
    }
    return { ok: true, sent };
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const parts = url.pathname.split('/').filter(Boolean);
        const method = req.method;
        console.log(`${method} ${req.url}`);

        if (method === 'POST' && url.pathname === '/__push') return send(res, 200, await push(await readJson(req)));

        if (req.headers.authorization !== `Bearer ${TOKEN}`) return fail(res, 401, 'Unauthorized: Token error');
        if (parts[0] !== 'v3') return fail(res, 404, 'Not Found');

        // Webhooks
        if (parts[1] === 'webhooks') {
            if (method === 'GET' && parts.length === 2) {
                return send(res, 200, { success: true, webhooks: [...webhooks.values()].map((h) => ({ ...h, status: 'Active' })) });
            }
            if (method === 'POST' && parts.length === 2) {
                const body = await readJson(req);
                for (const field of ['event', 'original_id', 'subscriber', 'target_url']) {
                    if (!body[field]) return fail(res, 400, `Bad Request: '${field}' is required`);
                }
                if (webhooks.has(body.original_id)) return fail(res, 409, 'Conflict: webhook already exists');
                webhooks.set(body.original_id, body);
                return send(res, 200, { success: true, webhook_id: crypto.randomBytes(12).toString('hex') });
            }
            if (method === 'DELETE' && parts.length === 3) {
                webhooks.delete(decodeURIComponent(parts[2]));
                return send(res, 200, { success: true });
            }
        }

        // POST /v3/shipments/returns
        if (method === 'POST' && parts[1] === 'shipments' && parts[2] === 'returns' && parts.length === 3) {
            const body = await readJson(req);
            console.log('  body:', JSON.stringify(body));
            if (MODE === 'fail500') return fail(res, 500, 'Internal Server Error: please try again later');

            if (body.original_shipment_id) {
                const original = find(body.original_shipment_id);
                if (!original || (NEED_DELIVERED && original.status_name !== 'Delivered')) {
                    return fail(res, 404, 'Not Found: Shipment not exist');
                }
            } else {
                const missing = ['reference', 'customer_name', 'customer_phone'].filter((field) => !body[field]);
                if (missing.length) return fail(res, 400, `Bad Request: ${missing.join(', ')} is required`);
            }
            if (body.reference && [...shipments.values()].some((s) => s.reference === body.reference)) {
                return fail(res, 409, `Conflict: resource with reference '${body.reference}' already exists`);
            }
            const shipment = newShipment({ reference: body.reference, is_return: true, status_name: 'R-Waiting' });
            // No label URL on purpose: Shopify must be able to download a label URL, and localhost would fail.
            return send(res, 200, { success: true, shipment_id: shipment.id, tracking_number: shipment.tracking_number });
        }

        if (parts[1] === 'shipments') {
            if (method === 'GET' && parts.length === 2) {
                const page = Number(url.searchParams.get('page') || 1);
                const pageSize = Number(url.searchParams.get('page_size') || 50);
                const all = [...shipments.values()].reverse();
                return send(res, 200, {
                    success: true,
                    shipments: all.slice((page - 1) * pageSize, page * pageSize),
                    paging: { current_page: page, page_size: pageSize, total_count: all.length, total_pages: Math.max(1, Math.ceil(all.length / pageSize)) }
                });
            }
            const shipment = parts[2] ? find(decodeURIComponent(parts[2])) : null;
            if (parts[2] && !shipment) return fail(res, 404, `Not Found: resource with ID '${parts[2]}' not found`);

            if (method === 'GET' && parts.length === 3) return send(res, 200, { success: true, shipment });
            if (method === 'GET' && parts[3] === 'status') return send(res, 200, { success: true, status: shipment.status_name });
            if (method === 'GET' && parts[3] === 'label') return fail(res, 404, 'Not Found: label');
            if (method === 'GET' && parts[3] === 'tracking-page') {
                return send(res, 200, {
                    success: true,
                    url_bitly: `https://example.com/t/${shipment.tracking_number}`,
                    url_original: `https://example.com/track/${shipment.tracking_number}`
                });
            }
            if (method === 'POST' && parts[3] === 'cancel') {
                shipment.status_name = 'Canceled';
                return send(res, 200, { success: true });
            }
        }

        if (method === 'GET' && parts[1] === 'pickup-locations') return send(res, 200, { success: true, pickup_locations: [] });
        return fail(res, 404, 'Not Found');
    } catch (error) {
        return fail(res, 400, `Bad Request: ${error.message}`);
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Fake RedBox on http://127.0.0.1:${PORT}  (token: ${TOKEN}, mode: ${MODE}, require-delivered: ${NEED_DELIVERED})`);
    console.log('Delivered outbound parcels to return against: FAKEOUT0001, FAKEOUT0002');
});