import { mkdir, cp, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await mkdir('release', { recursive: true });
const stage = 'release/open-extension';
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp('dist', `${stage}/extension`, { recursive: true });
await cp('README.md', `${stage}/README.md`);
await cp('LICENSE', `${stage}/LICENSE`);
await rm('release/open-extension-chrome.zip', { force: true });
execFileSync('zip', ['-qr', 'open-extension-chrome.zip', 'open-extension'], {
  cwd: 'release',
});
const project = 'release/open-extension-project';
await rm(project, { recursive: true, force: true });
await mkdir(project, { recursive: true });
for (const item of [
  'src',
  'scripts',
  'public',
  'tests',
  'dist',
  'README.md',
  'LICENSE',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vitest.config.ts',
  'playwright.config.ts',
  '.gitignore',
  '.prettierrc.json',
  '.github',
])
  await cp(item, `${project}/${item}`, { recursive: true });
await rm('release/open-extension-project.zip', { force: true });
execFileSync('zip', ['-qr', 'open-extension-project.zip', 'open-extension-project'], {
  cwd: 'release',
});
console.log('Packaged release/open-extension-chrome.zip and release/open-extension-project.zip');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await cp('release/open-extension-project.zip', `release/open-extension-project-v${version}.zip`);
await cp('release/open-extension-chrome.zip', `release/open-extension-chrome-v${version}.zip`);
