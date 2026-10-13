'use strict';

// Local stand-in for the RedBox sandbox. DEVELOPMENT ONLY.
// Mirrors the documented /v3 response shapes so the real client runs over real HTTP.
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.FAKE_REDBOX_PORT || 4000);
const TOKEN = process.env.FAKE_REDBOX_TOKEN || 'fake-redbox-token';
const MODE = process.env.FAKE_REDBOX_MODE || 'ok'; // 'fail500' makes POST /shipments/returns return 500

const shipments = new Map();
let counter = 0;

function newShipment(fields) {
    counter += 1;
    const id = crypto.randomBytes(12).toString('hex');
    const shipment = {
        id,
        tracking_number: `FAKE${String(counter).padStart(8, '0')}`,
        status_code: 'Processing',
        status_name: 'Processing',
        ...fields
    };
    shipments.set(id, shipment);
    return shipment;
}

// One outbound parcel, handy later for "internal return" tests.
newShipment({ reference: 'OUT-1001', is_return: false });

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
const notFound = (res, id) => fail(res, 404, `Not Found: resource with ID '${id}' not found`);

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

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const parts = url.pathname.split('/').filter(Boolean); // ['v3', 'shipments', ...]
        const method = req.method;
        console.log(`${method} ${req.url}`);

        if (req.headers.authorization !== `Bearer ${TOKEN}`) return fail(res, 401, 'Unauthorized: Token error');
        if (parts[0] !== 'v3') return fail(res, 404, 'Not Found');

        // POST /v3/shipments/returns
        if (method === 'POST' && parts[1] === 'shipments' && parts[2] === 'returns' && parts.length === 3) {
            const body = await readJson(req);
            console.log('  body:', JSON.stringify(body));
            if (MODE === 'fail500') return fail(res, 500, 'Internal Server Error: please try again later');

            if (body.original_shipment_id) {
                if (!find(body.original_shipment_id)) return notFound(res, body.original_shipment_id);
            } else {
                const missing = ['reference', 'customer_name', 'customer_phone'].filter((field) => !body[field]);
                if (missing.length) return fail(res, 400, `Bad Request: ${missing.join(', ')} is required`);
            }
            if (body.reference && [...shipments.values()].some((s) => s.reference === body.reference)) {
                return fail(res, 409, `Conflict: resource with reference '${body.reference}' already exists`);
            }
            const shipment = newShipment({
                reference: body.reference,
                is_return: true,
                items: body.items || [],
                customer: { name: body.customer_name, phone: body.customer_phone }
            });
            // shipping_label_url is left out on purpose: Shopify must be able to fetch a label URL,
            // and a localhost URL would not work. The client then tries GET .../label, which 404s here.
            return send(res, 200, { success: true, shipment_id: shipment.id, tracking_number: shipment.tracking_number });
        }

        if (parts[1] === 'shipments') {
            // GET /v3/shipments?page=&page_size=
            if (method === 'GET' && parts.length === 2) {
                const page = Number(url.searchParams.get('page') || 1);
                const pageSize = Number(url.searchParams.get('page_size') || 50);
                const all = [...shipments.values()].reverse(); // newest first
                return send(res, 200, {
                    success: true,
                    shipments: all.slice((page - 1) * pageSize, page * pageSize),
                    paging: {
                        current_page: page,
                        page_size: pageSize,
                        total_count: all.length,
                        total_pages: Math.max(1, Math.ceil(all.length / pageSize))
                    }
                });
            }

            const shipment = parts[2] ? find(decodeURIComponent(parts[2])) : null;
            if (parts[2] && !shipment) return notFound(res, parts[2]);

            if (method === 'GET' && parts.length === 3) return send(res, 200, { success: true, shipment });
            if (method === 'GET' && parts[3] === 'status') return send(res, 200, { success: true, status: shipment.status_code });
            if (method === 'GET' && parts[3] === 'label') return notFound(res, 'label');
            if (method === 'GET' && parts[3] === 'tracking-page') {
                return send(res, 200, {
                    success: true,
                    original_url: `https://example.com/track/${shipment.tracking_number}`,
                    short_url: `https://example.com/t/${shipment.tracking_number}`
                });
            }
            if (method === 'POST' && parts[3] === 'cancel') {
                shipment.status_code = 'Canceled';
                shipment.status_name = 'Canceled';
                return send(res, 200, { success: true });
            }
        }

        if (method === 'GET' && parts[1] === 'pickup-locations') return send(res, 200, { success: true, pickup_locations: [] });
        if (method === 'GET' && parts[1] === 'webhooks') return send(res, 200, { success: true, webhooks: [] });

        return fail(res, 404, 'Not Found');
    } catch (error) {
        return fail(res, 400, `Bad Request: ${error.message}`);
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Fake RedBox listening on http://127.0.0.1:${PORT} (token: ${TOKEN}, mode: ${MODE})`);
});