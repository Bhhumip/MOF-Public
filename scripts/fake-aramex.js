'use strict';

/**
 * Local stand-in for Aramex. DEVELOPMENT / TESTING ONLY. It speaks the same SOAP the real
 * Aramex shipping and tracking services speak, so the app cannot tell the difference.
 *
 *   node scripts/fake-aramex.js                          start it (default http://127.0.0.1:4010)
 *   node scripts/fake-aramex.js advance <awb|last> [step]   move a shipment to its next scan
 *   node scripts/fake-aramex.js state                    list the shipments and their scans
 *   node scripts/fake-aramex.js mode pickupDelayMs=30000 bookingError=login|none
 *
 * Point the app at it (in .env, then restart):
 *   CARRIER_MODE=sandbox
 *   ARAMEX_SOAP_ENDPOINT=http://127.0.0.1:4010/ShippingAPI.V2/Shipping/Service_1_0.svc
 *   ARAMEX_TRACKING_ENDPOINT=http://127.0.0.1:4010/ShippingAPI.V2/Tracking/Service_1_0.svc
 *
 * Steps for `advance`: created, picked_up, in_transit, out_for_delivery, delivered
 * (= the return reached the warehouse), exception, cancelled. No step = the next one.
 *
 * WHAT IS REAL AND WHAT IS INVENTED
 *   Real (seen on the Aramex test system): the SOAP shapes, the ERR75 / ERR48 / ERR40 / ERR50
 *   messages, update codes SH014 (record created) and SH005 (delivered).
 *   Invented: the FK00x update codes, the ERR30 duplicate-reference reply (unconfirmed with
 *   Aramex), the city -> entity table and the tracking timings. Real Aramex update codes must
 *   still be collected from Aramex before go-live.
 *
 * State is kept in memory only: restarting this script forgets every shipment.
 */
const http = require('node:http');

const PORT = Number(process.env.FAKE_ARAMEX_PORT || 4010);
const HOST = process.env.FAKE_ARAMEX_HOST || '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;
const SHIPPING_PATH = '/ShippingAPI.V2/Shipping/Service_1_0.svc';
const TRACKING_PATH = '/ShippingAPI.V2/Tracking/Service_1_0.svc';
const NS = 'http://ws.aramex.net/ShippingAPI/v1/';
const SAUDI_OFFSET_MS = 3 * 60 * 60 * 1000;

// Aramex entity (station) of a city. INVENTED table: unknown cities use the account's entity.
const ENTITY_BY_CITY = { jeddah: 'JED', riyadh: 'RUH', dammam: 'DMM' };

// The scans a shipment moves through. SH014 and SH005 are real Aramex codes; FK00x are made up.
const STEPS = {
    created: { code: 'SH014', description: 'Record created.' },
    picked_up: { code: 'FK001', description: 'Picked up from shipper' },
    in_transit: { code: 'FK002', description: 'Arrived at Aramex facility' },
    out_for_delivery: { code: 'FK003', description: 'Out for delivery' },
    delivered: { code: 'SH005', description: 'Delivered to Consignee' },
    exception: { code: 'FK004', description: 'Delivery attempt failed - consignee not available' },
    cancelled: { code: 'FK005', description: 'Shipment cancelled' }
};
const NORMAL_PATH = ['created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered'];

const PDF = (awb) => {
    const text = `FAKE ARAMEX LABEL ${awb}`;
    const stream = `BT /F1 14 Tf 20 80 Td (${text}) Tj ET`;
    return Buffer.from(
        '%PDF-1.4\n' +
        '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
        '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
        '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 288 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
        `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n` +
        '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
        'trailer<</Root 1 0 R>>\n%%EOF\n'
    );
};

