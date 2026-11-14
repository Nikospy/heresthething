#!/usr/bin/env node
/**
 * Checks what `npm publish` would upload, before it does.
 *
 * Usage: node scripts/check-pack.mjs [package-dir]
 *
 * Fails when the tarball holds anything besides package.json, README.md, LICENSE and the
 * entries in "files", when a listed file is missing, when the bin target is not executable,
 * or when package.json declares runtime dependencies or install-time scripts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '.');
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const problems = [];

for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
  const value = pkg[field];
  if (value !== undefined && (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0)) {
    problems.push(`package.json has ${field}; the package must have no runtime dependencies`);
  }
}
for (const script of ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare']) {
  if (pkg.scripts?.[script] !== undefined) problems.push(`package.json has an install-time script "${script}"`);
}
if (!Array.isArray(pkg.files) || pkg.files.length === 0) problems.push('package.json must list its files explicitly');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const [report] = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8' }));
const packed = new Map(report.files.map(f => [f.path, f]));
const expected = new Set(['package.json', 'README.md', 'LICENSE', ...(pkg.files ?? [])]);

for (const path of packed.keys()) if (!expected.has(path)) problems.push(`unexpected file in the tarball: ${path}`);
for (const path of expected) if (!packed.has(path)) problems.push(`missing from the tarball: ${path}`);
for (const target of Object.values(pkg.bin ?? {})) {
  const file = packed.get(String(target).replace(/^\.\//, ''));
  if (file === undefined) problems.push(`bin target is not in the tarball: ${target}`);
  else if ((file.mode & 0o111) === 0) problems.push(`bin target is not executable: ${target}`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-pack: ${problem}`);
  process.exit(1);
}
console.log(`check-pack: ${report.name}@${report.version}, ${report.files.length} files, ${report.size} bytes packed`);
for (const path of [...packed.keys()].sort()) console.log(`  ${path}`);
