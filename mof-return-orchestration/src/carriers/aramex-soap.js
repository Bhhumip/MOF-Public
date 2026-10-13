'use strict';

const SOAP_NAMESPACE = 'http://schemas.xmlsoap.org/soap/envelope/';
const ARAMEX_NAMESPACE = 'http://ws.aramex.net/ShippingAPI/v1/';

const SOAP_ACTIONS = Object.freeze({
    CreateShipments:
        `${ARAMEX_NAMESPACE}Service_1_0/CreateShipments`,
    PrintLabel:
        `${ARAMEX_NAMESPACE}Service_1_0/PrintLabel`
});

class AramexSoapError extends Error {
    constructor(message, { operation, status, body } = {}) {
        super(message);
        this.name = 'AramexSoapError';
        this.operation = operation;
        this.status = status;
        this.body = body;
    }
}

// Escapes XML reserved characters so shipment values cannot break the document.
function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Serializes objects in insertion order and repeats element names for arrays.
function serializeXmlElement(name, value) {
    if (value === undefined || value === null) {
        return '';
    }

    if (Array.isArray(value)) {
        return value
            .map((item) => serializeXmlElement(name, item))
            .join('');
    }

    if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
    ) {
        return `<${name}>${escapeXml(value)}</${name}>`;
    }

    if (typeof value !== 'object') {
        throw new TypeError(`Unsupported XML value for element "${name}"`);
    }

    const children = Object.entries(value)
        .map(([childName, childValue]) =>
            serializeXmlElement(childName, childValue)
        )
        .join('');

    return children
        ? `<${name}>${children}</${name}>`
        : `<${name}/>`;
}

// Wraps the request payload in a SOAP 1.1 envelope and the Aramex namespace.
function buildSoapEnvelope(requestWrapper, payload) {
    // const requestXml = serializeXmlElement(requestWrapper, payload);

    return [
        '<?xml version="1.0" encoding="utf-8"?>',
        `<soap:Envelope xmlns:soap="${SOAP_NAMESPACE}">`,
        '<soap:Header/>',
        '<soap:Body>',
        `<${requestWrapper} xmlns="${ARAMEX_NAMESPACE}">`,
        Object.entries(payload)
            .map(([key, value]) => serializeXmlElement(key, value))
            .join(''),
        `</${requestWrapper}>`,
        '</soap:Body>',
        '</soap:Envelope>'
    ].join('');
}

// Extracts a SOAP fault message without assuming a particular namespace prefix.
function getSoapFaultMessage(xml) {
    const fault = xml.match(
        /<(?:[\w.-]+:)?Fault\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Fault\s*>/i
    );

    if (!fault) {
        return null;
    }

    const reason = fault[1].match(
        /<(?:[\w.-]+:)?(?:faultstring|Text)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?(?:faultstring|Text)\s*>/i
    );

    return reason
        ? reason[1].replace(/<[^>]+>/g, '').trim()
        : 'Aramex returned a SOAP fault';
}

function createAramexSoapTransport({
    endpoint,
    fetchImpl = globalThis.fetch,
    timeoutMs = 20000
} = {}) {
    if (typeof endpoint !== 'string' || !endpoint.trim()) {
        throw new Error('Aramex SOAP transport requires an endpoint');
    }

    if (typeof fetchImpl !== 'function') {
        throw new Error('Aramex SOAP transport requires a fetch implementation');
    }

    const baseUrl = endpoint.replace(/\/+$/, '');

    return {
        async call(operation, requestWrapper, payload) {
            const soapAction = SOAP_ACTIONS[operation];

            if (!soapAction) {
                throw new Error(`Unsupported Aramex SOAP operation: ${operation}`);
            }

            const xml = buildSoapEnvelope(requestWrapper, payload);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const response = await fetchImpl(baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/xml; charset=utf-8',
                        Accept: 'text/xml',
                        SOAPAction: `"${soapAction}"`
                    },
                    body: xml,
                    signal: controller.signal
                });

                const body = await response.text();
                const faultMessage = getSoapFaultMessage(body);

                if (!response.ok) {
                    throw new AramexSoapError(
                        `Aramex ${operation} failed with HTTP ${response.status}`,
                        { operation, status: response.status, body }
                    );
                }

                if (faultMessage) {
                    throw new AramexSoapError(
                        `Aramex ${operation} SOAP fault: ${faultMessage}`,
                        { operation, status: response.status, body }
                    );
                }

                return body;
            } finally {
                clearTimeout(timer);
            }
        }
    };
}

module.exports = {
    SOAP_NAMESPACE,
    ARAMEX_NAMESPACE,
    SOAP_ACTIONS,
    AramexSoapError,
    escapeXml,
    serializeXmlElement,
    buildSoapEnvelope,
    getSoapFaultMessage,
    createAramexSoapTransport
};
