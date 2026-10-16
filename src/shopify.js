'use strict';

const GET_ORDER_SHIPPING = `
  query GetOrderShipping($id: ID!) {
    order(id: $id) {
      id
      name
      tags
      shippingLines(first: 10) {
        nodes {
          id
          title
          code
          source
          carrierIdentifier
          custom
        }
      }
    }
  }
`;


const GET_RETURN_CONTEXT = `
  query GetReturnContext($id: ID!) {
    return(id: $id) {
      id
      status
      order { id name tags }
      reverseFulfillmentOrders(first: 10) { nodes { id status } }
    }
  }
`;

const GET_RETURN_SHIPMENT_DETAILS = `
  query GetReturnShipmentDetails($id: ID!) {
    return(id: $id) {
      id
      order {
        id
        name
        email
        phone
        shippingAddress { name company address1 address2 city province zip countryCodeV2 phone }
        fulfillments(first: 10) {  trackingInfo(first: 3) { number company }  
        fulfillmentLineItems(first: 50) { nodes { lineItem { id } } 
        } }
        fulfillmentOrders(first: 10) {
          nodes {
            id
            assignedLocation { name address1 address2 city province zip countryCode phone }
            lineItems(first: 50) { nodes { lineItem { id } } }
          }
        }
      }
      reverseFulfillmentOrders(first: 10) {
        nodes {
          id
          lineItems(first: 50) {
            nodes { totalQuantity fulfillmentLineItem { lineItem { id sku name  weight { unit value }} } }
          }
        }
      }
    }
  }
`;


const REVERSE_DELIVERY_CREATE_WITH_SHIPPING = `
  mutation ReverseDeliveryCreateWithShipping(
    $reverseFulfillmentOrderId: ID!
    $reverseDeliveryLineItems: [ReverseDeliveryLineItemInput!]!
    $trackingInput: ReverseDeliveryTrackingInput
    $labelInput: ReverseDeliveryLabelInput
    $notifyCustomer: Boolean
  ) {
    reverseDeliveryCreateWithShipping(
      reverseFulfillmentOrderId: $reverseFulfillmentOrderId
      reverseDeliveryLineItems: $reverseDeliveryLineItems
      trackingInput: $trackingInput
      labelInput: $labelInput
      notifyCustomer: $notifyCustomer
    ) {
      reverseDelivery { id }
      userErrors { field message }
    }
  }
`;
const RETURN_SHIPMENT_TYPE = '$app:return_shipment';

const UPSERT_RETURN_SHIPMENT = `
  mutation UpsertReturnShipment($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message code }
    }
  }
`;

const GET_ORDER_RETURN_SHIPMENTS = `
  query GetOrderReturnShipments($id: ID!) {
    order(id: $id) { id metafield(namespace: "$app", key: "return_shipments") { value } }
  }
`;

const SET_ORDER_RETURN_SHIPMENTS = `
  mutation SetOrderReturnShipments($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`;

const GET_RFO_LINE_ITEMS = `
  query GetRfoLineItems($id: ID!) {
    reverseFulfillmentOrder(id: $id) {
      id
      lineItems(first: 50) { nodes { id totalQuantity dispositions { quantity type } } }
    }
  }`;

const REVERSE_FULFILLMENT_ORDER_DISPOSE = `
  mutation Dispose($dispositionInputs: [ReverseFulfillmentOrderDisposeInput!]!) {
    reverseFulfillmentOrderDispose(dispositionInputs: $dispositionInputs) {
      reverseFulfillmentOrderLineItems { id totalQuantity dispositions { quantity type } }
      userErrors { field message }
    }
  }`;

const ADD_TAGS = `
  mutation AddTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { message }
    }
  }
`;

function toOrderGid(orderId) {
  const value = String(orderId ?? '').trim();
  if (!value) throw new Error('An order ID is required');
  return value.startsWith('gid://') ? value : `gid://shopify/Order/${value}`;
}

