import fs from 'fs';
import path from 'path';
import pkg from '../package.json';

const readmePath = path.resolve(__dirname, '../README.md');

let content = fs.readFileSync(readmePath, 'utf8');

content = content.replace(
  /badge\/version-[\d.]+-blue\.svg/,
  `badge/version-${pkg.version}-blue.svg`
);

fs.writeFileSync(readmePath, content);

console.log(`README version updated to ${pkg.version}`);
