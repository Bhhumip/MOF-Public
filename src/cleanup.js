'use strict';

const { createLogger } = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DELETES_PER_RUN = 200;

// A missing or unreadable date counts as "brand new", so the row is kept.
function ageInDays(iso, now) {
    const time = Date.parse(iso);
    return Number.isNaN(time) ? 0 : (now - time) / DAY_MS;
}

/**
 * Housekeeping for the job store (MongoDB Atlas free tier has only 512 MB).
 * It deletes two kinds of rows, and nothing else:
 *   1. carrier event rows (kind "carrier_event"; the RedBox webhook log) older than eventRetentionDays
 *   2. return jobs whose loop is finished: booked, restock/dispose complete in Shopify, nothing
 *      needing attention, and finished more than retentionDays ago
 * Failed, manual_review, in-progress and "needs attention" jobs are never deleted.
 *
 * Why not delete a return job the moment it finishes: the job row is also the duplicate guard.
 * A late or retried Shopify webhook for the same return would book a second shipment.
 * retentionDays must stay above Shopify's webhook retry window and the reconcile lookback.
 */
function createCleanup({
    jobStore,
    retentionDays = 30,
    eventRetentionDays = 7,
    dryRun = false,
    minIntervalMinutes = 60,
    logger = createLogger()
} = {}) {
    if (!jobStore || typeof jobStore.remove !== 'function') {
        throw new Error('createCleanup needs a job store with a remove(key) method');
    }
    let lastRunAt = 0;

    function reasonToDelete(job, now) {
        if (job.kind === 'carrier_event') {
            return ageInDays(job.updatedAt, now) >= eventRetentionDays ? 'old_carrier_event' : null;
        }
        if (!String(job.key).startsWith('rfo:')) return null;
        if (job.status !== 'booked' || job.dispositionStatus !== 'complete') return null;
        if (job.needsAttention || job.pickupRetryable || job.writebackStatus === 'failed' || job.statusSyncError) return null;
        return ageInDays(job.dispositionAt, now) >= retentionDays ? 'return_completed' : null;
    }

    return {
        // Never throws: a failed cycle is logged and the next cycle tries again.
        async runOnce({ now = new Date(), force = false } = {}) {
            const summary = { checked: 0, deleted: 0, wouldDelete: 0, errors: 0 };
            if (!force && now - lastRunAt < minIntervalMinutes * 60 * 1000) return { ...summary, skipped: true };
            lastRunAt = now.getTime();

            let jobs;
            try {
                jobs = await jobStore.list();
            } catch (error) {
                logger.error('cleanup: could not read jobs', { error: error.message });
                return { ...summary, errors: 1 };
            }

            for (const job of jobs) {
                summary.checked += 1;
                const reason = reasonToDelete(job, now);
                if (!reason) continue;
                if (summary.deleted + summary.wouldDelete >= MAX_DELETES_PER_RUN) break;

                // Only identifiers go to the log (no customer data), as a record of what was removed.
                const record = { key: job.key, reason, trackingNumber: job.trackingNumber, orderName: job.orderName };
                if (dryRun) {
                    summary.wouldDelete += 1;
                    logger.info('cleanup: would delete (dry run)', record);
                    continue;
                }
                try {
                    if (await jobStore.remove(job.key)) {
                        summary.deleted += 1;
                        logger.info('cleanup: deleted', record);
                    }
                } catch (error) {
                    summary.errors += 1;
                    logger.error('cleanup: could not delete', { key: job.key, error: error.message });
                }
            }
            return summary;
        }
    };
}

module.exports = { createCleanup };