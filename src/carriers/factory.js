'use strict';
const { createRedboxClient } = require('./redbox');
const { createAramexClient } = require('./aramex');

function createDryRunCarrier(name, logger = console) {
    return {
        name,
        async createReturnShipment(payload, options = {}) {
            logger.log(`[dry-run] ${name} createReturnShipment (no API call)`, JSON.stringify({ payload, options }));
            return {
                dryRun: true,
                trackingNumber: `DRYRUN-${name}-${options.idempotencyKey || 'no-key'}`,
                trackingUrl: null,
                label: null
            };
        }
    };
}

function buildCarriers(config, { logger = console } = {}) {
    if (config.carrierMode === 'dry-run') {
        return {
            redbox: createDryRunCarrier('redbox', logger),
            aramex: createDryRunCarrier('aramex', logger)
        };
    }
    const factories = { redbox: createRedboxClient, aramex: createAramexClient };
    const carriers = {};
    for (const [name, create] of Object.entries(factories)) {
        try {
            carriers[name] = create(config.carriers[name]);
        } catch (error) {
            logger.warn(`Carrier "${name}" is disabled: ${error.message}`);
        }
    }
    return carriers;
}

module.exports = { buildCarriers, createDryRunCarrier };
