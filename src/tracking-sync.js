'use strict';

const { createLogger } = require('./logger');

// Once a shipment reaches one of these, we stop asking Aramex about it.
const FINAL_EVENTS = Object.freeze(['returned', 'cancelled']);
const BATCH_SIZE = 50;

// A job is "open" when it is booked at Aramex and has not reached a final state.
function isOpen(job) {
    return (
        job.carrier === 'aramex' &&
        job.status === 'booked' &&
        Boolean(job.trackingNumber) &&
        !FINAL_EVENTS.includes(job.carrierStatus)
    );
}

function latestOf(results = []) {
    // GetLastTrackingUpdateOnly already returns one, but never rely on that: take the newest.
    return [...results].sort(
        (a, b) => Date.parse(b.UpdateDateTime || 0) - Date.parse(a.UpdateDateTime || 0)
    )[0] || null;
}

/**
 * Polls Aramex for the latest status of every open Aramex job and applies changes.
 * Aramex has no webhooks, so this is the only way status reaches Shopify.
 *
 * runOnce() never throws: a failed cycle is logged and the next cycle retries.
 */
function createTrackingSync({ jobStore, carrier, statusSync = null, logger = createLogger() } = {}) {
    async function apply(job, raw) {
        const event = carrier.normalizeEvent(raw);
        const changed = event.rawStatus !== job.carrierStatusRaw || (event.event !== 'unknown' && event.event !== job.carrierStatus);
        if (!changed) return 'unchanged';

        // An older update must never overwrite a newer one.
        if (job.carrierStatusAt && event.occurredAt && Date.parse(event.occurredAt) < Date.parse(job.carrierStatusAt)) {
            return 'stale';
        }

        // The raw code is always kept, so unknown codes can be pinned later without data loss.
        const patch = {
            carrierStatusRaw: event.rawStatus,
            carrierStatusDescription: event.raw.status_name,
            carrierStatusAt: event.occurredAt || new Date().toISOString()
        };

        if (event.event === 'unknown') {
            await jobStore.update(job.key, patch);
            logger.warn('aramex tracking: unclassified status', { job: job.key, code: event.rawStatus, description: event.raw.status_name });
            return 'unknown';
        }

        await jobStore.update(job.key, { ...patch, carrierStatus: event.event });
        logger.info('aramex tracking: status changed', {
            job: job.key, from: job.carrierStatus || null, to: event.event, code: event.rawStatus, classifiedBy: event.classifiedBy
        });

        const fresh = await jobStore.get(job.key);
        if (statusSync) {
            const sync = await statusSync.recordEvent(fresh, event);
            if (sync.error) await jobStore.update(job.key, { statusSyncError: sync.error });
            else if (sync.synced && fresh.statusSyncError) await jobStore.update(job.key, { statusSyncError: null });
        }

        if (['returned', 'expired', 'exception', 'cancelled'].includes(event.event)) {
            logger.warn('aramex tracking: needs attention', { job: job.key, event: event.event });
            await jobStore.update(job.key, {
                needsAttention: event.event,
                ...(event.event === 'returned' && { awaitingInspection: true, returnedAt: event.occurredAt })
            });
        }
        return 'changed';
    }

    return {
        async runOnce() {
            const summary = { checked: 0, changed: 0, unknown: 0, errors: 0 };
            let jobs;
            try {
                jobs = (await jobStore.list()).filter(isOpen);
            } catch (error) {
                logger.error('aramex tracking: could not read jobs', { error: error.message });
                return { ...summary, errors: 1 };
            }

            for (let start = 0; start < jobs.length; start += BATCH_SIZE) {
                const batch = jobs.slice(start, start + BATCH_SIZE);
                let results;
                try {
                    ({ results } = await carrier.trackShipments(batch.map((job) => job.trackingNumber), { lastOnly: true }));
                } catch (error) {
                    // Service down or rejected: skip this cycle, try again at the next one.
                    summary.errors += 1;
                    logger.warn('aramex tracking: call failed, will retry next cycle', { error: error.message, code: error.code });
                    continue;
                }

                for (const job of batch) {
                    summary.checked += 1;
                    try {
                        await jobStore.update(job.key, { lastPolledAt: new Date().toISOString() });
                        const latest = latestOf(results[job.trackingNumber]);
                        if (!latest) continue; // not known to Aramex yet: "pending", not an error
                        const outcome = await apply(job, latest);
                        if (outcome === 'changed') summary.changed += 1;
                        if (outcome === 'unknown') summary.unknown += 1;
                    } catch (error) {
                        summary.errors += 1;
                        logger.error('aramex tracking: could not apply update', { job: job.key, error: error.message });
                    }
                }
            }
            return summary;
        }
    };
}

module.exports = { createTrackingSync, FINAL_EVENTS, isOpen };