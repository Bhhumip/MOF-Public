'use strict';

// Handle = stable id of the record, e.g. "rfo-27807449386". Lowercase letters, digits and hyphens only.
function rfoHandle(reverseFulfillmentOrderId) {
    const tail = String(reverseFulfillmentOrderId ?? '').split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (!tail) throw new Error('A reverse fulfillment order ID is required');
    return `rfo-${tail}`;
}

// Shopify date_time: ISO 8601, written without milliseconds.
function toDateTime(value) {
    const date = new Date(value ?? Date.now());
    const safe = Number.isNaN(date.getTime()) ? new Date() : date;
    return safe.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Identifiers only. No customer name, phone or address is ever stored here.
function baseFields(job) {
    return {
        title: [job.orderName, job.carrier, job.trackingNumber].filter(Boolean).join(' · '),
        order_name: job.orderName,
        order_id: job.orderId,
        return_id: job.returnId,
        rfo_id: job.reverseFulfillmentOrderId,
        carrier: job.carrier,
        tracking_number: job.trackingNumber,
        tracking_url: job.trackingUrl
    };
}

/**
 * Writes the carrier status into Shopify (metaobject per shipment + a link on the order).
 * Best effort: it never throws, so a Shopify hiccup cannot fail or undo a booking.
 */
function createStatusSync({ shopify, enabled = false, logger = console } = {}) {
    async function run(label, work) {
        if (!enabled) return { synced: false, reason: 'disabled' };
        try {
            await work();
            return { synced: true };
        } catch (error) {
            logger.warn(`[status-sync] ${label} failed: ${error.message}`);
            return { synced: false, error: error.message };
        }
    }

    return {
        enabled,

        recordBooking(job) {
            return run('booking', async () => {
                const record = await shopify.upsertReturnShipmentRecord(rfoHandle(job.reverseFulfillmentOrderId), {
                    ...baseFields(job), status: 'created', status_raw: 'Booked', last_event_at: toDateTime()
                });
                if (job.orderId && record?.id) await shopify.linkReturnShipmentToOrder(job.orderId, record.id);
            });
        },

        recordEvent(job, event) {
            return run('event', async () => {
                await shopify.upsertReturnShipmentRecord(rfoHandle(job.reverseFulfillmentOrderId), {
                    ...baseFields(job),
                    status: event.event,
                    status_raw: event.raw?.status_name ?? event.rawStatus,
                    last_event_at: toDateTime(event.occurredAt)
                });
            });
        }
    };
}

module.exports = { createStatusSync, rfoHandle, toDateTime };