'use strict';

/**
 * Wait for specified milliseconds.
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = { wait };
