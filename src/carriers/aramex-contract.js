'use strict';

/**
 * Aramex request contract: turns the carrier-neutral returnShipment object
 * into the Shipment element of an Aramex CreateShipments request.
 *
 * Source of truth: the Aramex Shipping WSDL (Service_1_0). Two rules matter:
 *  1. The WSDL uses xs:sequence, so element ORDER in the XML must match the
 *     order below. The SOAP serializer writes keys in insertion order, so the
 *     order of the keys in the objects in this file IS the order on the wire.
 *  2. Mandatory fields are validated here, BEFORE any network call, so bad
 *     data goes to manual review instead of costing an API call.
 *
 * Items marked ASSUMPTION are not confirmed by the manual or the WSDL and
 * must be checked on the first sandbox run.
 */

class AramexContractError extends Error {
    constructor(code, message, details = {}) {
        super(message || code);
        this.name = 'AramexContractError';
        this.code = code;
        Object.assign(this, details);
    }
}

// ASSUMPTION: Dimensions is a required element in the WSDL, but a Shopify
// return does not carry parcel size. A small default box is sent until
// Aramex confirms how it prices domestic returns.
const DEFAULT_DIMENSIONS_CM = Object.freeze({ length: 10, width: 10, height: 10 });

const DEFAULT_OPTIONS = Object.freeze({
    productGroup: 'DOM',   // Domestic. International would be EXP (see the manual, Appendix A)
    productType: 'OND',    // The only product type the manual lists for DOM
    paymentType: 'P',      // PLACEHOLDER: the payer rule is still to be confirmed with the client/Aramex
    paymentOptions: '',
    packageType: 'Box',
    // ASSUMPTION: a safe cut-off for free-text goods descriptions.
    maxDescriptionLength: 100
});

function clean(value) {
    return value == null ? '' : String(value).trim();
}

function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Neutral party ({name, company, phone, email, address:{...}}) -> Aramex Party.
 * Element order follows the WSDL: Reference1, Reference2, AccountNumber,
 * PartyAddress, Contact.
 */
function toParty(party = {}, { phone = '', email = '', accountNumber = '' } = {}) {
    const address = party.address || {};
    const name = clean(party.name);
    const contactPhone = clean(party.phone) || phone;

    return {
        Reference1: clean(party.reference),
        AccountNumber: accountNumber,
        PartyAddress: {
            Line1: clean(address.line1),
            Line2: clean(address.line2),
            Line3: '',
            City: clean(address.city),
            StateOrProvinceCode: clean(address.state),
            PostCode: clean(address.postCode),
            CountryCode: clean(address.countryCode).toUpperCase()
        },
        Contact: {
            Department: '',
            PersonName: name,
            Title: '',
            // The manual marks CompanyName, CellPhone and EmailAddress as mandatory.
            CompanyName: clean(party.company) || name,
            PhoneNumber1: contactPhone,
            PhoneNumber1Ext: '',
            // The WSDL requires PhoneNumber2 to be present; the same number is sent.
            PhoneNumber2: contactPhone,
            PhoneNumber2Ext: '',
            FaxNumber: '',
            CellPhone: contactPhone,
            EmailAddress: clean(party.email) || email,
            Type: ''
        }
    };
}

// The fields Aramex rejects when they are empty. Returned as readable paths.
function findMissing(shipper, consignee, weightKg) {
    const missing = [];
    const check = (label, party) => {
        if (!party.Contact.PersonName) missing.push(`${label}.name`);
        if (!party.Contact.PhoneNumber1) missing.push(`${label}.phone`);
        if (!party.Contact.EmailAddress) missing.push(`${label}.email`);
        if (!party.PartyAddress.Line1) missing.push(`${label}.address.line1`);
        if (!party.PartyAddress.City) missing.push(`${label}.address.city`);
        if (!party.PartyAddress.CountryCode) missing.push(`${label}.address.countryCode`);
    };
    check('customer', shipper);
    check('warehouse', consignee);
    if (!(weightKg > 0)) missing.push('weight');
    return missing;
}

