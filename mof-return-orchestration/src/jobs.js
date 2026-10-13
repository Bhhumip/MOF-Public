'use strict';

/**
 * Job store contract (an in-memory implementation now, SQLite later):
 *   claim(key, data) -> { claimed: true, job }  first time this key is seen
 *                       { claimed: false, job } the key already exists
 *   update(key, patch), get(key), list()
 * The key is "rfo:<ReverseFulfillmentOrder id>".
 */
function createMemoryJobStore() {
    const jobs = new Map();

    return {
        async claim(key, data = {}) {
            if (jobs.has(key)) return { claimed: false, job: jobs.get(key) };
            const now = new Date().toISOString();
            const job = { key, ...data, status: 'processing', createdAt: now, updatedAt: now };
            jobs.set(key, job);
            return { claimed: true, job };
        },
        async update(key, patch) {
            const job = jobs.get(key);
            if (!job) throw new Error(`Unknown job: ${key}`);
            Object.assign(job, patch, { updatedAt: new Date().toISOString() });
            return job;
        },
        async get(key) {
            return jobs.get(key) || null;
        },
        async list() {
            return [...jobs.values()];
        }
    };
}

module.exports = { createMemoryJobStore };