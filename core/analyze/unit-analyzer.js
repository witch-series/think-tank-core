'use strict';

const fs = require('fs');
const { extractFunctions, extractFunctionBody } = require('../../lib/analyzer');
const { validateCode } = require('../../lib/configurator');
const { fillPrompt } = require('../../lib/prompt-loader');
const { parseJsonSafe } = require('../../lib/json-parser');

/**
 * Unit Analyzer: analyzes each function in a file individually via LLM.
 */

/**
 * Analyze all functions in a file.
 *
 * @param {object} client - OllamaClient instance
 * @param {string} filePath - Path to the .js file
 * @param {function} [log] - Optional logger function(level, message)
 * @returns {Promise<Array>} Array of function analysis objects
 */
const analyzeUnits = async (client, filePath, log) => {
  const code = fs.readFileSync(filePath, 'utf-8');
  const functions = extractFunctions(code);

  if (functions.length === 0) return [];

  const systemPrompt = fillPrompt('analyze-unit.system', {});
  const results = [];

  for (let i = 0; i < functions.length; i++) {
    const func = functions[i];
    const body = extractFunctionBody(code, func.index, functions, i);

    try {
      const userPrompt = fillPrompt('analyze-unit.user', {
        functionName: func.name,
        params: func.params || '(none)',
        filePath,
        functionBody: body
      });

      const response = await client.query(userPrompt, systemPrompt, {
        json: true,
        priority: false
      });

      const text = (response.response || '').trim();
      const parsed = parseJsonSafe(text);

      // Security check on the function body
      const security = validateCode(body);

      const result = {
        name: func.name,
        params: func.params || '',
        purpose: parsed?.purpose || '',
        inputs: parsed?.inputs || {},
        returns: parsed?.returns || '',
        sideEffects: Array.isArray(parsed?.sideEffects) ? parsed.sideEffects : [],
        calls: Array.isArray(parsed?.calls) ? parsed.calls : [],
        errorHandling: parsed?.errorHandling || false,
        security: {
          valid: security.valid,
          issues: security.issues
        }
      };

      results.push(result);

      if (log) log('debug', `Unit analysis: ${func.name} in ${filePath}`);
    } catch (err) {
      // Skip failed function, continue with next
      if (log) log('warn', `Unit analysis failed for ${func.name} in ${filePath}: ${err.message}`);

      results.push({
        name: func.name,
        params: func.params || '',
        purpose: '',
        inputs: {},
        returns: '',
        sideEffects: [],
        calls: [],
        errorHandling: false,
        security: validateCode(body)
      });
    }
  }

  return results;
}

module.exports = { analyzeUnits };
