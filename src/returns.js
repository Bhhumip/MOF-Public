const { resolveCarrierMatch, FALLBACK_CARRIER } = require('./carriers/resolver');

/**
 * Resolve the carrier for a return, using the shippingLines tied to the
 * specific Reverse Fulfillment Order items. Returns a structured match so
 * the reason can be persisted for auditability (§8).
 */
function resolveReturnCarrier(returnData = {}, options = {}) {
  return resolveCarrierMatch(returnData.shippingLines || [], options);
}

function createReturnOrchestrator({
  resolve = resolveReturnCarrier,
  shopify = null,
  carriers = {},
  manualReviewQueue = null
} = {}) {
  async function resolveAndBook({ returnId, reverseFulfillmentOrderId, shippingLines, lineIds }) {
    const match = resolve({ shippingLines }, { lineIds });

    if (match.carrier === FALLBACK_CARRIER) {
      // §8: never guess. Enqueue for operations rather than booking.
      const record = {
        returnId,
        reverseFulfillmentOrderId,
        reason: match.reason,
        matchedOn: match.matchedOn
      };
      if (manualReviewQueue) {
        await manualReviewQueue.enqueue(record);
      }
      return { carrier: FALLBACK_CARRIER, action: 'manual_review', ...record };
    }

    const adapter = carriers[match.carrier];
    if (!adapter) {
      throw new Error(`No carrier adapter registered for "${match.carrier}"`);
    }

    // Idempotency: key on the Reverse Fulfillment Order ID so a redelivered
    // webhook cannot double-book (§8).
    const booking = await adapter.createReturnShipment(
      { returnId, reverseFulfillmentOrderId },
      { idempotencyKey: `rfo:${reverseFulfillmentOrderId}` }
    );

    // Write tracking back to Shopify so status stays visible without a
    // second system (§5 step 6).
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

    return {
      carrier: match.carrier,
      action: booking.drRun ? 'dry_run' : 'booked',
      matchedOn: match.matchedOn,
      trackingNumber: booking.trackingNumber
    };
  }

  return {
    // --- Webhook-driven entry points ---

    async onReturnRequested(payload) {
      // A return is REQUESTED. Nothing to book yet — the merchant must
      // approve first. Log for observability.
      return { status: 'observed', returnId: payload.id };
    },

    async onReturnApproved(payload) {
      // Reverse Fulfillment Order now exists. This is the trigger to
      // resolve the carrier and book the return leg (§5 step 2-5).
      const returnId = payload.admin_graphql_api_id || payload.id;
      const reverseFulfillmentOrderId = payload.reverse_fulfillment_order?.id
        || payload.reverse_fulfillment_order_id;

      // In production, fetch shippingLines + the RFO's line item IDs from
      // Shopify via GetOrderShipping. Placeholder here.
      const shippingLines = payload.shipping_lines || [];
      const lineIds = null;

      return resolveAndBook({ returnId, reverseFulfillmentOrderId, shippingLines, lineIds });
    },

    async onReturnProcessed(payload) {
      // Disposition (restock/dispose) and refund recorded. The carrier
      // booking should already exist; this is for status reconciliation.
      return { status: 'processed', returnId: payload.id };
    },

    async onReverseFulfillmentOrderDisposed(payload) {
      // §5 step 7: carrier reported delivery/disposition. Update the
      // Reverse Delivery in Shopify if needed.
      return { status: 'disposed', reverseFulfillmentOrderId: payload.id };
    },

    // --- Direct HTTP entry point (kept for manual/testing use) ---

    async handle(returnData) {
      const match = resolve(returnData);
      return { carrier: match.carrier, reason: match.reason };
    }
  };
}

module.exports = { createReturnOrchestrator, resolveReturnCarrier };