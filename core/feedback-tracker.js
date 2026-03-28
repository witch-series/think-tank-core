'use strict';

const fs = require('fs');
const path = require('path');

const FEEDBACK_PATH = path.resolve(__dirname, '..', 'brain', 'feedback.json');
const MAX_ENTRIES = 200;

/**
 * Load feedback history from disk.
 * @returns {Array<{action: string, topic: string, success: boolean, reason?: string, timestamp: string}>}
 */
function loadFeedback() {
  try {
    if (fs.existsSync(FEEDBACK_PATH)) {
      return JSON.parse(fs.readFileSync(FEEDBACK_PATH, 'utf-8'));
    }
  } catch {}
  return [];
}

/**
 * Save feedback history to disk.
 */
function saveFeedback(entries) {
  const dir = path.dirname(FEEDBACK_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Keep only recent entries
  const trimmed = entries.slice(-MAX_ENTRIES);
  fs.writeFileSync(FEEDBACK_PATH, JSON.stringify(trimmed, null, 2), 'utf-8');
}

/**
 * Record the outcome of an action.
 *
 * @param {string} action - Action type (research, develop, execute, test, etc.)
 * @param {string} topic - What was attempted
 * @param {boolean} success - Whether the action succeeded
 * @param {string} [reason] - Reason for failure or success details
 */
function recordOutcome(action, topic, success, reason) {
  try {
    const entries = loadFeedback();
    entries.push({
      action,
      topic: (topic || '').slice(0, 200),
      success,
      reason: (reason || '').slice(0, 300),
      timestamp: new Date().toISOString()
    });
    saveFeedback(entries);
  } catch (e) {
    // Feedback is non-critical — don't let it break the loop
  }
}

/**
 * Get statistics about action outcomes.
 *
 * @returns {{ byAction: Object, recentFailures: Array, successRate: number }}
 */
function getStats() {
  let entries;
  try {
    entries = loadFeedback();
  } catch (e) {
    return { byAction: {}, recentFailures: [], successRate: 1.0, totalActions: 0 };
  }
  if (entries.length === 0) {
    return { byAction: {}, recentFailures: [], successRate: 1.0, totalActions: 0 };
  }

  // Per-action stats
  const byAction = {};
  for (const e of entries) {
    if (!byAction[e.action]) byAction[e.action] = { total: 0, success: 0 };
    byAction[e.action].total++;
    if (e.success) byAction[e.action].success++;
  }

  // Overall success rate
  const total = entries.length;
  const successes = entries.filter(e => e.success).length;

  // Recent failures (last 24h)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recentFailures = entries
    .filter(e => !e.success && new Date(e.timestamp).getTime() > cutoff)
    .map(e => `${e.action}: ${e.topic} — ${e.reason}`)
    .slice(-5);

  return {
    byAction,
    recentFailures,
    successRate: Math.round((successes / total) * 100) / 100,
    totalActions: total
  };
}

/**
 * Get a summary string suitable for including in LLM prompts.
 */
function getFeedbackSummary() {
  const stats = getStats();
  if (stats.totalActions === 0) return '';

  const lines = [`成功率: ${Math.round(stats.successRate * 100)}% (${stats.totalActions}件)`];

  for (const [action, data] of Object.entries(stats.byAction)) {
    const rate = data.total > 0 ? Math.round((data.success / data.total) * 100) : 0;
    lines.push(`  ${action}: ${rate}% (${data.success}/${data.total})`);
  }

  if (stats.recentFailures.length > 0) {
    lines.push('直近の失敗:');
    for (const f of stats.recentFailures) {
      lines.push(`  - ${f}`);
    }
  }

  return lines.join('\n');
}

/**
 * Check if a specific action type has a high failure rate.
 * Returns true if the action has failed more than 60% in recent attempts.
 *
 * @param {string} action - Action type to check
 * @param {number} [recentN=5] - How many recent attempts to consider
 * @returns {boolean}
 */
function isActionUnreliable(action, recentN = 5) {
  const entries = loadFeedback().filter(e => e.action === action);
  if (entries.length < 3) return false; // not enough data

  const recent = entries.slice(-recentN);
  const failures = recent.filter(e => !e.success).length;
  return failures / recent.length > 0.6;
}

module.exports = {
  recordOutcome,
  getStats,
  getFeedbackSummary,
  isActionUnreliable
};
