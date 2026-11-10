/* scripts/version.mjs 的版本镜像契约（I4-5）：只有一个来源 package.json，
 * 另外三处（AndroidManifest 的 versionName/versionCode、lockfile 的两处根版本）都是镜像。
 *
 * 只测纯函数 + 读真实 package-lock.json（只读，不写仓库）：
 *   - 幂等：当前版本跑一遍，文件一个字节都不该变（不能因为改版本就整份重排）；
 *   - 最小改动：换版本时只有那两行根 version 变，依赖版本/integrity 一个都不许动；
 *   - 缺 packages[""] 直接失败，不产出半份文件。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  computeVersionCode,
  getVersion,
  lockPath,
  manifestPath,
  rewriteLockVersion,
} = await import('../scripts/version.mjs');

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

/** 依赖条目（name → version），根条目 `""` 除外：它就是本项目的镜像。 */
function dependencyVersions(lockText) {
  const parsed = JSON.parse(lockText);
  const out = {};
  for (const [name, entry] of Object.entries(parsed.packages || {})) {
    if (name === '') continue;
    if (entry && typeof entry.version === 'string') out[name] = entry.version;
  }
  return out;
}

t('versionCode = major*10000 + minor*100 + patch（manifest 的码就是它算的）', () => {
  assert.equal(computeVersionCode('0.9.10'), 910);
  assert.equal(computeVersionCode('1.2.3'), 10203);
  assert.equal(computeVersionCode('0.9'), 900, '0.9 规范成 0.9.0');
});

t('真实 lockfile：当前版本幂等，一个字节都不变', () => {
  const text = fs.readFileSync(lockPath, 'utf8');
  assert.equal(rewriteLockVersion(text, getVersion()), text, '同版本改写必须是无操作');
});

t('真实 lockfile：换版本只动两处根版本，依赖版本与字段顺序不动', () => {
  const text = fs.readFileSync(lockPath, 'utf8');
  const next = rewriteLockVersion(text, '1.2.3');

  const before = text.split('\n');
  const after = next.split('\n');
  assert.equal(after.length, before.length, '行数不能变（否则就是重排了整个文件）');

  const changed = [];
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] !== after[i]) changed.push([i + 1, before[i], after[i]]);
  }
  assert.equal(changed.length, 2, `只有两处根版本该变，实际：${JSON.stringify(changed)}`);
  for (const [, was, now] of changed) {
    assert.match(was, /"version": "(?!1\.2\.3$)[^"]*"/, '改前该是旧版本');
    assert.match(now, /"version": "1\.2\.3"/, '改后该是新版本');
  }

  const parsed = JSON.parse(next);
  assert.equal(parsed.version, '1.2.3', '顶层根版本');
  assert.equal(parsed.packages[''].version, '1.2.3', 'packages[""] 根版本');
  assert.deepEqual(dependencyVersions(next), dependencyVersions(text), '依赖版本一个都不许动');
});

t('packages[""] 里不是根版本时不误改（依赖条目的 version 保持原样）', () => {
  const synthetic = [
    '{',
    '  "name": "hana-mobile",',
    '  "version": "0.9.10",',
    '  "lockfileVersion": 3,',
    '  "requires": true,',
    '  "packages": {',
    '    "": {',
    '      "name": "hana-mobile",',
    '      "version": "0.9.10"',
    '    },',
    '    "node_modules/dep": {',
    '      "version": "9.9.9"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

  const next = rewriteLockVersion(synthetic, '0.9.11');
  const parsed = JSON.parse(next);
  assert.equal(parsed.version, '0.9.11');
  assert.equal(parsed.packages[''].version, '0.9.11');
  assert.equal(parsed.packages['node_modules/dep'].version, '9.9.9', '依赖版本不能跟着改');
});

t('缺 packages[""] 的 lockfile 直接失败，不产出半份结果', () => {
  const broken = '{\n  "name": "hana-mobile",\n  "version": "0.9.10",\n  "lockfileVersion": 3\n}\n';
  assert.throws(() => rewriteLockVersion(broken, '0.9.11'), /packages\[""\]/);
});

t('不是合法 lockfile 文本时直接失败', () => {
  assert.throws(() => rewriteLockVersion('not json at all\n', '0.9.11'));
});

t('仓库里 manifest 与 lockfile 都是 package.json 的当前版本（漂了就说明没跑 version:set）', () => {
  const version = getVersion();
  const code = String(computeVersionCode(version));

  const manifest = fs.readFileSync(manifestPath, 'utf8');
  const manifestName = /android:versionName="([^"]*)"/.exec(manifest);
  const manifestCode = /android:versionCode="(\d+)"/.exec(manifest);
  assert.ok(manifestName && manifestCode, 'manifest 里必须有 versionName / versionCode');
  assert.equal(manifestName[1], version, `AndroidManifest.xml 的 versionName 落后于 package.json（跑 npm run version:set -- ${version}）`);
  assert.equal(manifestCode[1], code, `AndroidManifest.xml 的 versionCode 落后于 package.json（跑 npm run version:set -- ${version}）`);

  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(lock.version, version, 'lockfile 顶层根版本落后（跑 npm run version:set）');
  assert.equal(lock.packages[''].version, version, 'lockfile packages[""] 根版本落后（跑 npm run version:set）');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

if (failed) {
  console.log(`\n${failed} 个用例失败`);
  process.exitCode = 1;
}
