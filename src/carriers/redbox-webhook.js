'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const contractModule = require('./redbox-contract');
const { normalizeEvent } = require('./redbox');

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(request, limit = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(Object.assign(new Error('payload too large'), { code: 'too_large' }));
                request.destroy?.();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
}

function safeEqual(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verification helpers: `(request, body) => boolean`. RedBox does not sign
 * deliveries; it sends the headers we registered, so use verifyBearerToken.
 * The other two are kept for custom setups (e.g. a gateway in front).
 */
function verifySharedSecret({ secret, headerName = 'x-redbox-token' }) {
    return (request) => {
        const received = request.headers[headerName.toLowerCase()];
        return Boolean(secret && received && safeEqual(received, secret));
    };
}

/**
 * RedBox lets us choose the headers it sends with every delivery (the `headers`
 * field of POST /v3/webhooks). We register `Authorization: Bearer <secret>` and
 * check for exactly that.
 */
function verifyBearerToken({ secret }) {
    return (request) => {
        const received = request.headers.authorization;
        return Boolean(secret && received && safeEqual(received, `Bearer ${secret}`));
    };
}

function verifyHmacSha256({ secret, headerName = 'x-redbox-signature', encoding = 'hex' }) {
    return (request, body) => {
        const received = request.headers[headerName.toLowerCase()];
        if (!secret || !received) return false;
        const expected = createHmac('sha256', secret).update(body).digest(encoding);
        return safeEqual(received, expected);
    };
}

// RedBox payloads carry no event id, so a delivery is identified by
// shipment + status + date. A redelivery of the same event has the same key.
function eventKey(parsed, event) {
    const id = parsed.eventId
        ? String(parsed.eventId)
        : [event.trackingNumber || event.shipmentId, event.rawStatus, event.occurredAt].join('|');
    return `redbox-event:${id}`;
}

/**
 * Default way to link a carrier event to its return job. Scans the job store,
 * which is fine at returns volume. At scale, index `data.trackingNumber`
 * (Mongo) / add a column (SQLite) and pass `findJob` instead.
 */
function defaultFindJob(jobStore) {
    return async ({ trackingNumber, shipmentId }) => {
        const jobs = await jobStore.list();
        return (
            jobs.find(
                (job) =>
                    job.key?.startsWith('rfo:') &&
                    job.carrier === 'redbox' &&
                    ((trackingNumber && job.trackingNumber === trackingNumber) ||
                        (shipmentId && job.shipmentId === shipmentId))
            ) || null
        );
    };
}

/**
 * RedBox status webhook receiver.
 *
 *  1. verify the delivery           -> 401 if it fails
 *  2. parse + normalise             -> 400 if the body is not JSON
 *  3. find the return job           -> not one of ours: 200 and ignore (RedBox sends
 *                                      events for every shipment on the account)
 *  4. persist the event (dedupe)    -> a failure here returns 500 so RedBox can retry
 *  5. acknowledge with 200
 *  6. record the carrier status on the job
 *
 * What this deliberately does NOT do: write "in transit"/"delivered" to
 * Shopify. Shopify's reverse delivery has no package-status field
 * (reverseDeliveryShippingUpdate only accepts tracking number/URL and a label
 * URL). Carrier status lives on the job; `onEvent` is the hook for ops alerts.
 * A `delivered` event must not auto-restock either: inspection decides
 * restock vs. dispose (reverseFulfillmentOrderDispose).
 */
function createRedboxWebhookHandler({
    verify,
    jobStore,
    findJob = defaultFindJob(jobStore),
    onEvent = async () => { },
    contract = contractModule,
    logger = console
} = {}) {
    if (typeof verify !== 'function') throw new Error('A verify(request, body) function is required');
    if (!jobStore) throw new Error('A jobStore is required');

    async function apply(eventRow, event, job) {
        try {
            // Ignore events older than what we already recorded (out-of-order delivery).
            const stale =
                job.carrierStatusAt && event.occurredAt && Date.parse(event.occurredAt) < Date.parse(job.carrierStatusAt);

            if (!stale) {
                await jobStore.update(job.key, {
                    carrierStatus: event.event,
                    carrierRawStatus: event.rawStatus,
                    carrierStatusAt: event.occurredAt || new Date().toISOString()
                });
            }
            await jobStore.update(eventRow, {
                status: stale ? 'stale' : 'applied',
                outcome: stale ? 'stale' : 'applied',
                jobKey: job.key
            });

            if (event.event === 'unknown') {
                logger.warn(`[redbox-webhook] unmapped RedBox status "${event.rawStatus}" for job ${job.key}`);
            }
            if (!stale) await onEvent(event, job);
        } catch (error) {
            logger.error('[redbox-webhook] processing failed', error);
            try {
                await jobStore.update(eventRow, { status: 'failed', outcome: 'failed', error: error.message });
            } catch {
                /* nothing more to do */
            }
        }
    }

    return async function handleRedboxWebhook(request, response) {
        if (request.method !== 'POST') {
            response.writeHead(405, { Allow: 'POST' });
            response.end();
            return;
        }

        let body;
        try {
            body = await readBody(request);
        } catch (error) {
            response.writeHead(error.code === 'too_large' ? 413 : 400);
            response.end();
            return;
        }

        if (!verify(request, body)) {
            response.writeHead(401);
            response.end();
            return;
        }

        let parsedBody;
        try {
            parsedBody = JSON.parse(body.toString('utf8'));
        } catch {
            response.writeHead(400);
            response.end();
            return;
        }

        const parsed = contract.parseWebhookEvent(parsedBody);
        const event = normalizeEvent(parsed);

        // RedBox sends status events for EVERY shipment on the account, including
        // outbound orders that are none of our business. Match against our return
        // jobs first; anything else is acknowledged and ignored (not stored).
        let job;
        try {
            job = await findJob({ trackingNumber: event.trackingNumber, shipmentId: event.shipmentId });
        } catch (error) {
            logger.error('[redbox-webhook] job lookup failed', error);
            response.writeHead(500);
            response.end();
            return;
        }

        if (!job) {
            logger.log(`[redbox-webhook] ignored event for non-return shipment tracking=${event.trackingNumber}`);
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ received: true, matched: false }));
            return;
        }

        const key = eventKey(parsed, event);
        let claim;
        try {
            claim = await jobStore.claim(key, {
                carrier: 'redbox',
                kind: 'carrier_event',
                jobKey: job.key,
                trackingNumber: event.trackingNumber,
                shipmentId: event.shipmentId,
                event: event.event,
                rawStatus: event.rawStatus,
                occurredAt: event.occurredAt,
                payload: parsedBody
            });
        } catch (error) {
            logger.error('[redbox-webhook] could not persist event', error);
            response.writeHead(500);
            response.end();
            return;
        }

        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ received: true, matched: true, duplicate: !claim.claimed }));

        if (claim.claimed) await apply(key, event, job);
    };
}

module.exports = {
    createRedboxWebhookHandler,
    verifySharedSecret,
    verifyBearerToken,
    verifyHmacSha256,
    defaultFindJob,
    readBody
};