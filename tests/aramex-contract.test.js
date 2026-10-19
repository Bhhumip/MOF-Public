'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildShipment, AramexContractError } = require('../src/carriers/aramex-contract');
const { buildSoapEnvelope } = require('../src/carriers/aramex-soap');

function neutral(overrides = {}) {
    return {
        returnId: 'gid://shopify/Return/1',
        orderName: '#1001',
        customer: {
            name: 'Test Customer',
            phone: '+966500000001',
            email: 'customer@example.com',
            address: { line1: '1 King Fahd Rd', city: 'Riyadh', postCode: '12211', countryCode: 'sa' }
        },
        warehouse: {
            name: 'Returns Warehouse',
            phone: '',
            address: { line1: '5 Warehouse St', city: 'Riyadh', countryCode: 'SA' }
        },
        items: [
            { sku: 'A', name: 'Scrub top', quantity: 2 },
            { sku: 'B', name: 'Lab coat', quantity: 1 }
        ],
        weight: { value: 1.25, unit: 'KG' },
        ...overrides
    };
}

const fallbacks = { fallbackPhone: '+966500000009', fallbackEmail: 'returns@example.com' };

test('customer is the shipper and the warehouse is the consignee', () => {
    const shipment = buildShipment(neutral(), fallbacks);
    assert.equal(shipment.Shipper.Contact.PersonName, 'Test Customer');
    assert.equal(shipment.Shipper.PartyAddress.Line1, '1 King Fahd Rd');
    assert.equal(shipment.Consignee.Contact.PersonName, 'Returns Warehouse');
    assert.equal(shipment.Consignee.PartyAddress.City, 'Riyadh');
});

test('country codes are upper-cased', () => {
    assert.equal(buildShipment(neutral(), fallbacks).Shipper.PartyAddress.CountryCode, 'SA');
});

test('the warehouse uses the fallback phone and e-mail when Shopify has none', () => {
    const consignee = buildShipment(neutral(), fallbacks).Consignee.Contact;
    assert.equal(consignee.PhoneNumber1, '+966500000009');
    assert.equal(consignee.CellPhone, '+966500000009');
    assert.equal(consignee.EmailAddress, 'returns@example.com');
});

test('a missing customer phone is NOT replaced by the warehouse fallback', () => {
    const input = neutral();
    input.customer.phone = '';
    assert.throws(
        () => buildShipment(input, fallbacks),
        (error) => error instanceof AramexContractError && error.missing.includes('customer.phone')
    );
});

test('weight becomes a {Unit, Value} block used for actual and chargeable weight', () => {
    const { Details } = buildShipment(neutral(), fallbacks);
    assert.deepEqual(Details.ActualWeight, { Unit: 'KG', Value: 1.25 });
    assert.deepEqual(Details.ChargeableWeight, { Unit: 'KG', Value: 1.25 });
});

test('unknown or non-positive weight is reported as missing', () => {
    for (const weight of [null, { value: 0, unit: 'KG' }, { value: 1, unit: 'LB' }]) {
        assert.throws(
            () => buildShipment(neutral({ weight }), fallbacks),
            (error) => error.code === 'invalid_shipment' && error.missing.includes('weight')
        );
    }
});

test('a return is one piece and one ShipmentItem inside the Items wrapper', () => {
    const { Details } = buildShipment(neutral(), fallbacks);
    assert.equal(Details.NumberOfPieces, 1);
    assert.equal(Details.Items.ShipmentItem.length, 1);
    assert.equal(Details.Items.ShipmentItem[0].Quantity, 1);
    assert.match(Details.DescriptionOfGoods, /Scrub top x2, Lab coat x1/);
});

test('a long goods description is cut to the configured limit', () => {
    const items = [{ name: 'x'.repeat(300), quantity: 1 }];
    assert.ok(buildShipment(neutral({ items }), fallbacks).Details.DescriptionOfGoods.length <= 100);
});

test('product group and type default to DOM/OND and can be overridden', () => {
    assert.equal(buildShipment(neutral(), fallbacks).Details.ProductType, 'OND');
    const intl = buildShipment(neutral(), { ...fallbacks, productGroup: 'EXP', productType: 'PPX' });
    assert.equal(intl.Details.ProductGroup, 'EXP');
    assert.equal(intl.Details.ProductType, 'PPX');
});

test('PaymentType lives in Details only, and ThirdParty is not sent', () => {
    const shipment = buildShipment(neutral(), fallbacks);
    assert.equal('PaymentType' in shipment, false);
    assert.equal(shipment.Details.PaymentType, 'P');
    assert.equal('ThirdParty' in shipment, false);
});

test('element order matches the WSDL sequence', () => {
    const shipment = buildShipment(neutral(), fallbacks);
    assert.deepEqual(Object.keys(shipment), [
        'Reference1', 'Reference2', 'Reference3', 'Shipper', 'Consignee',
        'ShippingDateTime', 'DueDate', 'Comments', 'Details'
    ]);
    assert.deepEqual(Object.keys(shipment.Details), [
        'Dimensions', 'ActualWeight', 'ChargeableWeight', 'DescriptionOfGoods',
        'GoodsOriginCountry', 'NumberOfPieces', 'ProductGroup', 'ProductType',
        'PaymentType', 'PaymentOptions', 'Items'
    ]);
    assert.deepEqual(Object.keys(shipment.Shipper.Contact).slice(0, 7), [
        'Department', 'PersonName', 'Title', 'CompanyName', 'PhoneNumber1', 'PhoneNumber1Ext', 'PhoneNumber2'
    ]);
});

test('the serialized XML wraps items as <Items><ShipmentItem>', () => {
    const xml = buildSoapEnvelope('ShipmentCreationRequest', {
        Shipments: { Shipment: [buildShipment(neutral(), fallbacks)] }
    });
    assert.match(xml, /<Items><ShipmentItem><PackageType>Box<\/PackageType>/);
    assert.equal((xml.match(/<Items>/g) || []).length, 1);
});

test('every missing field is listed, so ops can see what to fix', () => {
    const input = neutral();
    input.customer.address.city = '';
    input.warehouse.address.line1 = '';
    assert.throws(
        () => buildShipment(input, fallbacks),
        (error) =>
            error.code === 'invalid_shipment' &&
            error.missing.includes('customer.address.city') &&
            error.missing.includes('warehouse.address.line1')
    );
});