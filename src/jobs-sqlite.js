'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Durable job store with the same contract as createMemoryJobStore.
 * One row per key ("rfo:<id>"); free-form job data is kept as JSON.
 */
function createSqliteJobStore(filePath = ':memory:') {
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const db = new DatabaseSync(filePath);

    db.exec(`
    CREATE TABLE IF NOT EXISTS return_jobs (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

    const insert = db.prepare(
        'INSERT OR IGNORE INTO return_jobs (key, data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    );
    const select = db.prepare('SELECT * FROM return_jobs WHERE key = ?');
    const update = db.prepare('UPDATE return_jobs SET data = ?, status = ?, updated_at = ? WHERE key = ?');
    const all = db.prepare('SELECT * FROM return_jobs ORDER BY created_at, key');

    function toJob(row) {
        if (!row) return null;
        return {
            ...JSON.parse(row.data),
            key: row.key,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    return {
        async claim(key, data = {}) {
            const now = new Date().toISOString();
            // INSERT OR IGNORE makes the first writer win; the primary key decides.
            const result = insert.run(key, JSON.stringify(data), 'processing', now, now);
            return { claimed: result.changes === 1, job: toJob(select.get(key)) };
        },
        async update(key, patch) {
            const row = select.get(key);
            if (!row) throw new Error(`Unknown job: ${key}`);
            const { status, ...rest } = patch;
            const data = { ...JSON.parse(row.data), ...rest };
            update.run(JSON.stringify(data), status ?? row.status, new Date().toISOString(), key);
            return toJob(select.get(key));
        },
        async get(key) {
            const row = select.get(key);
            return row ? toJob(row) : null;
        },
        async list() {
            return all.all().map(toJob);
        },
        close() {
            db.close();
        }
    };
}

module.exports = { createSqliteJobStore };