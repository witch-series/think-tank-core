'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Ensure a directory exists, creating it recursively if needed.
 * @param {string} dirPath - Directory path to ensure
 */
const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

/**
 * Load and parse a JSON file, returning a default value on failure.
 * @param {string} filePath - Path to JSON file
 * @param {*} defaultValue - Value to return if file doesn't exist or parse fails
 * @returns {*} Parsed JSON or defaultValue
 */
const loadJsonFile = (filePath, defaultValue = null) => {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {}
  return defaultValue;
};

/**
 * Save data as JSON to a file, ensuring the parent directory exists.
 * @param {string} filePath - Path to write
 * @param {*} data - Data to serialize
 * @param {boolean} [pretty=true] - Whether to pretty-print
 */
const saveJsonFile = (filePath, data, pretty = true) => {
  ensureDir(path.dirname(filePath));
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  fs.writeFileSync(filePath, content, 'utf-8');
};

module.exports = { ensureDir, loadJsonFile, saveJsonFile };
