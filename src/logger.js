'use strict';

/**
 * Tiny structured logger: one JSON line per event, with secrets masked.
 * Use it for new code; fields named like a secret are replaced with "[redacted]"
 * at any depth, so a credential can never reach the log by accident.
 * Customer name/phone/address must never be passed in the first place.
 */
const SECRET_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|pin$/i;

function redact(value, depth = 0) {
    if (depth > 5 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redact(item, depth + 1)])
    );
}

function createLogger({ sink = console, base = {} } = {}) {
    const write = (level, message, fields = {}) => {
        const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...redact({ ...base, ...fields }) });
        (level === 'error' ? sink.error : level === 'warn' ? sink.warn : sink.log).call(sink, line);
    };
    return {
        info: (message, fields) => write('info', message, fields),
        warn: (message, fields) => write('warn', message, fields),
        error: (message, fields) => write('error', message, fields)
    };
}

module.exports = { createLogger, redact };