const escapeXml = (value) =>
    String(value ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// First <Name>value</Name> in a piece of XML, or ''.
function tag(xml, name) {
    const match = String(xml).match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
    return match ? match[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
}

const entityOf = (city, fallback) => ENTITY_BY_CITY[String(city || '').trim().toLowerCase()] || fallback;
const saudiTime = (ms) => new Date(ms + SAUDI_OFFSET_MS).toISOString().slice(0, 19);

function createFakeAramex({ labelUrlTemplate, autoAdvanceSeconds = 0, logger = console } = {}) {
    const shipments = new Map(); // awb -> shipment
    const foreignHawbs = new Map(); // ForeignHAWB -> awb
    const pickups = new Map(); // awb -> pickup id
    const mode = { pickupDelayMs: 0, bookingError: 'none' };
    let awbCounter = 0;
    let pickupCounter = 0;
    let server = null;
    let timer = null;
    const labelUrl = (awb) => (labelUrlTemplate || `${BASE_URL}/labels/{awb}.pdf`).replace('{awb}', awb);

    // ---------- XML replies (shapes copied from real Aramex test-system replies) ----------

    const envelope = (body) =>
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${body}</s:Body></s:Envelope>`;
    const INST = 'xmlns:i="http://www.w3.org/2001/XMLSchema-instance"';
    const notifications = (list) =>
        list.length
            ? `<Notifications ${INST}>${list
                .map((n) => `<Notification><Code>${n.code}</Code><Message>${escapeXml(n.message)}</Message></Notification>`)
                .join('')}</Notifications>`
            : `<Notifications ${INST}/>`;
    const transaction = (ref) =>
        `<Transaction ${INST}><Reference1>${escapeXml(ref)}</Reference1><Reference2/><Reference3/><Reference4/><Reference5/></Transaction>`;

    const LOGIN_ERROR = { code: 'ERR75', message: 'ClientInfo - Failed to login using Portal Service' };

    function loginProblem(request) {
        const client = tag(request, 'ClientInfo');
        const missing = ['UserName', 'Password', 'AccountNumber', 'AccountPin', 'AccountEntity'].some((field) => !tag(client, field));
        return missing || tag(client, 'Password') === 'wrong' || mode.bookingError === 'login';
    }

    function createShipments(request) {
        const ref = tag(tag(request, 'Transaction'), 'Reference1');
        const head = (extra) => envelope(`<ShipmentCreationResponse xmlns="${NS}">${transaction(ref)}${extra}</ShipmentCreationResponse>`);
        if (loginProblem(request)) {
            return head(`${notifications([LOGIN_ERROR])}<HasErrors>true</HasErrors><Shipments ${INST}/>`);
        }

        const accountEntity = tag(tag(request, 'ClientInfo'), 'AccountEntity');
        const processed = [];
        for (const block of request.match(/<Shipment>[\s\S]*?<\/Shipment>/g) || []) {
            const shipper = tag(block, 'Shipper');
            const consignee = tag(block, 'Consignee');
            const ref1 = tag(block, 'Reference1');
            const ref2 = tag(block, 'Reference2');
            const foreignHawb = tag(block, 'ForeignHAWB');
            const consigneeCity = tag(tag(consignee, 'PartyAddress'), 'City');
            const shipperCity = tag(tag(shipper, 'PartyAddress'), 'City');
            const consigneeEntity = entityOf(consigneeCity, accountEntity);
            const shipmentError = (code, message) =>
                `<ProcessedShipment><ID i:nil="true"/><Reference1>${escapeXml(ref1)}</Reference1><Reference2>${escapeXml(ref2)}</Reference2><Reference3/><ForeignHAWB i:nil="true"/><HasErrors>true</HasErrors>` +
                `<Notifications><Notification><Code>${code}</Code><Message>${escapeXml(message)}</Message></Notification></Notifications>` +
                '<ShipmentLabel i:nil="true"/><ShipmentDetails i:nil="true"/><ShipmentAttachments/></ProcessedShipment>';

            // Real behaviour: the consignee account is looked up in the entity of the consignee's city.
            if (tag(consignee, 'AccountNumber') && consigneeEntity !== accountEntity) {
                processed.push(shipmentError('ERR48', `Consignee customer account doesn't exist for entity (${consigneeEntity})`));
                continue;
            }
            // UNCONFIRMED with Aramex: a repeated ForeignHAWB is refused.
            if (foreignHawb && foreignHawbs.has(foreignHawb)) {
                processed.push(shipmentError('ERR30', `ForeignHAWB ${foreignHawb} already exists (fake server reply, real code unconfirmed)`));
                continue;
            }

            awbCounter += 1;
            const awb = String(99000000000 + awbCounter);
            const shipment = {
                awb, ref1, ref2, foreignHawb,
                shipperCity, consigneeCity,
                originEntity: entityOf(shipperCity, accountEntity),
                destinationEntity: consigneeEntity,
                weight: tag(tag(block, 'ActualWeight'), 'Value') || '1',
                description: tag(block, 'DescriptionOfGoods'),
                events: []
            };
            shipments.set(awb, shipment);
            if (foreignHawb) foreignHawbs.set(foreignHawb, awb);
            addEvent(shipment, 'created');
            logger.log(`[fake-aramex] booked ${awb} (${shipment.originEntity} -> ${shipment.destinationEntity}) ref ${foreignHawb || ref1}`);

            processed.push(
                `<ProcessedShipment><ID>${awb}</ID><Reference1>${escapeXml(ref1)}</Reference1><Reference2>${escapeXml(ref2)}</Reference2><Reference3/>` +
                (foreignHawb ? `<ForeignHAWB>${escapeXml(foreignHawb)}</ForeignHAWB>` : '<ForeignHAWB i:nil="true"/>') +
                '<HasErrors>false</HasErrors><Notifications/>' +
                `<ShipmentLabel><LabelURL>${escapeXml(labelUrl(awb))}</LabelURL><LabelFileContents/></ShipmentLabel>` +
                `<ShipmentDetails><Origin>${shipment.originEntity}</Origin><Destination>${shipment.destinationEntity}</Destination>` +
                `<ChargeableWeight><Unit>KG</Unit><Value>${escapeXml(shipment.weight)}</Value></ChargeableWeight>` +
                `<DescriptionOfGoods>${escapeXml(shipment.description)}</DescriptionOfGoods><GoodsOriginCountry>SA</GoodsOriginCountry>` +
                '<NumberOfPieces>1</NumberOfPieces><ProductGroup>DOM</ProductGroup><ProductType>OND</ProductType><PaymentType>C</PaymentType>' +
                `<OriginCity>${escapeXml(shipperCity)}</OriginCity><DestinationCity>${escapeXml(consigneeCity)}</DestinationCity></ShipmentDetails>` +
                '<ShipmentAttachments/><SortCode/></ProcessedShipment>'
            );
        }

        const failed = processed.some((p) => p.includes('<HasErrors>true</HasErrors>'));
        return head(`${notifications([])}<HasErrors>${failed}</HasErrors><Shipments ${INST}>${processed.join('')}</Shipments>`);
    }

    // Returns { xml, delayMs }. A slow pickup is still CREATED: only the answer is late, like the
    // real timeout we saw (the pickup existed, the reply never arrived in time).
    function createPickup(request) {
        const ref = tag(tag(request, 'Transaction'), 'Reference1');
        const head = (extra) => envelope(`<PickupCreationResponse xmlns="${NS}">${transaction(ref)}${extra}</PickupCreationResponse>`);
        const failure = (list) =>
            head(`${notifications(list)}<HasErrors>true</HasErrors><ProcessedPickup ${INST}><ID i:nil="true"/><GUID>00000000-0000-0000-0000-000000000000</GUID><Reference1>${escapeXml(ref)}</Reference1><Reference2/><ProcessedShipments/></ProcessedPickup>`);
        if (loginProblem(request)) return { xml: failure([LOGIN_ERROR]), delayMs: 0 };

        const existing = tag(tag(request, 'ExistingShipments'), 'ExistingShipment');
        const awb = tag(existing, 'Number');
        const originEntity = tag(existing, 'OriginEntity');
        const shipment = shipments.get(awb);

        // Real behaviour: a shipment is looked up in the entity given as OriginEntity.
        if (!shipment || shipment.originEntity !== originEntity) {
            return { xml: failure([{ code: 'ERR40', message: 'Pickup.AccountNumber - Shipment does not exist' }]), delayMs: 0 };
        }
        if (pickups.has(awb)) {
            return {
                xml: failure([{ code: 'ERR50', message: `Pickup.ExistingShipments[0].Number - Shipment is already associated with another pickup (${pickups.get(awb)})` }]),
                delayMs: 0
            };
        }
        pickupCounter += 1;
        const pickupId = `K${String(pickupCounter).padStart(6, '0')}`;
        pickups.set(awb, pickupId);
        logger.log(`[fake-aramex] pickup ${pickupId} for ${awb}${mode.pickupDelayMs ? ` (reply delayed ${mode.pickupDelayMs} ms)` : ''}`);
        const guid = `00000000-0000-4000-8000-${String(pickupCounter).padStart(12, '0')}`;
        return {
            xml: head(`${notifications([])}<HasErrors>false</HasErrors><ProcessedPickup ${INST}><ID>${pickupId}</ID><GUID>${guid}</GUID><Reference1>${escapeXml(ref)}</Reference1><Reference2/><ProcessedShipments/></ProcessedPickup>`),
            delayMs: mode.pickupDelayMs
        };
    }

    function trackShipments(request) {
        const head = (extra) =>
            envelope(`<ShipmentTrackingResponse xmlns="${NS}">${transaction('')}${extra}</ShipmentTrackingResponse>`);
        if (loginProblem(request)) {
            return head(`${notifications([LOGIN_ERROR])}<HasErrors>true</HasErrors><TrackingResults ${INST}/><NonExistingWaybills ${INST}/>`);
        }
        const lastOnly = tag(request, 'GetLastTrackingUpdateOnly') === 'true';
        const asked = [...tag(request, 'Shipments').matchAll(/<string[^>]*>([^<]*)<\/string>/g)].map((m) => m[1].trim());
        const ARR = 'xmlns:a="http://schemas.microsoft.com/2003/10/Serialization/Arrays"';
        const results = [];
        const missing = [];
        for (const awb of asked) {
            const shipment = shipments.get(awb);
            if (!shipment) { missing.push(awb); continue; }
            const events = [...shipment.events].reverse(); // newest first
            const chosen = lastOnly ? events.slice(0, 1) : events;
            results.push(
                `<a:KeyValueOfstringArrayOfTrackingResultmFAkxlpY><a:Key>${awb}</a:Key><a:Value>${chosen
                    .map((e) =>
                        `<TrackingResult><WaybillNumber>${awb}</WaybillNumber><UpdateCode>${e.code}</UpdateCode>` +
                        `<UpdateDescription>${escapeXml(e.description)}</UpdateDescription><UpdateDateTime>${saudiTime(e.at)}</UpdateDateTime>` +
                        `<UpdateLocation>${escapeXml(e.location)}</UpdateLocation><Comments/><ProblemCode/><GrossWeight>${escapeXml(shipment.weight)}</GrossWeight>` +
                        `<ChargeableWeight>${escapeXml(shipment.weight)}</ChargeableWeight><WeightUnit>KG</WeightUnit><UpdateTimeZone>GMT+03:00</UpdateTimeZone></TrackingResult>`
                    )
                    .join('')}</a:Value></a:KeyValueOfstringArrayOfTrackingResultmFAkxlpY>`
            );
        }
        return head(
            `${notifications([])}<HasErrors>false</HasErrors><TrackingResults ${ARR} ${INST}>${results.join('')}</TrackingResults>` +
            `<NonExistingWaybills ${ARR} ${INST}>${missing.map((awb) => `<a:string>${awb}</a:string>`).join('')}</NonExistingWaybills>`
        );
    }

    // ---------- scans ----------

    function addEvent(shipment, step) {
        const definition = STEPS[step];
        const last = shipment.events[shipment.events.length - 1];
        const at = Math.max(Date.now(), last ? last.at + 1000 : 0); // always later than the previous scan
        const city = step === 'delivered' ? shipment.consigneeCity : shipment.shipperCity;
        shipment.events.push({ step, ...definition, at, location: `${city || 'Jeddah'}, Saudi Arabia` });
        logger.log(`[fake-aramex] ${shipment.awb}: ${definition.code} "${definition.description}"`);
    }

    function nextStep(shipment) {
        const last = shipment.events[shipment.events.length - 1]?.step;
        const index = NORMAL_PATH.indexOf(last);
        return index >= 0 && index < NORMAL_PATH.length - 1 ? NORMAL_PATH[index + 1] : null;
    }

    function advance(awbOrLast, step) {
        const awb = awbOrLast === 'last' ? [...shipments.keys()].pop() : awbOrLast;
        const shipment = shipments.get(awb);
        if (!shipment) return { ok: false, error: `Unknown shipment ${awbOrLast}` };
        const chosen = step || nextStep(shipment);
        if (!chosen) return { ok: false, error: `${awb} has no next step (last scan: ${shipment.events.at(-1)?.step})` };
        if (!STEPS[chosen]) return { ok: false, error: `Unknown step "${chosen}". Use: ${Object.keys(STEPS).join(', ')}` };
        addEvent(shipment, chosen);
        return { ok: true, awb, step: chosen, code: STEPS[chosen].code };
    }

    const state = () => ({
        mode,
        shipments: [...shipments.values()].map((s) => ({
            awb: s.awb, foreignHawb: s.foreignHawb || null, origin: s.originEntity, destination: s.destinationEntity,
            pickup: pickups.get(s.awb) || null, scans: s.events.map((e) => `${e.code} ${e.step}`)
        }))
    });

    // ---------- HTTP ----------

    async function handle(request, response) {
        const url = new URL(request.url, BASE_URL);
        const send = (status, type, body) => { response.writeHead(status, { 'Content-Type': type }); response.end(body); };
        const sendJson = (status, value) => send(status, 'application/json', JSON.stringify(value, null, 2));

        if (request.method === 'GET' && url.pathname.startsWith('/labels/')) {
            return send(200, 'application/pdf', PDF(url.pathname.slice(8).replace(/\.pdf$/, '')));
        }
        if (url.pathname === '/__fake/state') return sendJson(200, state());
        if (request.method === 'POST' && url.pathname === '/__fake/advance') {
            const result = advance(url.searchParams.get('awb') || 'last', url.searchParams.get('step') || '');
            return sendJson(result.ok ? 200 : 400, result);
        }
        if (request.method === 'POST' && url.pathname === '/__fake/mode') {
            if (url.searchParams.has('pickupDelayMs')) mode.pickupDelayMs = Number(url.searchParams.get('pickupDelayMs')) || 0;
            if (url.searchParams.has('bookingError')) mode.bookingError = url.searchParams.get('bookingError');
            return sendJson(200, mode);
        }

        if (request.method !== 'POST' || ![SHIPPING_PATH, TRACKING_PATH].includes(url.pathname)) {
            return send(404, 'text/plain', 'Not found');
        }
        let body = '';
        for await (const chunk of request) body += chunk;
        const action = String(request.headers.soapaction || '').replace(/"/g, '').split('/').pop();

        if (url.pathname === SHIPPING_PATH && action === 'CreateShipments') return send(200, 'text/xml; charset=utf-8', createShipments(body));
        if (url.pathname === SHIPPING_PATH && action === 'CreatePickup') {
            const { xml, delayMs } = createPickup(body);
            if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
            return send(200, 'text/xml; charset=utf-8', xml);
        }
        if (url.pathname === TRACKING_PATH && action === 'TrackShipments') return send(200, 'text/xml; charset=utf-8', trackShipments(body));

        return send(
            500,
            'text/xml; charset=utf-8',
            envelope(`<s:Fault><faultcode>s:Client</faultcode><faultstring>The fake Aramex server does not support "${escapeXml(action)}" on ${url.pathname}</faultstring></s:Fault>`)
        );
    }

    return {
        advance,
        state,
        mode,
        listen(port = PORT, host = HOST) {
            server = http.createServer((request, response) => {
                handle(request, response).catch((error) => {
                    logger.error(`[fake-aramex] ${error.stack || error}`);
                    if (!response.headersSent) response.writeHead(500);
                    response.end();
                });
            });
            if (autoAdvanceSeconds > 0) {
                timer = setInterval(() => {
                    for (const shipment of shipments.values()) {
                        const step = nextStep(shipment);
                        if (step) addEvent(shipment, step);
                    }
                }, autoAdvanceSeconds * 1000);
            }
            return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
        },
        close() {
            if (timer) clearInterval(timer);
            return new Promise((resolve) => {
                if (!server) return resolve();
                server.close(resolve);
                server.closeAllConnections(); // do not wait for idle keep-alive connections
            });
        }
    };
}

