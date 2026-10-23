// Copies MemoMind's SDK files into plugin/vendor/ from a local clone of
// https://github.com/memomind-open/plugin-open-platform. They aren't committed
// here because MemoMind's terms don't allow republishing them.
//
// Usage: node scripts/fetch-vendor.mjs /path/to/plugin-open-platform
//    or: MEMOMIND_SDK=/path/to/plugin-open-platform node scripts/fetch-vendor.mjs

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = 'PhoneSDK/examples/talking-pet/vendor';
const FILES = [
  'gm-plugin-web-sdk.esm.js',
  'opus-decoder.esm.js',
  'opus-decoder-LICENSE.txt',
];

function fail(message) {
  console.error(`fetch-vendor: ${message}`);
  process.exit(1);
}

const sdkArg = process.argv[2] || process.env.MEMOMIND_SDK;
if (!sdkArg) {
  fail(
    'no SDK path given.\n' +
    '  Clone https://github.com/memomind-open/plugin-open-platform, then run\n' +
    '  npm run vendor -- /path/to/plugin-open-platform\n' +
    '  or set MEMOMIND_SDK=/path/to/plugin-open-platform.'
  );
}

const sdkRoot = resolve(sdkArg);
if (!existsSync(sdkRoot) || !statSync(sdkRoot).isDirectory()) {
  fail(`SDK path not found or not a folder: ${sdkRoot}`);
}

const sourceDir = join(sdkRoot, SOURCE_DIR);
const missing = FILES.filter((name) => !existsSync(join(sourceDir, name)));
if (missing.length > 0) {
  fail(
    `missing in ${sourceDir}:\n` +
    missing.map((name) => `  - ${name}`).join('\n') +
    '\n  Is this a clone of memomind-open/plugin-open-platform?'
  );
}

const targetDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'vendor');
mkdirSync(targetDir, { recursive: true });
for (const name of FILES) {
  copyFileSync(join(sourceDir, name), join(targetDir, name));
  console.log(`copied ${name}`);
}
console.log(`fetch-vendor: ${FILES.length} files copied to ${resolve(targetDir)}`);
