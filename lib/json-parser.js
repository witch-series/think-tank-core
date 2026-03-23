'use strict';

/**
 * Robust JSON extraction and repair for LLM outputs.
 * Handles common issues from lightweight models: trailing commas,
 * comments, unquoted keys, control characters, etc.
 */

/**
 * Extract the first balanced JSON object from text using brace-depth counting.
 * More accurate than greedy regex for text containing multiple JSON-like fragments.
 */
function extractBalancedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let prevEscape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (prevEscape) { prevEscape = false; continue; }
    if (ch === '\\' && inString) { prevEscape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Repair common JSON errors from lightweight LLM outputs.
 */
function repairJson(str) {
  if (!str || typeof str !== 'string') return str;

  // Remove BOM
  str = str.replace(/^\uFEFF/, '');

  // Remove JavaScript-style line comments (outside strings)
  // Process character by character to avoid breaking strings
  let result = '';
  let inStr = false;
  let escape = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escape) {
      result += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && inStr) {
      result += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      result += ch;
      continue;
    }
    if (!inStr) {
      // Line comment
      if (ch === '/' && str[i + 1] === '/') {
        const nl = str.indexOf('\n', i);
        i = nl === -1 ? str.length : nl;
        continue;
      }
      // Block comment
      if (ch === '/' && str[i + 1] === '*') {
        const end = str.indexOf('*/', i + 2);
        i = end === -1 ? str.length : end + 1;
        continue;
      }
    }
    result += ch;
  }
  str = result;

  // Remove trailing commas before } or ]
  str = str.replace(/,\s*([}\]])/g, '$1');

  // Remove control characters except \n \r \t (outside strings, but safe enough globally)
  str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  // Fix unquoted keys: match patterns like { key: or , key:
  // Only fix simple cases to avoid false positives
  str = str.replace(/([\{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

  // Fix single-quoted strings used as values (simple cases)
  // Replace 'value' with "value" when in value position (after : or in arrays)
  str = str.replace(/(:\s*)'([^']*?)'/g, '$1"$2"');
  str = str.replace(/([\[,]\s*)'([^']*?)'/g, '$1"$2"');

  return str;
}

/**
 * Parse JSON from LLM response text with progressive repair strategies.
 * Returns the parsed object, or null if all strategies fail.
 */
function parseJsonSafe(text) {
  if (!text || typeof text !== 'string') return null;
  text = text.trim();

  // Step 1: Try balanced extraction + direct parse (fast path)
  const balanced = extractBalancedJson(text);
  if (balanced) {
    try { return JSON.parse(balanced); } catch {}
    // Step 2: Try repair on the balanced extraction
    try { return JSON.parse(repairJson(balanced)); } catch {}
  }

  // Step 3: Try the greedy regex approach + repair
  const greedyMatch = text.match(/\{[\s\S]*\}/);
  if (greedyMatch) {
    try { return JSON.parse(greedyMatch[0]); } catch {}
    try { return JSON.parse(repairJson(greedyMatch[0])); } catch {}
  }

  // Step 4: Try finding simple non-nested JSON objects
  const simpleMatches = text.match(/\{[^{}]*\}/g);
  if (simpleMatches) {
    for (const s of simpleMatches) {
      try { return JSON.parse(s); } catch {}
      try { return JSON.parse(repairJson(s)); } catch {}
    }
  }

  return null;
}

/**
 * Parse JSON and validate against expected schema.
 * Fills in missing fields with defaults and checks required fields.
 * @param {string} text - LLM response text
 * @param {object} schema - { required: string[], defaults: object }
 * @returns {object|null} Parsed and validated object, or null
 */
function parseJsonWithSchema(text, schema) {
  const parsed = parseJsonSafe(text);
  if (!parsed || typeof parsed !== 'object') return null;

  // Fill in missing fields with defaults
  if (schema.defaults) {
    for (const [key, defaultVal] of Object.entries(schema.defaults)) {
      if (parsed[key] === undefined) parsed[key] = defaultVal;
    }
  }

  // Check required fields
  if (schema.required) {
    for (const key of schema.required) {
      if (parsed[key] === undefined || parsed[key] === null) return null;
    }
  }

  return parsed;
}

module.exports = { extractBalancedJson, repairJson, parseJsonSafe, parseJsonWithSchema };
