import fs from 'node:fs';
import path from 'node:path';
import pkg from '../package.json';
import { updateDocsVersionLabel, updateReadmeVersionBadge } from './versionMetadata';

const root = path.resolve(__dirname, '..');
const readmePath = path.join(root, 'README.md');
const docsIndexPath = path.join(root, 'docs', 'index.html');
const version = pkg.version;

// Calculate both updates before writing either file, so a missing marker cannot
// leave the README and documentation website with different versions.
const readme = updateReadmeVersionBadge(fs.readFileSync(readmePath, 'utf8'), version);
const docsIndex = updateDocsVersionLabel(fs.readFileSync(docsIndexPath, 'utf8'), version);

fs.writeFileSync(readmePath, readme);
fs.writeFileSync(docsIndexPath, docsIndex);

console.log(`README badge and docs/index.html version updated to ${version}`);
