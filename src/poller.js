'use strict';

const { createLogger } = require('./logger');

/**
 * Runs `task` every `intervalMs`. A new run never starts while the previous one
 * is still running, a throwing task cannot kill the timer, and the timer does
 * not keep the process alive on its own.
 * Run this on ONE server instance only, or every instance will poll Aramex.
 */
function createPoller({ task, intervalMs, runOnStart = true, logger = createLogger() }) {
    if (!(intervalMs >= 1000)) throw new Error('Poll interval must be at least 1000 ms');
    let timer = null;
    let running = false;

    async function tick() {
        if (running) return;
        running = true;
        try {
            await task();
        } catch (error) {
            logger.error('poller task failed', { error: error.message });
        } finally {
            running = false;
        }
    }

    return {
        tick,
        start() {
            if (timer) return;
            timer = setInterval(tick, intervalMs);
            timer.unref?.();
            if (runOnStart) setImmediate(tick);
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = null;
        },
        get active() {
            return timer !== null;
        }
    };
}

module.exports = { createPoller };