'use strict';

const fs = require('fs');
const path = require('path');
const { loadPrompt, fillPrompt } = require('../lib/prompt-loader');

const GOALS_PATH = path.resolve(__dirname, '..', 'brain', 'goals.json');

/**
 * Load the current goal state from disk.
 * @returns {{ finalGoal: string, subtasks: Array<{id: string, description: string, status: string, type: string, result?: string, attempts: number, createdAt: string, completedAt?: string}>, decomposedAt: string|null }}
 */
function loadGoals() {
  try {
    if (fs.existsSync(GOALS_PATH)) {
      return JSON.parse(fs.readFileSync(GOALS_PATH, 'utf-8'));
    }
  } catch {}
  return { finalGoal: '', subtasks: [], decomposedAt: null };
}

/**
 * Save goal state to disk.
 */
function saveGoals(goals) {
  const dir = path.dirname(GOALS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(GOALS_PATH, JSON.stringify(goals, null, 2), 'utf-8');
}

/**
 * Decompose a high-level goal into subtasks using LLM.
 * Only re-decomposes if the goal text has changed.
 *
 * @param {object} client - OllamaClient
 * @param {string} goalText - The user's final goal
 * @param {object} context - { knowledgeCount, moduleCount, graphNodeCount, existingFiles }
 * @param {object} [options] - { model }
 * @returns {Promise<object>} The updated goals object
 */
async function decomposeGoal(client, goalText, context, options = {}) {
  const goals = loadGoals();

  // Skip if goal hasn't changed and we already have subtasks
  if (goals.finalGoal === goalText && goals.subtasks.length > 0) {
    return goals;
  }

  const prompt = fillPrompt('decompose-goal.user', {
    goal: goalText,
    knowledgeCount: String(context.knowledgeCount || 0),
    moduleCount: String(context.moduleCount || 0),
    graphNodeCount: String(context.graphNodeCount || 0),
    existingFiles: context.existingFiles || 'なし',
    completedTasks: goals.subtasks
      .filter(t => t.status === 'completed')
      .map(t => `- ${t.description}`)
      .join('\n') || 'なし'
  });

  const systemPrompt = loadPrompt('decompose-goal.system');
  const response = await client.query(prompt, systemPrompt, { model: options.model });
  const text = (response.response || '').trim();

  let parsed;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch {}

  if (!parsed || !Array.isArray(parsed.subtasks)) {
    return goals; // Keep existing if LLM fails
  }

  // Preserve completed subtasks from previous decomposition
  const completedIds = new Set(
    goals.subtasks.filter(t => t.status === 'completed').map(t => t.id)
  );

  const now = new Date().toISOString();
  const newSubtasks = parsed.subtasks.map((t, i) => {
    const id = `goal-${i + 1}`;
    const existing = goals.subtasks.find(e => e.id === id && completedIds.has(id));
    if (existing) return existing; // preserve completed

    return {
      id,
      description: t.description || t.task || '',
      type: t.type || 'research', // research, develop, test, deploy
      status: 'pending',
      dependencies: t.dependencies || [],
      attempts: 0,
      createdAt: now
    };
  });

  const updated = {
    finalGoal: goalText,
    subtasks: newSubtasks,
    decomposedAt: now
  };

  saveGoals(updated);
  return updated;
}

/**
 * Get the next actionable subtask.
 * Respects dependencies: a task is actionable only if all its dependencies are completed.
 *
 * @returns {{ subtask: object|null, progress: { total: number, completed: number, inProgress: number } }}
 */
function getNextSubtask() {
  const goals = loadGoals();
  const completedIds = new Set(
    goals.subtasks.filter(t => t.status === 'completed').map(t => t.id)
  );

  const total = goals.subtasks.length;
  const completed = completedIds.size;
  const inProgress = goals.subtasks.filter(t => t.status === 'in_progress').length;

  // Find first pending task whose dependencies are all completed
  for (const task of goals.subtasks) {
    if (task.status !== 'pending') continue;
    const deps = task.dependencies || [];
    const depsOk = deps.every(d => completedIds.has(d));
    if (depsOk) {
      return { subtask: task, progress: { total, completed, inProgress } };
    }
  }

  // Also check in_progress tasks that may need retry
  for (const task of goals.subtasks) {
    if (task.status === 'in_progress' && task.attempts < 3) {
      return { subtask: task, progress: { total, completed, inProgress } };
    }
  }

  return { subtask: null, progress: { total, completed, inProgress } };
}

/**
 * Update a subtask's status.
 */
function updateSubtask(taskId, updates) {
  const goals = loadGoals();
  const task = goals.subtasks.find(t => t.id === taskId);
  if (!task) return false;

  if (updates.status) task.status = updates.status;
  if (updates.result) task.result = updates.result;
  if (updates.status === 'in_progress') task.attempts = (task.attempts || 0) + 1;
  if (updates.status === 'completed') task.completedAt = new Date().toISOString();

  saveGoals(goals);
  return true;
}

/**
 * Re-evaluate goal progress and potentially re-decompose if stuck.
 *
 * @param {object} client - OllamaClient
 * @param {object} [options] - { model }
 * @returns {Promise<object>} Updated goals with assessment
 */
async function evaluateProgress(client, options = {}) {
  const goals = loadGoals();
  if (goals.subtasks.length === 0) return goals;

  const completed = goals.subtasks.filter(t => t.status === 'completed');
  const failed = goals.subtasks.filter(t => t.attempts >= 3 && t.status !== 'completed');
  const pending = goals.subtasks.filter(t => t.status === 'pending');

  // If there are failed tasks, ask LLM for alternative approaches
  if (failed.length > 0) {
    const prompt = fillPrompt('evaluate-goal.user', {
      goal: goals.finalGoal,
      completed: completed.map(t => `- ${t.description}: ${t.result || 'OK'}`).join('\n') || 'なし',
      failed: failed.map(t => `- ${t.description} (${t.attempts}回試行)`).join('\n'),
      pending: pending.map(t => `- ${t.description}`).join('\n') || 'なし'
    });

    try {
      const response = await client.query(prompt, loadPrompt('decompose-goal.system'), { model: options.model });
      const text = (response.response || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.replacements && Array.isArray(parsed.replacements)) {
          // Replace failed tasks with new alternatives
          for (const rep of parsed.replacements) {
            const failedTask = goals.subtasks.find(t => t.id === rep.replaces);
            if (failedTask) {
              failedTask.description = rep.description;
              failedTask.type = rep.type || failedTask.type;
              failedTask.status = 'pending';
              failedTask.attempts = 0;
              failedTask.result = null;
            }
          }
          saveGoals(goals);
        }
      }
    } catch {}
  }

  return goals;
}

/**
 * Get goal summary for display / prompt context.
 */
function getGoalSummary() {
  const goals = loadGoals();
  if (!goals.finalGoal) return null;

  const total = goals.subtasks.length;
  const completed = goals.subtasks.filter(t => t.status === 'completed').length;
  const inProgress = goals.subtasks.filter(t => t.status === 'in_progress').length;
  const failed = goals.subtasks.filter(t => t.attempts >= 3 && t.status !== 'completed').length;

  return {
    finalGoal: goals.finalGoal,
    progress: `${completed}/${total}`,
    percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
    inProgress,
    failed,
    subtasks: goals.subtasks.map(t => ({
      id: t.id,
      description: t.description,
      type: t.type,
      status: t.status,
      attempts: t.attempts
    }))
  };
}

module.exports = {
  loadGoals,
  saveGoals,
  decomposeGoal,
  getNextSubtask,
  updateSubtask,
  evaluateProgress,
  getGoalSummary
};
