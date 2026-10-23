// Builds dist/reply-assist.mmpkg with MemoMind's packager. Works on any OS
// (npm runs scripts through cmd.exe on Windows, which can't expand $VARS).
//
// Usage: npm run build -- /path/to/plugin-open-platform
//    or: MEMOMIND_SDK=/path/to/plugin-open-platform npm run build

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

const sdkArg = process.argv[2] || process.env.MEMOMIND_SDK;
if (!sdkArg) {
  fail(
    'no SDK path given.\n' +
    '  npm run build -- /path/to/plugin-open-platform\n' +
    '  or set MEMOMIND_SDK=/path/to/plugin-open-platform.'
  );
}

const packager = join(resolve(sdkArg), 'PhoneSDK', 'tools', 'build-mmpkg.mjs');
if (!existsSync(packager)) {
  fail(`packager not found: ${packager}\n  Is this a clone of memomind-open/plugin-open-platform?`);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  process.execPath,
  [packager, 'plugin', join('dist', 'reply-assist.mmpkg')],
  { cwd: root, stdio: 'inherit' }
);
process.exit(result.status ?? 1);
