'use strict';

const { resolveCarrierFromTags, FALLBACK_CARRIER } = require('./carriers/resolver');
const { createMemoryJobStore } = require('./jobs');
const { buildReturnShipment, ReturnShipmentError } = require('./return-shipment');
/** Resolve the carrier for a return from the original order's tags. */
function resolveReturnCarrier(returnData = {}, options = {}) {
  return resolveCarrierFromTags(returnData.tags, options);
}

function createReturnOrchestrator({
  resolve = resolveReturnCarrier,
  shopify = null,
  carriers = {},
  manualReviewQueue = null,
  jobStore = createMemoryJobStore(),
  defaultItemWeightKg = null
} = {}) {
  async function enqueueForReview(record) {
    if (manualReviewQueue) await manualReviewQueue.enqueue(record);
    return { carrier: FALLBACK_CARRIER, action: 'manual_review', ...record };
  }

  async function processReverseFulfillmentOrder({ returnId, reverseFulfillmentOrderId, order }) {
    // Idempotency: claim BEFORE booking so a redelivered webhook cannot double-book (§8).
    const key = `rfo:${reverseFulfillmentOrderId}`;
    const claim = await jobStore.claim(key, {
      returnId,
      reverseFulfillmentOrderId,
      orderId: order.id,
      orderName: order.name
    });
    if (!claim.claimed) {
      console.log(`[duplicate] RFO already processed: ${key} (${claim.job.status})`);
      return { action: 'duplicate', reverseFulfillmentOrderId, status: claim.job.status };
    }

    const match = resolve({ tags: order.tags });
    await jobStore.update(key, {
      carrier: match.carrier,
      reason: match.reason,
      matchedTags: match.matchedOn.map((entry) => entry.tag)
    });

    if (match.carrier === FALLBACK_CARRIER) {
      await jobStore.update(key, { status: 'manual_review' });
      return enqueueForReview({
        returnId,
        reverseFulfillmentOrderId,
        reason: match.reason,
        matchedOn: match.matchedOn,
        tags: order.tags
      });
    }

    const adapter = carriers[match.carrier];
    if (!adapter) {
      const message = `No carrier adapter registered for "${match.carrier}"`;
      await jobStore.update(key, { status: 'failed', error: message });
      throw new Error(message);
    }

    // Fetch address data only now, for a return that will really be booked.
    let returnShipment;
    try {
      const details = await shopify.getReturnShipmentDetails(returnId);
      if (!details) throw new ReturnShipmentError('details_not_accessible');
      returnShipment = buildReturnShipment({ returnId, reverseFulfillmentOrderId, details, defaultItemWeightKg });

      if (returnShipment.weightEstimated) {
        await jobStore.update(key, { weightEstimated: true });
      }
    } catch (error) {
      if (error instanceof ReturnShipmentError) {
        await jobStore.update(key, { status: 'manual_review', reason: error.code });
        return enqueueForReview({ returnId, reverseFulfillmentOrderId, reason: error.code, matchedOn: match.matchedOn });
      }
      await jobStore.update(key, { status: 'failed', error: error.message });
      throw error;
    }



    try {
      const booking = await adapter.createReturnShipment(returnShipment, { idempotencyKey: key });

      // A dry-run booking has a fake tracking number: never write it to Shopify.
      if (shopify && !booking.dryRun) {
        await shopify.createReverseDeliveryWithShipping({
          reverseFulfillmentOrderId,
          trackingInput: {
            number: booking.trackingNumber,
            company: adapter.name,
            url: booking.trackingUrl || null
          },
          labelInput: booking.label
            ? { fileUrl: booking.label.url, fileName: booking.label.fileName }
            : null,
          notifyCustomer: true
        });
      }

      const action = booking.dryRun ? 'dry_run' : 'booked';
      await jobStore.update(key, { status: action, trackingNumber: booking.trackingNumber });
      return {
        carrier: match.carrier,
        action,
        reverseFulfillmentOrderId,
        matchedOn: match.matchedOn,
        trackingNumber: booking.trackingNumber
      };
    } catch (error) {
      await jobStore.update(key, { status: 'failed', error: error.message });
      throw error;
    }
  }

  return {
    async onReturnRequested(payload) {
      return { status: 'observed', returnId: payload.admin_graphql_api_id || payload.id };
    },

    // The approve payload carries the Return ID and Order ID only. Everything
    // else (RFO ids, order tags) is fetched from Shopify.
    async onReturnApproved(payload) {
      const returnId = payload.admin_graphql_api_id;
      if (!returnId) throw new Error('returns/approve payload has no admin_graphql_api_id');
      if (!shopify) throw new Error('A Shopify client is required to fetch the return');

      const context = await shopify.getReturnContext(returnId);
      if (!context) {
        return {
          returnId,
          results: [await enqueueForReview({ returnId, reason: 'order_not_accessible', matchedOn: [] })]
        };
      }
      if (context.reverseFulfillmentOrders.length === 0) {
        return {
          returnId,
          results: [await enqueueForReview({ returnId, reason: 'no_reverse_fulfillment_order', matchedOn: [] })]
        };
      }

      const results = [];
      for (const rfo of context.reverseFulfillmentOrders) {
        results.push(
          await processReverseFulfillmentOrder({
            returnId,
            reverseFulfillmentOrderId: rfo.id,
            order: context.order
          })
        );
      }
      return { returnId, results };
    },

    async onReturnProcessed(payload) {
      return { status: 'processed', returnId: payload.admin_graphql_api_id || payload.id };
    },

    async onReverseFulfillmentOrderDisposed(payload) {
      return { status: 'disposed', reverseFulfillmentOrderId: payload.id };
    },

    // Direct HTTP entry point (kept for manual/testing use).
    async handle(returnData) {
      const match = resolve(returnData);
      return { carrier: match.carrier, reason: match.reason };
    }
  };
}

module.exports = { createReturnOrchestrator, resolveReturnCarrier };