function describeGoods(items, fallback, maxLength) {
    const text = items
        .map((item) => `${clean(item.name) || clean(item.sku) || 'Item'} x${item.quantity ?? 1}`)
        .join(', ');
    return truncate(text || fallback, maxLength);
}

/**
 * Build one Aramex Shipment from the neutral returnShipment.
 * Throws AramexContractError('invalid_shipment', { missing }) when something
 * Aramex requires is absent; the orchestrator sends that case to manual review.
 *
 * options: productGroup, productType, paymentType, paymentOptions,
 *          dimensionsCm {length,width,height}, packageType,
 *          fallbackPhone, fallbackEmail (used when Shopify has no value for
 *          the warehouse contact), now (a Date, for tests).
 */
function buildShipment(returnShipment = {}, options = {}) {
    const settings = { ...DEFAULT_OPTIONS, ...options };
    const dimensions = { ...DEFAULT_DIMENSIONS_CM, ...(options.dimensionsCm || {}) };
    const fallback = { phone: clean(options.fallbackPhone), email: clean(options.fallbackEmail) };
    const returnId = clean(returnShipment.returnId);
    const items = Array.isArray(returnShipment.items) ? returnShipment.items : [];

    // The customer is the shipper (the parcel leaves them); the warehouse receives it.
    // Only the e-mail fallback applies to the customer; a missing customer phone
    // must go to manual review, because the courier cannot collect without it.
    const shipper = toParty(returnShipment.customer, { email: fallback.email });
    const consignee = toParty(returnShipment.warehouse, fallback);

    const weightUnit = clean(returnShipment.weight?.unit).toUpperCase();
    const weightKg = weightUnit === 'KG' ? Number(returnShipment.weight?.value) : NaN;

    const missing = findMissing(shipper, consignee, weightKg);
    if (missing.length > 0) {
        throw new AramexContractError(
            'invalid_shipment',
            `Aramex shipment is missing required data: ${missing.join(', ')}`,
            { missing }
        );
    }

    const shippingDateTime = (options.now || new Date()).toISOString();
    const weight = { Unit: 'KG', Value: weightKg };
    const goods = describeGoods(items, 'Returned goods', settings.maxDescriptionLength);

    // Key order below = element order on the wire (WSDL xs:sequence).
    return {
        Reference1: returnId,
        Reference2: clean(returnShipment.orderName),
        Reference3: '',
        Shipper: shipper,
        Consignee: consignee,
        // ThirdParty is deliberately absent: it is only needed when PaymentType is "3".
        ShippingDateTime: shippingDateTime,
        DueDate: shippingDateTime,
        Comments: `Return ${returnId}`.trim(),
        Details: {
            Dimensions: {
                Length: dimensions.length,
                Width: dimensions.width,
                Height: dimensions.height,
                Unit: 'cm'
            },
            ActualWeight: weight,
            ChargeableWeight: weight,
            DescriptionOfGoods: goods,
            GoodsOriginCountry: shipper.PartyAddress.CountryCode,
            // A return travels as one parcel, whatever the number of items in it.
            NumberOfPieces: 1,
            ProductGroup: settings.productGroup,
            ProductType: settings.productType,
            PaymentType: settings.paymentType,
            PaymentOptions: settings.paymentOptions,
            // Items is a wrapper element; each parcel is a ShipmentItem inside it.
            Items: {
                ShipmentItem: [
                    {
                        PackageType: settings.packageType,
                        Quantity: 1,
                        Weight: weight,
                        Comments: goods,
                        Reference: returnId
                    }
                ]
            }
        }
    };
}

module.exports = {
    AramexContractError,
    DEFAULT_DIMENSIONS_CM,
    DEFAULT_OPTIONS,
    toParty,
    buildShipment
};