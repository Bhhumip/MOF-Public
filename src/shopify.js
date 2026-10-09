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
            nodes { totalQuantity fulfillmentLineItem { lineItem { id sku name } } }
          }
        }
      }
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
  return { endpoint, query, getOrderShipping, getReturnContext, getReturnShipmentDetails };


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
          quantity: item.totalQuantity
        }))
      }))
    };
  }

}

module.exports = { createShopifyClient, toOrderGid, GET_ORDER_SHIPPING };