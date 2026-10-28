'use strict';

/**
 * Aramex pickup contract: the CreatePickup request for a return.
 *
 * A return is collected FROM THE CUSTOMER, so the pickup address and contact
 * are the customer's. The shipment (and its AWB) is created first; the pickup
 * is then attached to it through ExistingShipments.
 * ASSUMPTION (verify in the sandbox): that ExistingShipments links the AWB to
 * the new pickup. The manual only documents PickupGUID on the shipment.
 *
 * Aramex rules from the manual (Table 31, errors ERR17/18/35-39):
 *   - the pickup date is not in the past and at most 7 days ahead,
 *   - ReadyTime < LastPickupTime and ReadyTime < ClosingTime,
 *   - ReadyTime is inside the entity's business hours, after its minimum lead
 *     time and before its cut-off.
 * The business hours of the client's Aramex entity are NOT known yet. The
 * defaults below are guesses and are all configurable (see config.js); the
 * ERR37/38/39 messages tell us when they are wrong.
 */

const { AramexContractError, toParty } = require('./aramex-contract');

const DEFAULT_WINDOW = Object.freeze({
    utcOffsetMinutes: 180,   // Saudi Arabia (UTC+3, no daylight saving)
    openHour: 9,             // first possible ready time of a pickup day
    lastPickupHour: 17,      // cut-off: a pickup cannot be ready after this
    closeHour: 18,           // the customer's door closes (ClosingTime)
    leadMinutes: 120,        // minimum lead time between "now" and ReadyTime
    closedDays: [5],         // 0 = Sunday ... 5 = Friday. ASSUMPTION
    maxDaysAhead: 7
});

const pad = (number) => String(number).padStart(2, '0');

