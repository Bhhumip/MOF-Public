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
  defaultItemWeightKg = null,
  statusSync,
  testOrderTag = null,
  stuckJobMinutes = 15
} = {}) {
  const MAX_PICKUP_ATTEMPTS = 3;
  const PICKUP_RETRY_MINUTES = 10;   // wait attempts x 10 minutes between pickup retries
  const MAX_RETRY_ATTEMPTS = 3;
  const RETRY_MINUTES = 10;
  // Tags may arrive as an array or as Shopify's comma separated string.
  function hasTag(tags, wanted) {
    const list = Array.isArray(tags) ? tags : String(tags ?? '').split(',');
    return list.some((tag) => String(tag).trim().toLowerCase() === wanted.trim().toLowerCase());
  }

  async function enqueueForReview(record) {
    if (manualReviewQueue) {
      try {
        await manualReviewQueue.enqueue(record);
      } catch (error) {
        // The review decision is still valid even if Shopify tagging fails.
        // Keep the tagging error visible for operational follow-up.
        if (record.jobKey) {
          try {
            await jobStore.update(record.jobKey, {
              manualReviewTagError: error.message
            });
          } catch (storeError) {
            console.error(
              '[manual-review] Could not persist tag error:',
              storeError.message
            );
          }
        }

        console.error(
          '[manual-review] Failed to apply Shopify order tags:',
          error.message
        );
      }
    }

    return {
      carrier: FALLBACK_CARRIER,
      action: 'manual_review',
      ...record
    };
  }


  function writeBackToShopify({ reverseFulfillmentOrderId, carrierName, booking }) {
    return shopify.createReverseDeliveryWithShipping({
      reverseFulfillmentOrderId,
      trackingInput: {
        number: booking.trackingNumber,
        company: carrierName,
        url: booking.trackingUrl || null
      },
      labelInput: booking.label
        ? { fileUrl: booking.label.url, fileName: booking.label.fileName }
        : null,
      notifyCustomer: true
    });
  }

  /**
   * Creates the Aramex pickup for a booked shipment and records the outcome on the job.
   * Never throws: pickupStatus is one of created | already_linked | unknown | failed.
   *   unknown  = Aramex may have created it, so a person checks first (never auto-retried)
   *   failed   = Aramex said no; retried by retryPending() unless the data itself is wrong
   */
  async function attemptPickup({ key, adapter, returnShipment, awb, returnId, order, reverseFulfillmentOrderId }) {
    const job = await jobStore.get(key);
    const attempts = (job?.pickupAttempts || 0) + 1;
    const base = { pickupAttempts: attempts, lastPickupAttemptAt: new Date().toISOString() };

    try {
      const pickup = await adapter.createPickup(returnShipment, { awb });
      await jobStore.update(key, {
        ...base,
        pickupStatus: 'created',
        pickupId: pickup.pickupId,
        pickupGuid: pickup.pickupGuid,
        pickupDate: pickup.pickupDate,
        pickupError: null,
        pickupRetryable: false
      });
      return { status: 'created', ...pickup };
    } catch (error) {
      let status = 'failed';
      let retryable = false;
      if (error.hasNotification?.('ERR50')) {
        // Aramex: shipment is already in another pickup. Nothing more to do.
        status = 'already_linked';
      } else if (error.outcomeUnknown) {
        status = 'unknown';
      } else {
        // Wrong/missing data will not fix itself; carrier/service problems may.
        retryable = error.code !== 'invalid_pickup' && attempts < MAX_PICKUP_ATTEMPTS;
      }

      await jobStore.update(key, {
        ...base,
        pickupStatus: status,
        pickupError: error.message,
        pickupRetryable: retryable,
        ...(status !== 'already_linked' && { needsAttention: status === 'unknown' ? 'pickup_outcome_unknown' : 'pickup_failed' })
      });
      console.error(`[pickup] ${key}: ${status} - ${error.message}`);

      // Staff are told (order tag) when a person has to act.
      if (status === 'unknown' || (status === 'failed' && !retryable)) {
        await enqueueForReview({
          returnId, orderId: order.id, reverseFulfillmentOrderId, jobKey: key,
          reason: status === 'unknown' ? 'pickup_outcome_unknown' : 'pickup_failed', matchedOn: []
        });
      }
      return { status, error: error.message };
    }
  }

  async function processReverseFulfillmentOrder({ returnId, reverseFulfillmentOrderId, order, resume = false, now = new Date() }) {
    // Safety guard for sandbox/real-store tests: only orders carrying the test tag are booked.
    // Checked BEFORE the claim, so skipping leaves no job behind and the order can be booked later.
    if (testOrderTag && !hasTag(order.tags, testOrderTag)) {
      console.log(`[guard] skipped ${reverseFulfillmentOrderId}: order is missing the "${testOrderTag}" test tag`);
      return { action: 'skipped', reason: 'not_test_order', reverseFulfillmentOrderId };
    }

    // Idempotency: claim BEFORE booking so a redelivered webhook cannot double-book (§8).
    const key = `rfo:${reverseFulfillmentOrderId}`;
    if (resume) {
      // A new attempt on the SAME job (no new claim). Callers only resume jobs where nothing
      // was booked. If another attempt is already running, back off instead of racing it.
      const previous = await jobStore.get(key);
      const idleMinutes = (now - Date.parse(previous?.updatedAt || 0)) / 60000;
      if (!previous || (previous.status === 'processing' && idleMinutes < stuckJobMinutes)) {
        return { action: 'duplicate', reverseFulfillmentOrderId, status: previous?.status || 'unknown' };
      }
      await jobStore.update(key, {
        status: 'processing',
        error: null,
        reason: null,
        outcomeUnknown: false,
        bookingStartedAt: null,
        needsAttention: null,
        failedStage: null,
        retryAttempts: (previous.retryAttempts || 0) + 1,
        lastRetryAt: new Date().toISOString()
      });
    } else {
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
        jobKey: key,
        returnId,
        orderId: order.id,
        reverseFulfillmentOrderId,
        reason: match.reason,
        matchedOn: match.matchedOn,
        tags: order.tags
      });
    }

    const adapter = carriers[match.carrier];
    if (!adapter) {
      const message = `No carrier adapter registered for "${match.carrier}"`;
      await jobStore.update(key, { status: 'failed', error: message, failedStage: 'config' });
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
        return enqueueForReview({ jobKey: key, returnId, orderId: order.id, reverseFulfillmentOrderId, reason: error.code, matchedOn: match.matchedOn });
      }
      await jobStore.update(key, { status: 'failed', error: error.message, failedStage: 'details' });
      throw error;
    }



    try {
      // Written BEFORE the carrier call. If the server dies after this and before the AWB is
      // saved, the sweep knows a booking may exist and sends the job to manual review.
      await jobStore.update(key, { bookingStartedAt: new Date().toISOString() });
      const booking = await adapter.createReturnShipment(returnShipment, { idempotencyKey: key });
      await jobStore.update(key, {
        shipmentId: booking.shipmentId || null,
        trackingNumber: booking.trackingNumber,
        trackingUrl: booking.trackingUrl || null,
        labelUrl: booking.label?.url || null
      });
      // A dry-run booking has a fake tracking number: never write it to Shopify.
      // The booking exists at the carrier from here on. A Shopify hiccup must NOT mark the
      // job failed (that would hide a real shipment): record it and retry in retryPending().
      let writebackFailed = false;
      if (shopify && !booking.dryRun) {
        try {
          await writeBackToShopify({ reverseFulfillmentOrderId, carrierName: adapter.name, booking });
          await jobStore.update(key, { writebackStatus: 'done', writebackError: null });

        } catch (error) {
          writebackFailed = true;
          console.error('[writeback] Shopify write-back failed after a successful booking:', error.message);
          await jobStore.update(key, {
            writebackStatus: 'failed',
            writebackError: error.message,
            needsAttention: 'shopify_writeback_failed'
          });
          // Also tag the order for staff (same manual-review tags as the other review cases).
          await enqueueForReview({
            returnId, orderId: order.id, reverseFulfillmentOrderId, jobKey: key,
            reason: 'shopify_writeback_failed', matchedOn: match.matchedOn
          });

        }
      }

      const action = booking.dryRun ? 'dry_run' : 'booked';
      await jobStore.update(key, {
        status: action,
        trackingNumber: booking.trackingNumber,
        trackingUrl: booking.trackingUrl || null
      });

      // Step 2 for carriers that need it (Aramex): schedule the collection from the customer.
      // A pickup problem never undoes the booking.
      let pickup = null;
      if (!booking.dryRun && typeof adapter.createPickup === 'function') {
        pickup = await attemptPickup({ key, adapter, returnShipment, awb: booking.trackingNumber, returnId, order, reverseFulfillmentOrderId });
      }

      // Make the status visible inside Shopify. Best effort: never fails the booking.
      if (statusSync && !booking.dryRun) {
        const sync = await statusSync.recordBooking({
          reverseFulfillmentOrderId,
          returnId,
          orderId: order.id,
          orderName: order.name,
          carrier: match.carrier,
          trackingNumber: booking.trackingNumber,
          trackingUrl: booking.trackingUrl || null
        });
        if (!sync.synced && sync.error) await jobStore.update(key, { statusSyncError: sync.error });
      }
      return {
        carrier: match.carrier,
        action,
        reverseFulfillmentOrderId,
        matchedOn: match.matchedOn,
        trackingUrl: booking.trackingUrl || null,
        trackingNumber: booking.trackingNumber,
        ...(writebackFailed && { writebackStatus: 'failed', reason: 'shopify_writeback_failed' }),
        ...(pickup && { pickupStatus: pickup.status })

      };
    } catch (error) {
      // The request may have reached the carrier and created a shipment even though we
      // got no clean answer (timeout, dropped connection, unreadable reply). The job
      // stays claimed, so a redelivered webhook cannot book again. Ops must look the
      // booking up at the carrier by the return ID before anyone re-books.
      if (error.outcomeUnknown) {
        await jobStore.update(key, {
          status: 'manual_review',
          reason: 'booking_outcome_unknown',
          outcomeUnknown: true,
          error: error.message
        });
        return enqueueForReview({
          jobKey: key, returnId, orderId: order.id, reverseFulfillmentOrderId, reason: 'booking_outcome_unknown', matchedOn: match.matchedOn
        });
      }

      const REVIEW_CODES = ['invalid_shipment', 'carrier_rejected', 'original_shipment_not_found', 'multiple_original_shipments', 'original_shipment_rejected'];
      if (REVIEW_CODES.includes(error.code)) {
        await jobStore.update(key, {
          status: 'manual_review',
          reason: error.code,
          // Keep the carrier's own reasons (e.g. Aramex "ERR30 Line1 is empty") for ops.
          ...(error.code === 'carrier_rejected' ? { error: error.message } : {})
        });
        return enqueueForReview({
          jobKey: key, returnId, orderId: order.id, reverseFulfillmentOrderId, reason: error.code, matchedOn: match.matchedOn,
          ...(error.missing ? { missing: error.missing } : {})
        });
      }
      // 'booking' = Aramex/RedBox said no (nothing created), retried by retryPending().
      // 'after_booking' = the carrier accepted it but a later step failed; recovered, never re-booked.
      const current = await jobStore.get(key);
      await jobStore.update(key, {
        status: 'failed',
        error: error.message,
        failedStage: current?.trackingNumber ? 'after_booking' : 'booking'
      });
      // Tag the order too (eg. carrier credentials or a 4xx from the carries ),
      //so the return does not fail silently. tag errors never mask the real error.
      await enqueueForReview({
        jobKey: key, returnId, orderId: order.id, reverseFulfillmentOrderId, reason: 'booking_failed', matchedOn: match.matchedOn
      });
      throw error;
    }
  }

  // ---- recovery: runs from retryPending() on the poller timer, or by hand via reprocess() ----

  const minutesSince = (value, now = new Date()) => (now - Date.parse(value || 0)) / 60000;

  // Re-reads the return from Shopify and runs the normal flow again on the SAME job.
  // Only for jobs where nothing was booked.
  async function resumeJob(job, now = new Date()) {
    if (!shopify) return null;
    const context = await shopify.getReturnContext(job.returnId);
    if (!context) {
      await jobStore.update(job.key, {
        status: 'failed',
        failedStage: 'details',
        error: 'Return not readable from Shopify on retry',
        retryAttempts: (job.retryAttempts || 0) + 1
      });
      return null;
    }
    const rfo = context.reverseFulfillmentOrders.find((entry) => entry.id === job.reverseFulfillmentOrderId);
    if (!rfo || rfo.status !== 'OPEN') {
      // Cancelled or closed in Shopify since: never book it now.
      await jobStore.update(job.key, { status: 'manual_review', reason: 'rfo_not_open', error: null });
      return null;
    }
    try {
      return await processReverseFulfillmentOrder({
        returnId: job.returnId,
        reverseFulfillmentOrderId: job.reverseFulfillmentOrderId,
        order: context.order,
        resume: true,
        now
      });
    } catch (error) {
      console.error(`[retry] ${job.key}: attempt failed: ${error.message}`);
      return null; // processReverseFulfillmentOrder already recorded the failure on the job
    }
  }

  // A job where the carrier DID accept the booking but a later step did not finish.
  // Never re-books: it only queues the missing follow-up steps.
  async function recoverBooked(job, reason, summary) {
    const adapter = carriers[job.carrier];
    await jobStore.update(job.key, {
      status: 'booked',
      recoveredFrom: reason,
      error: null,
      failedStage: null,
      ...(shopify && job.writebackStatus !== 'done' && { writebackStatus: 'failed' }),
      ...(adapter?.createPickup && !job.pickupStatus && {
        pickupStatus: 'failed', pickupRetryable: true, pickupAttempts: 0
      })
    });
    if (statusSync) {
      await statusSync.recordBooking({
        reverseFulfillmentOrderId: job.reverseFulfillmentOrderId,
        returnId: job.returnId,
        orderId: job.orderId,
        orderName: job.orderName,
        carrier: job.carrier,
        trackingNumber: job.trackingNumber,
        trackingUrl: job.trackingUrl || null
      });
    }
    summary.recovered += 1;
    return jobStore.get(job.key);
  }

  // A job stuck in "processing" means the server stopped while handling it.
  async function recoverInterrupted(job, summary, now) {
    if (job.trackingNumber) return recoverBooked(job, 'interrupted_after_booking', summary);

    if (job.bookingStartedAt) {
      // The carrier call may or may not have gone through: a person must check. Never re-book.
      await jobStore.update(job.key, {
        status: 'manual_review',
        reason: 'interrupted_during_booking',
        outcomeUnknown: true,
        error: 'The server stopped while booking. Look the shipment up at the carrier by the return ID before re-running it.'
      });
      await enqueueForReview({
        returnId: job.returnId, orderId: job.orderId, reverseFulfillmentOrderId: job.reverseFulfillmentOrderId,
        jobKey: job.key, reason: 'interrupted_during_booking', matchedOn: []
      });
      summary.review += 1;
      return null;
    }

    // Stopped before the carrier call: nothing exists, so run it again.
    summary.resumed += 1;
    await resumeJob(job, now);
    return null;
  }

  async function handleFailed(job, now, summary) {
    if (job.trackingNumber) return recoverBooked(job, 'failed_after_booking', summary);
    if (job.outcomeUnknown || !job.failedStage || job.failedStage === 'config') return null;

    const attempts = job.retryAttempts || 0;
    if (attempts >= MAX_RETRY_ATTEMPTS) {
      if (!job.retriesExhausted) {
        await jobStore.update(job.key, { retriesExhausted: true, needsAttention: 'retries_exhausted' });
        await enqueueForReview({
          returnId: job.returnId, orderId: job.orderId, reverseFulfillmentOrderId: job.reverseFulfillmentOrderId,
          jobKey: job.key, reason: 'retries_exhausted', matchedOn: []
        });
        summary.review += 1;
      }
      return null;
    }
    if (minutesSince(job.updatedAt, now) < (attempts + 1) * RETRY_MINUTES) return null;

    summary.resumed += 1;
    await resumeJob(job, now);
    return null;
  }

  // Write-back and pickup retries for a booked shipment (previous retryPending logic).
  async function retryBookedJob(job, now, summary) {
    const adapter = carriers[job.carrier];

    if (job.status === 'booked' && job.writebackStatus === 'failed' && shopify && adapter) {
      await writeBackToShopify({
        reverseFulfillmentOrderId: job.reverseFulfillmentOrderId,
        carrierName: adapter.name,
        booking: {
          trackingNumber: job.trackingNumber,
          trackingUrl: job.trackingUrl,
          label: job.labelUrl ? { url: job.labelUrl, fileName: `${job.carrier}-${job.trackingNumber}.pdf` } : null
        }
      });
      await jobStore.update(job.key, { writebackStatus: 'done', writebackError: null });
      summary.writeback += 1;
    }

    if (
      job.status === 'booked' && job.pickupStatus === 'failed' && job.pickupRetryable &&
      adapter?.createPickup && minutesSince(job.lastPickupAttemptAt, now) >= (job.pickupAttempts || 1) * PICKUP_RETRY_MINUTES
    ) {
      // Customer details are re-read from Shopify: they are never stored in the job.
      const details = await shopify.getReturnShipmentDetails(job.returnId);
      if (!details) return;
      const returnShipment = buildReturnShipment({
        returnId: job.returnId, reverseFulfillmentOrderId: job.reverseFulfillmentOrderId, details, defaultItemWeightKg
      });
      await attemptPickup({
        key: job.key, adapter, returnShipment, awb: job.trackingNumber, returnId: job.returnId,
        order: { id: job.orderId }, reverseFulfillmentOrderId: job.reverseFulfillmentOrderId
      });
      summary.pickup += 1;
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
          results: [await enqueueForReview({ returnId, orderId: payload.order_id || payload.order?.admin_graphql_api_id || null, reason: 'order_not_accessible', matchedOn: [] })]
        };
      }
      if (context.reverseFulfillmentOrders.length === 0) {
        return {
          returnId,
          results: [await enqueueForReview({ returnId, orderId: context.order?.id || payload.order_id || payload.order?.admin_graphql_api_id || null, reason: 'no_reverse_fulfillment_order', matchedOn: [] })]
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


    // Run on a timer (the poller does). One pass over all jobs:
    //  - "processing" for longer than stuckJobMinutes  -> the server stopped mid-job: recover it
    //  - "failed" before any booking                   -> try again (wait attempts x 10 min, max 3)
    //  - booked: Shopify write-back and Aramex pickup retries
    async retryPending({ now = new Date() } = {}) {
      const summary = { writeback: 0, pickup: 0, resumed: 0, recovered: 0, review: 0, errors: 0 };
      for (const job of await jobStore.list()) {
        try {
          let current = job;
          if (current.status === 'processing' && minutesSince(current.updatedAt, now) >= stuckJobMinutes) {
            current = await recoverInterrupted(current, summary, now);
          } else if (current.status === 'failed') {
            current = await handleFailed(current, now, summary);
          }
          if (current?.status === 'booked') await retryBookedJob(current, now, summary);
        } catch (error) {
          summary.errors += 1;
          console.error(`[retry] ${job.key}: ${error.message}`);
        }
      }
      return summary;
    },

    // Finds approved returns whose webhook never arrived (server down, or a lost delivery):
    // an OPEN reverse fulfillment order with no job gets the normal flow.
    async reconcileMissing({ now = new Date(), lookbackHours = 24, limit = 10 } = {}) {
      const summary = { found: 0, processed: 0, errors: 0 };
      if (typeof shopify?.listOpenReturns !== 'function') return summary;

      let open;
      try {
        open = await shopify.listOpenReturns({ since: new Date(now - lookbackHours * 3600 * 1000) });
      } catch (error) {
        console.error(`[reconcile] could not list returns: ${error.message}`);
        return { ...summary, errors: 1 };
      }

      for (const ret of open) {
        for (const rfo of ret.reverseFulfillmentOrders) {
          if (summary.found >= limit) return summary;
          if (await jobStore.get(`rfo:${rfo.id}`)) continue;
          summary.found += 1;
          try {
            await processReverseFulfillmentOrder({
              returnId: ret.returnId, reverseFulfillmentOrderId: rfo.id, order: ret.order
            });
            summary.processed += 1;
          } catch (error) {
            summary.errors += 1;
            console.error(`[reconcile] rfo:${rfo.id}: ${error.message}`);
          }
        }
      }
      return summary;
    },

    // Manual re-run after staff fixed the cause (address, tags, ...). Used by scripts/reprocess-return.js.
    // Refuses anything that may already exist at the carrier, unless force is set after checking there.
    async reprocess(returnId, { force = false } = {}) {
      if (!shopify) throw new Error('A Shopify client is required to reprocess a return');
      const context = await shopify.getReturnContext(returnId);
      if (!context) return { returnId, results: [{ action: 'skipped', reason: 'return_not_readable' }] };

      const results = [];
      for (const rfo of context.reverseFulfillmentOrders) {
        const key = `rfo:${rfo.id}`;
        const job = await jobStore.get(key);
        const base = { reverseFulfillmentOrderId: rfo.id };
        const skip = (reason) => results.push({ ...base, action: 'skipped', reason });

        if (!job) {
          results.push(await processReverseFulfillmentOrder({ returnId, reverseFulfillmentOrderId: rfo.id, order: context.order }));
        } else if (!['failed', 'manual_review'].includes(job.status)) {
          skip(`status_${job.status}`);
        } else if (job.trackingNumber) {
          skip('already_booked');
        } else if (job.outcomeUnknown && !force) {
          skip('outcome_unknown_check_the_carrier_then_use_force');
        } else if (rfo.status !== 'OPEN') {
          skip('rfo_not_open');
        } else {
          try {
            results.push(await processReverseFulfillmentOrder({
              returnId, reverseFulfillmentOrderId: rfo.id, order: context.order, resume: true
            }));
          } catch (error) {
            results.push({ ...base, action: 'failed', error: error.message });
          }
        }
      }
      return { returnId, results };
    },

    // The customer or merchant cancelled the return in Shopify. Aramex has no
    // "cancel shipment" call, so the job is flagged and staff cancel the pickup at Aramex.
    async onReturnCancelled(payload) {
      const returnId = payload.admin_graphql_api_id || payload.id;
      const jobs = (await jobStore.list()).filter((job) => job.returnId === returnId);
      for (const job of jobs) {
        await jobStore.update(job.key, { needsAttention: 'return_cancelled', returnCancelledAt: new Date().toISOString() });
        console.warn(`[ops] ${job.key}: return cancelled in Shopify; cancel the carrier pickup/shipment manually`);
        if (statusSync && job.status === 'booked') {
          await statusSync.recordEvent(job, { event: 'cancelled', rawStatus: 'Return cancelled in Shopify', occurredAt: new Date().toISOString() });
        }
      }
      return { status: 'cancelled', returnId, jobs: jobs.length };
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