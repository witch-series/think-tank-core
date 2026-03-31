'use strict';

const { validateSyntax } = require('../../lib/sandbox');

/**
 * Code formatter: converts var → const/let, function declarations → arrow functions.
 * Uses regex-based transforms with syntax validation before/after.
 */

/**
 * Check if a position is inside a string literal or comment.
 * Returns an array of "safe" ranges where code (not strings/comments) lives.
 */
const buildCodeRanges = (code) => {
  const ranges = [];
  let i = 0;
  let rangeStart = 0;

  while (i < code.length) {
    // Single-line comment
    if (code[i] === '/' && code[i + 1] === '/') {
      if (i > rangeStart) ranges.push([rangeStart, i]);
      const end = code.indexOf('\n', i);
      i = end === -1 ? code.length : end + 1;
      rangeStart = i;
      continue;
    }
    // Multi-line comment
    if (code[i] === '/' && code[i + 1] === '*') {
      if (i > rangeStart) ranges.push([rangeStart, i]);
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
      rangeStart = i;
      continue;
    }
    // Template literal
    if (code[i] === '`') {
      if (i > rangeStart) ranges.push([rangeStart, i]);
      i++;
      while (i < code.length && code[i] !== '`') {
        if (code[i] === '\\') i++;
        i++;
      }
      i++; // skip closing backtick
      rangeStart = i;
      continue;
    }
    // String literals
    if (code[i] === '"' || code[i] === "'") {
      const quote = code[i];
      if (i > rangeStart) ranges.push([rangeStart, i]);
      i++;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') i++;
        i++;
      }
      i++; // skip closing quote
      rangeStart = i;
      continue;
    }
    i++;
  }
  if (rangeStart < code.length) ranges.push([rangeStart, code.length]);
  return ranges;
}

const isInCodeRange = (ranges, pos) => {
  for (const [start, end] of ranges) {
    if (pos >= start && pos < end) return true;
    if (start > pos) break;
  }
  return false;
}

/**
 * Check if a function body uses `arguments` keyword.
 */
const usesArguments = (body) => {
  return /\barguments\b/.test(body);
}

/**
 * Check if a function body uses `this` keyword.
 */
const usesThis = (body) => {
  return /\bthis\b/.test(body);
}

/**
 * Convert `var` declarations to `const` or `let`.
 */
const convertVarDeclarations = (code, codeRanges) => {
  const changes = [];
  const varPattern = /\bvar\s+(\w+)\s*/g;
  let match;

  while ((match = varPattern.exec(code)) !== null) {
    if (!isInCodeRange(codeRanges, match.index)) continue;

    const varName = match[1];
    // Check if variable is reassigned after declaration
    const afterDecl = code.slice(match.index + match[0].length);
    const reassignPattern = new RegExp(`\\b${varName}\\s*=[^=]|\\b${varName}\\s*\\+\\+|\\b${varName}\\s*--|--\\s*${varName}\\b|\\+\\+\\s*${varName}\\b|\\b${varName}\\s*[+\\-*/|&^%]?=`, 'g');

    // Simple heuristic: if the variable appears in a reassignment pattern, use let
    const isReassigned = reassignPattern.test(afterDecl);
    const replacement = isReassigned ? 'let' : 'const';

    changes.push({
      index: match.index,
      length: 3, // 'var'.length
      replacement,
      description: `var ${varName} → ${replacement} ${varName}`
    });
  }

  // Apply changes in reverse order to preserve indices
  let result = code;
  for (const change of changes.sort((a, b) => b.index - a.index)) {
    result = result.slice(0, change.index) + change.replacement + result.slice(change.index + change.length);
  }

  return { code: result, changes };
}

/**
 * Convert function declarations to arrow functions.
 * Skips: generators, constructors, methods, functions using `this` or `arguments`.
 */
