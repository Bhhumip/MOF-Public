
'use strict';

const { MongoClient } = require('mongodb');

function createMongoJobStore({
    uri,
    databaseName = 'mof_return_orchestration',
    collectionName = 'return_jobs',
    clientOptions = {}
} = {}) {
    if (typeof uri !== 'string' || !uri.trim()) {
        throw new Error('A MongoDB connection URI is required');
    }

    if (typeof databaseName !== 'string' || !databaseName.trim()) {
        throw new Error('A MongoDB database name is required');
    }

    const client = new MongoClient(uri, clientOptions);

    let collectionPromise = null;
    let closed = false;
    let closePromise = null;

    async function getCollection() {
        if (closed) {
            throw new Error('MongoDB job store is closed');
        }

        if (!collectionPromise) {
            collectionPromise = (async () => {
                await client.connect();

                const collection = client
                    .db(databaseName)
                    .collection(collectionName);

                await collection.createIndex(
                    { key: 1 },
                    { unique: true, name: 'unique_job_key' }
                );

                return collection;
            })().catch((error) => {
                collectionPromise = null;
                throw error;
            });
        }

        return collectionPromise;
    }

    function toJob(document) {
        if (!document) return null;

        return {
            ...document.data,
            key: document.key,
            status: document.status,
            createdAt: document.createdAt,
            updatedAt: document.updatedAt
        };
    }

    return {
        async claim(key, data = {}) {
            if (typeof key !== 'string' || !key.trim()) {
                throw new Error('A non-empty job key is required');
            }

            const collection = await getCollection();
            const now = new Date().toISOString();

            const document = {
                key,
                data: { ...data },
                status: 'processing',
                createdAt: now,
                updatedAt: now
            };

            try {
                await collection.insertOne(document);

                return {
                    claimed: true,
                    job: toJob(document)
                };
            } catch (error) {
                if (error?.code !== 11000) {
                    throw error;
                }

                // Another request already claimed this key.
                // Return the existing job without overwriting it.
                const existing = await collection.findOne({ key });

                if (!existing) {
                    throw new Error(
                        'Duplicate job key was reported, but the existing job could not be read'
                    );
                }

                return {
                    claimed: false,
                    job: toJob(existing)
                };
            }
        },

        // Validates update input, updates an existing job, and returns its latest state.
        async update(key, patch) {
            if (typeof key !== 'string' || !key.trim()) {
                throw new Error('A non-empty job key is required');
            }

            if (
                patch === null ||
                typeof patch !== 'object' ||
                Array.isArray(patch)
            ) {
                throw new Error('Job update patch must be an object');
            }


            for (const field of Object.keys(patch)) {
                if (field.includes('.') || field.startsWith('$')) {
                    throw new Error(`Invalid job field name: ${field}`);
                }
            }


            const collection = await getCollection();
            const { status, ...rest } = patch;
            const now = new Date().toISOString();

            const fields = {
                updatedAt: now
            };

            for (const [field, value] of Object.entries(rest)) {
                fields[`data.${field}`] = value;
            }

            if (status !== undefined) {
                fields.status = status;
            }

            const result = await collection.updateOne(
                { key },
                { $set: fields }
            );

            if (result.matchedCount === 0) {
                throw new Error(`Unknown job: ${key}`);
            }

            const updatedDocument = await collection.findOne({ key });

            return toJob(updatedDocument);
        },

        async get(key) {
            const collection = await getCollection();
            const document = await collection.findOne({ key });

            return toJob(document);
        },

        async list() {
            const collection = await getCollection();

            const documents = await collection
                .find({})
                .sort({ createdAt: 1, key: 1 })
                .toArray();

            return documents.map(toJob);
        },

        // Ensures concurrent close() calls wait for the same shutdown operation.
        close() {
            if (!closePromise) {
                closed = true;

                closePromise = (async () => {
                    if (collectionPromise) {
                        try {
                            await collectionPromise;
                        } catch {
                            // Initialization failed; still close the client.
                        }
                    }

                    await client.close();
                })();
            }

            return closePromise;
        }
    };
}

module.exports = { createMongoJobStore };
