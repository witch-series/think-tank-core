'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function clearDir(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let count = 0;
  for (const file of fs.readdirSync(dirPath)) {
    const filePath = path.join(dirPath, file);
    if (fs.statSync(filePath).isDirectory()) {
      count += clearDir(filePath);
      fs.rmdirSync(filePath);
    } else {
      fs.unlinkSync(filePath);
      count++;
    }
  }
  return count;
}

const dirs = ['brain/research', 'brain/analysis', 'brain/work-logs', 'brain/modules'];

for (const dir of dirs) {
  const absPath = path.resolve(ROOT, dir);
  const count = clearDir(absPath);
  console.log(`Cleared: ${dir} (${count} files)`);
}

const visitedPath = path.resolve(ROOT, 'brain/visited-urls.json');
if (fs.existsSync(visitedPath)) {
  fs.unlinkSync(visitedPath);
  console.log('Cleared: brain/visited-urls.json');
}

console.log('\nReset complete. All research data, modules, and work logs have been cleared.');