function convertFunctionDeclarations(code, codeRanges) {
  const changes = [];

  // Match: function name(params) { ... }
  // But not inside class bodies or object literals (method shorthand)
  const funcPattern = /^(\s*)function\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
  let match;

  while ((match = funcPattern.exec(code)) !== null) {
    if (!isInCodeRange(codeRanges, match.index)) continue;

    const indent = match[1];
    const name = match[2];
    const params = match[3];

    // Skip generator functions
    if (/function\s*\*/.test(match[0])) continue;

    // Find the matching closing brace
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findMatchingBrace(code, bodyStart - 1);
    if (bodyEnd === -1) continue;

    const body = code.slice(bodyStart, bodyEnd);

    // Skip if uses `this` or `arguments`
    if (usesThis(body) || usesArguments(body)) continue;

    // Skip if the function name starts with uppercase (likely constructor)
    if (name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()) continue;

    const fullMatch = code.slice(match.index, bodyEnd + 1);
    const replacement = `${indent}const ${name} = (${params}) => {${body}}`;

    changes.push({
      index: match.index,
      length: fullMatch.length,
      replacement,
      description: `function ${name} → const ${name} = arrow`
    });
  }

  // Also convert: async function name(params) { ... }
  const asyncFuncPattern = /^(\s*)async\s+function\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;

  while ((match = asyncFuncPattern.exec(code)) !== null) {
    if (!isInCodeRange(codeRanges, match.index)) continue;

    const indent = match[1];
    const name = match[2];
    const params = match[3];

    const bodyStart = match.index + match[0].length;
    const bodyEnd = findMatchingBrace(code, bodyStart - 1);
    if (bodyEnd === -1) continue;

    const body = code.slice(bodyStart, bodyEnd);

    if (usesThis(body) || usesArguments(body)) continue;
    if (name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()) continue;

    const fullMatch = code.slice(match.index, bodyEnd + 1);
    const replacement = `${indent}const ${name} = async (${params}) => {${body}}`;

    changes.push({
      index: match.index,
      length: fullMatch.length,
      replacement,
      description: `async function ${name} → const ${name} = async arrow`
    });
  }

  // Filter out nested changes (inner functions contained within outer function ranges)
  // Keep only outermost — inner functions will be converted on next pass
  changes.sort((a, b) => a.index - b.index);
  const filtered = [];
  for (const change of changes) {
    const end = change.index + change.length;
    const isNested = filtered.some(c => change.index > c.index && end <= c.index + c.length);
    if (!isNested) filtered.push(change);
  }

  // Apply changes in reverse order to preserve indices
  let result = code;
  for (const change of filtered.sort((a, b) => b.index - a.index)) {
    result = result.slice(0, change.index) + change.replacement + result.slice(change.index + change.length);
  }

  return { code: result, changes: filtered };
}

/**
 * Find the matching closing brace for an opening brace.
 */
const findMatchingBrace = (code, openPos) => {
  if (code[openPos] !== '{') return -1;

  let depth = 1;
  let i = openPos + 1;

  while (i < code.length && depth > 0) {
    const ch = code[i];

    // Skip strings
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }

    // Skip comments
    if (ch === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      i = end === -1 ? code.length : end + 1;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }

    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }

  return depth === 0 ? i - 1 : -1;
}

/**
 * Format a JavaScript file's source code.
 *
 * @param {string} code - Source code
 * @returns {{ code: string, changes: Array, success: boolean, error?: string }}
 */
const formatCode = (code) => {
  // Validate original syntax first
  const originalCheck = validateSyntax(code);
  if (!originalCheck.valid) {
    return { code, changes: [], success: false, error: `Original code has syntax error: ${originalCheck.error}` };
  }

  const allChanges = [];
  let formatted = code;

  // Step 1: Convert var → const/let
  const codeRanges = buildCodeRanges(formatted);
  const varResult = convertVarDeclarations(formatted, codeRanges);
  formatted = varResult.code;
  allChanges.push(...varResult.changes);

  // Step 2: Convert function declarations → arrow functions (multi-pass for nested)
  const MAX_PASSES = 5;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const ranges = buildCodeRanges(formatted);
    const funcResult = convertFunctionDeclarations(formatted, ranges);
    if (funcResult.changes.length === 0) break;
    formatted = funcResult.code;
    allChanges.push(...funcResult.changes);
  }

  // Validate transformed syntax
  const transformedCheck = validateSyntax(formatted);
  if (!transformedCheck.valid) {
    // Rollback: return original code
    return {
      code,
      changes: [],
      success: false,
      error: `Syntax error after formatting: ${transformedCheck.error}`
    };
  }

  return {
    code: formatted,
    changes: allChanges,
    success: true
  };
}

module.exports = { formatCode, buildCodeRanges, findMatchingBrace };