function formatLocal(localDate, utcOffsetMinutes) {
    const sign = utcOffsetMinutes < 0 ? '-' : '+';
    const absolute = Math.abs(utcOffsetMinutes);
    return (
        `${localDate.getUTCFullYear()}-${pad(localDate.getUTCMonth() + 1)}-${pad(localDate.getUTCDate())}` +
        `T${pad(localDate.getUTCHours())}:${pad(localDate.getUTCMinutes())}:00` +
        `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
    );
}

/**
 * The earliest valid pickup slot for "now".
 * Works on a shifted clock: the local wall time is read with the UTC getters,
 * so the result does not depend on the server's time zone.
 */
function computePickupWindow(now = new Date(), options = {}) {
    const window = { ...DEFAULT_WINDOW, ...options };
    const offsetMs = window.utcOffsetMinutes * 60 * 1000;
    const nowLocal = new Date(now.getTime() + offsetMs);

    // Earliest moment allowed by the lead time, rounded UP to the next quarter hour.
    let ready = new Date(nowLocal.getTime() + window.leadMinutes * 60 * 1000);
    const quarter = 15 * 60 * 1000;
    ready = new Date(Math.ceil(ready.getTime() / quarter) * quarter);

    const dayStart = (date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const today = dayStart(nowLocal);

    for (let guard = 0; guard < 21; guard += 1) {
        const isClosed = window.closedDays.includes(ready.getUTCDay());
        const cutoff = dayStart(ready) + window.lastPickupHour * 3600 * 1000;
        const opening = dayStart(ready) + window.openHour * 3600 * 1000;

        if (isClosed || ready.getTime() >= cutoff) {
            ready = new Date(dayStart(ready) + 24 * 3600 * 1000 + window.openHour * 3600 * 1000);
        } else if (ready.getTime() < opening) {
            ready = new Date(opening);
        } else {
            break;
        }
    }

    const daysAhead = Math.round((dayStart(ready) - today) / (24 * 3600 * 1000));
    if (daysAhead > window.maxDaysAhead) {
        throw new AramexContractError(
            'pickup_window_unavailable',
            `No Aramex pickup slot within ${window.maxDaysAhead} days`
        );
    }

    const day = dayStart(ready);
    const at = (hour) => new Date(day + hour * 3600 * 1000);
    const format = (date) => formatLocal(date, window.utcOffsetMinutes);

    return {
        pickupDate: format(new Date(day)),
        readyTime: format(ready),
        lastPickupTime: format(at(window.lastPickupHour)),
        closingTime: format(at(window.closeHour))
    };
}

// Reuses the shipment dimensions so volume and size stay consistent.
function volumeOf(dimensions) {
    return Math.max(dimensions.length * dimensions.width * dimensions.height, 1);
}

/**
 * Build the Pickup element (key order = WSDL sequence). Throws
 * AramexContractError('invalid_pickup', { missing }) before any network call.
 *
 * options: awb (required), accountEntity, productGroup, productType,
 *          paymentType, dimensionsCm, location, vehicle, window (output of
 *          computePickupWindow), fallbackEmail
 */
function buildPickup(returnShipment = {}, options = {}) {
    const dimensions = { length: 10, width: 10, height: 10, ...(options.dimensionsCm || {}) };
    const customer = toParty(returnShipment.customer, { email: options.fallbackEmail || '' });
    const weightUnit = String(returnShipment.weight?.unit ?? '').toUpperCase();
    const weightKg = weightUnit === 'KG' ? Number(returnShipment.weight?.value) : NaN;
    const returnId = String(returnShipment.returnId ?? '').trim();

    const missing = [];
    if (!options.awb) missing.push('awb');
    if (!customer.Contact.PersonName) missing.push('customer.name');
    if (!customer.Contact.PhoneNumber1) missing.push('customer.phone');
    if (!customer.PartyAddress.Line1) missing.push('customer.address.line1');
    if (!customer.PartyAddress.City) missing.push('customer.address.city');
    if (!customer.PartyAddress.CountryCode) missing.push('customer.address.countryCode');
    if (!(weightKg > 0)) missing.push('weight');
    if (!options.window) missing.push('window');
    if (missing.length > 0) {
        throw new AramexContractError(
            'invalid_pickup',
            `Aramex pickup is missing required data: ${missing.join(', ')}`,
            { missing }
        );
    }

    const productGroup = options.productGroup || 'DOM';
    const productType = options.productType || 'OND';
    const weight = { Unit: 'KG', Value: weightKg };
    // Required by the schema even when there is no money involved.
    const noMoney = () => ({ CurrencyCode: '', Value: 0 });

    return {
        PickupAddress: customer.PartyAddress,
        PickupContact: customer.Contact,
        PickupLocation: options.location || 'Customer address',
        PickupDate: options.window.pickupDate,
        ReadyTime: options.window.readyTime,
        LastPickupTime: options.window.lastPickupTime,
        ClosingTime: options.window.closingTime,
        Comments: `Return ${returnShipment.orderName || returnId}`.slice(0, 100),
        Reference1: returnId.slice(0, 50),
        Reference2: String(returnShipment.orderName ?? '').slice(0, 50),
        // Optional in the manual but required by the WSDL.
        Vehicle: options.vehicle || 'Car',
        PickupItems: {
            PickupItemDetail: [
                {
                    ProductGroup: productGroup,
                    ProductType: productType,
                    NumberOfShipments: 1,
                    PackageType: 'Box',
                    Payment: options.paymentType || 'P',
                    ShipmentWeight: weight,
                    ShipmentVolume: { Unit: 'Cm3', Value: volumeOf(dimensions) },
                    NumberOfPieces: 1,
                    CashAmount: noMoney(),
                    ExtraCharges: noMoney(),
                    ShipmentDimensions: {
                        Length: dimensions.length,
                        Width: dimensions.width,
                        Height: dimensions.height,
                        Unit: 'cm'
                    },
                    Comments: 'Customer return'
                }
            ]
        },
        Status: 'Ready',
        ExistingShipments: {
            ExistingShipment: [
                {
                    Number: String(options.awb),
                    OriginEntity: options.accountEntity || '',
                    ProductGroup: productGroup
                }
            ]
        }
    };
}

module.exports = { DEFAULT_WINDOW, computePickupWindow, buildPickup };