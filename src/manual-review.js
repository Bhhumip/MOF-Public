
'use strict';

function createReasonTag(reason) {
    const normalized = String(reason || 'unspecified')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 180) || 'unspecified';

    return `manual_review:${normalized}`;
}

/**
 * Manual-review notification interface.
 *
 * Active destination: Shopify order tags.
 * Future destinations can implement:
 *   { name: 'email', async notify(record) { ... } }
 *   { name: 'slack', async notify(record) { ... } }
 */
function createManualReviewQueue({
    shopify,
    destinations = [],
    logger = console
} = {}) {
    async function enqueue(record = {}) {
        const tags = [
            'manual_review',
            createReasonTag(record.reason)
        ];

        let orderTagged = false;

        if (record.orderId) {
            if (typeof shopify?.addOrderTags !== 'function') {
                throw new Error(
                    'Shopify addOrderTags is required to tag manual-review orders'
                );
            }

            await shopify.addOrderTags(
                record.orderId,
                [...new Set(tags)]
            );

            orderTagged = true;
        } else {
            logger.warn(
                `[manual-review] Cannot tag order: order ID unavailable. ` +
                `Return=${record.returnId || 'unknown'}, ` +
                `reason=${record.reason || 'unspecified'}`
            );
        }

        const event = {
            ...record,
            tags,
            orderTagged,
            createdAt: new Date().toISOString()
        };

        // No email or Slack integration is enabled by default.
        // Future destinations can be injected without changing returns.js.
        const destinationResults = [];

        for (const destination of destinations) {
            if (typeof destination.notify !== 'function') {
                logger.warn(
                    `[manual-review] Skipping invalid destination: ${destination.name || 'unnamed'}`
                );
                continue;
            }

            try {
                await destination.notify(event);
                destinationResults.push({
                    destination: destination.name || 'unnamed',
                    success: true
                });
            } catch (error) {
                // A future notification failure must not undo the Shopify tag.
                logger.error(
                    `[manual-review] Destination failed: ${destination.name || 'unnamed'}`,
                    error
                );

                destinationResults.push({
                    destination: destination.name || 'unnamed',
                    success: false,
                    error: error.message
                });
            }
        }

        return { ...event, destinationResults };
    }

    return { enqueue };
}

module.exports = {
    createManualReviewQueue,
    createReasonTag
};
