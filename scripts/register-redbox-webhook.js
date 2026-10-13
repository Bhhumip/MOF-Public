'use strict';

/**
 * Lists the RedBox webhooks registered for this business account and, only
 * with --register, registers the middleware's callback URL for
 * `shipment.status.update` (RedBox allows ONE event per registration).
 *
 *   node --env-file=.env scripts/register-redbox-webhook.js
 *   node --env-file=.env scripts/register-redbox-webhook.js --url https://<public-host>/webhooks/redbox --register
 *   node --env-file=.env scripts/register-redbox-webhook.js --delete          (removes ours by original_id)
 *
 * Needs in .env: REDBOX_API_ENDPOINT (SANDBOX: https://stage.api.redboxsa.com),
 * REDBOX_BEARER_TOKEN, REDBOX_WEBHOOK_SECRET, REDBOX_WEBHOOK_SUBSCRIBER.
 *
 * Safety:
 *  - Sandbox only. getConfig() rejects the production RedBox host and
 *    CARRIER_MODE=live; this script additionally requires CARRIER_MODE=sandbox.
 *  - Read-only unless --register / --delete is passed.
 *  - A repeat registration is answered by RedBox with 409 and reported, not retried.
 *
 * RedBox will send every delivery with the headers registered here:
 *   Authorization: Bearer <REDBOX_WEBHOOK_SECRET>
 * and the receiver (verifyBearerToken) rejects anything without it.
 *
 * NOTE: webhooks fire for ALL shipments on the account (outbound orders too).
 * The receiver ignores events that do not belong to a return job.
 */

const { getConfig } = require('../src/config');
const { createRedboxClient, RedboxApiError } = require('../src/carriers/redbox');

const EVENT = 'shipment.status.update';
const ORIGINAL_ID = 'mof-returns-status'; // our own stable id; also the key for --delete

function valueOf(args, flag) {
    return args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
}

async function main() {
    const args = process.argv.slice(2);
    const url = valueOf(args, '--url');
    const register = args.includes('--register');
    const remove = args.includes('--delete');

    const config = getConfig();
    if (config.carrierMode !== 'sandbox') {
        throw new Error(`CARRIER_MODE must be "sandbox" to talk to RedBox (currently "${config.carrierMode}")`);
    }
    const redbox = config.carriers.redbox;
    console.error(`RedBox endpoint: ${redbox.endpoint}`); // must be the SANDBOX host
    const client = createRedboxClient(redbox);

    const listed = await client.listWebhooks();
    const existing = Array.isArray(listed?.webhooks) ? listed.webhooks : [];
    console.log(`Registered webhooks: ${existing.length}`);
    for (const hook of existing) console.log(JSON.stringify(hook));

    if (remove) {
        console.log('Deleted:', JSON.stringify(await client.deleteWebhook(ORIGINAL_ID)));
        return;
    }
    if (!register) {
        console.log('Dry run. Pass --url <callback> --register to register, or --delete to remove ours.');
        return;
    }

    if (!url) throw new Error('--url <callback url> is required with --register');
    if (!/^https:\/\//i.test(url)) throw new Error('The callback URL must be https');
    if (!redbox.webhookSecret) throw new Error('REDBOX_WEBHOOK_SECRET is required');
    if (!redbox.webhookSubscriber) throw new Error('REDBOX_WEBHOOK_SUBSCRIBER (the business name) is required');

    try {
        const result = await client.registerWebhook({
            event: EVENT,
            targetUrl: url,
            subscriber: redbox.webhookSubscriber,
            originalId: ORIGINAL_ID,
            secret: redbox.webhookSecret
        });
        console.log('Registered:', JSON.stringify(result));
    } catch (error) {
        if (error instanceof RedboxApiError && error.status === 409) {
            console.log(`Already registered (409). Use --delete first to change it. ${error.message}`);
            return;
        }
        throw error;
    }
}

main().catch((error) => {
    console.error('Failed:', error.message);
    process.exit(1);
});