module.exports = { createFakeAramex, STEPS };

// ---------- command line ----------

async function cli() {
    const [command, ...args] = process.argv.slice(2);
    const call = async (path, method = 'GET') => {
        const response = await fetch(`${BASE_URL}${path}`, { method });
        console.log(await response.text());
        process.exitCode = response.ok ? 0 : 1;
    };

    if (command === 'advance') {
        return call(`/__fake/advance?awb=${encodeURIComponent(args[0] || 'last')}${args[1] ? `&step=${encodeURIComponent(args[1])}` : ''}`, 'POST');
    }
    if (command === 'state') return call('/__fake/state');
    if (command === 'mode') return call(`/__fake/mode?${args.join('&')}`, 'POST');
    if (command) {
        console.error('Usage: fake-aramex.js | advance <awb|last> [step] | state | mode pickupDelayMs=N bookingError=login|none');
        process.exit(1);
    }

    const fake = createFakeAramex({
        labelUrlTemplate: process.env.FAKE_ARAMEX_LABEL_URL || '',
        autoAdvanceSeconds: Number(process.env.FAKE_ARAMEX_AUTO_SECONDS || 0)
    });
    await fake.listen();
    console.log(`Fake Aramex listening on ${BASE_URL}`);
    console.log(`  ARAMEX_SOAP_ENDPOINT=${BASE_URL}${SHIPPING_PATH}`);
    console.log(`  ARAMEX_TRACKING_ENDPOINT=${BASE_URL}${TRACKING_PATH}`);
    if (process.env.FAKE_ARAMEX_AUTO_SECONDS) console.log(`  Scans advance by themselves every ${process.env.FAKE_ARAMEX_AUTO_SECONDS}s`);
}

if (require.main === module) cli();