function createShopifyClient({ storeDomain, adminAccessToken, apiVersion, fetchImpl = globalThis.fetch }) {
  const endpoint = `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`;

  async function query(document, variables = {}) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': adminAccessToken
      },
      body: JSON.stringify({ query: document, variables })
    });

    const payload = await response.json();

    if (!response.ok || payload.errors) {
      const message = Array.isArray(payload.errors)
        ? payload.errors.map((error) => error.message).join('; ')
        : `Shopify Admin GraphQL request failed with status ${response.status}`;
      throw new Error(message);
    }
    return payload.data;
  }

  async function getOrderShipping(orderId) {
    const data = await query(GET_ORDER_SHIPPING, { id: toOrderGid(orderId) });
    if (!data.order) throw new Error(`Order not found: ${orderId}`);
    return {
      id: data.order.id,
      name: data.order.name,
      tags: data.order.tags,
      shippingLines: data.order.shippingLines.nodes
    };
  }


  async function getReturnContext(returnId) {
    const id = String(returnId ?? '').trim();
    if (!id) throw new Error('A return ID is required');
    const data = await query(GET_RETURN_CONTEXT, { id });
    if (!data.return) return null; // not found, or not readable by this app
    return {
      returnId: data.return.id,
      status: data.return.status,
      order: {
        id: data.return.order.id,
        name: data.return.order.name,
        tags: data.return.order.tags
      },
      reverseFulfillmentOrders: data.return.reverseFulfillmentOrders.nodes
    };

  }
  // Writes the carrier booking back to Shopify. An empty line-item list makes
  // Shopify create a line item for every item on the RFO (full quantity).
  async function createReverseDeliveryWithShipping({
    reverseFulfillmentOrderId,
    trackingInput = null,
    labelInput = null,
    notifyCustomer = false,
    reverseDeliveryLineItems = []
  } = {}) {
    const id = String(reverseFulfillmentOrderId ?? '').trim();
    if (!id) throw new Error('A reverse fulfillment order ID is required');

    // Shopify accepts only number + url for tracking and fileUrl for the label.
    const tracking = trackingInput?.number
      ? {
        number: String(trackingInput.number),
        ...(trackingInput.url ? { url: trackingInput.url } : {})
      }
      : null;
    const label = labelInput?.fileUrl ? { fileUrl: labelInput.fileUrl } : null;

    const data = await query(REVERSE_DELIVERY_CREATE_WITH_SHIPPING, {
      reverseFulfillmentOrderId: id,
      reverseDeliveryLineItems,
      trackingInput: tracking,
      labelInput: label,
      notifyCustomer: Boolean(notifyCustomer)
    });

    const result = data.reverseDeliveryCreateWithShipping;
    if (result.userErrors?.length) {
      throw new Error(
        `reverseDeliveryCreateWithShipping failed: ${result.userErrors.map((e) => e.message).join('; ')}`
      );
    }
    return result.reverseDelivery;
  }

  // One record per Reverse Fulfillment Order. Upsert = create or update by handle, safe to repeat.
  async function upsertReturnShipmentRecord(handle, fields) {
    const list = Object.entries(fields)
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
      .map(([key, value]) => ({ key, value: String(value) }));
    const data = await query(UPSERT_RETURN_SHIPMENT, {
      handle: { type: RETURN_SHIPMENT_TYPE, handle },
      metaobject: { fields: list }
    });
    const result = data.metaobjectUpsert;
    if (result.userErrors?.length) {
      throw new Error(`metaobjectUpsert failed: ${result.userErrors.map((e) => e.message).join('; ')}`);
    }
    return result.metaobject;
  }

  // Adds the record to the order's list of return shipments (no duplicates).
  async function linkReturnShipmentToOrder(orderId, metaobjectId) {
    const data = await query(GET_ORDER_RETURN_SHIPMENTS, { id: toOrderGid(orderId) });
    if (!data.order) throw new Error(`Order not found: ${orderId}`);
    let ids = [];
    try { ids = JSON.parse(data.order.metafield?.value || '[]'); } catch { ids = []; }
    if (!Array.isArray(ids)) ids = [];
    if (ids.includes(metaobjectId)) return { changed: false };

    const result = (await query(SET_ORDER_RETURN_SHIPMENTS, {
      metafields: [{
        ownerId: data.order.id,
        namespace: '$app',
        key: 'return_shipments',
        type: 'list.metaobject_reference',
        value: JSON.stringify([...ids, metaobjectId])
      }]
    })).metafieldsSet;
    if (result.userErrors?.length) {
      throw new Error(`metafieldsSet failed: ${result.userErrors.map((e) => e.message).join('; ')}`);
    }
    return { changed: true };
  }

  async function restockReverseFulfillmentOrder({ reverseFulfillmentOrderId, locationId }) {
    if (!locationId) throw new Error('A restock location ID is required');
    const data = await query(GET_RFO_LINE_ITEMS, { id: reverseFulfillmentOrderId });
    const nodes = data.reverseFulfillmentOrder?.lineItems?.nodes || [];
    const dispositionInputs = nodes
      .map((n) => ({
        reverseFulfillmentOrderLineItemId: n.id,
        quantity: n.totalQuantity - n.dispositions.reduce((sum, d) => sum + d.quantity, 0),
        dispositionType: 'RESTOCKED',
        locationId
      }))
      .filter((i) => i.quantity > 0);
    if (!dispositionInputs.length) return { restocked: 0 };
    const result = (await query(REVERSE_FULFILLMENT_ORDER_DISPOSE, { dispositionInputs })).reverseFulfillmentOrderDispose;
    if (result.userErrors?.length) throw new Error(`reverseFulfillmentOrderDispose failed: ${result.userErrors.map((e) => e.message).join('; ')}`);
    return { restocked: dispositionInputs.length };
  }

  async function addOrderTags(orderId, tags) {
    const data = await query(ADD_TAGS, { id: toOrderGid(orderId), tags });
    const errors = data.tagsAdd.userErrors;
    if (errors?.length) throw new Error(`tagsAdd failed: ${errors.map((e) => e.message).join('; ')}`);
  }
  return { endpoint, query, getOrderShipping, getReturnContext, getReturnShipmentDetails, createReverseDeliveryWithShipping, upsertReturnShipmentRecord, linkReturnShipmentToOrder, restockReverseFulfillmentOrder, addOrderTags };


  async function getReturnShipmentDetails(returnId) {
    const id = String(returnId ?? '').trim();
    if (!id) throw new Error('A return ID is required');
    const data = await query(GET_RETURN_SHIPMENT_DETAILS, { id });
    const ret = data.return;
    if (!ret) return null;

    return {
      returnId: ret.id,
      order: {
        id: ret.order.id,
        name: ret.order.name,
        email: ret.order.email,
        phone: ret.order.phone,
        shippingAddress: ret.order.shippingAddress,
        fulfillments: (ret.order.fulfillments || []).map((fulfillment) => ({
          trackingInfo: (fulfillment.trackingInfo || []).map((t) => ({ number: t.number, company: t.company })),
          lineItemIds: (fulfillment.fulfillmentLineItems?.nodes || []).map((n) => n.lineItem?.id).filter(Boolean)
        })),
        fulfillmentOrders: ret.order.fulfillmentOrders.nodes.map((fo) => ({
          id: fo.id,
          assignedLocation: fo.assignedLocation,
          lineItemIds: fo.lineItems.nodes.map((item) => item.lineItem.id)
        }))
      },
      reverseFulfillmentOrders: ret.reverseFulfillmentOrders.nodes.map((rfo) => ({
        id: rfo.id,
        lineItems: rfo.lineItems.nodes.map((item) => ({
          lineItemId: item.fulfillmentLineItem?.lineItem?.id ?? null,
          sku: item.fulfillmentLineItem?.lineItem?.sku ?? null,
          name: item.fulfillmentLineItem?.lineItem?.name ?? '',
          quantity: item.totalQuantity,
          weight: item.fulfillmentLineItem?.lineItem?.weight ?? null
        }))
      }))
    };
  }

}

module.exports = { createShopifyClient, toOrderGid, GET_ORDER_SHIPPING, ADD_TAGS };