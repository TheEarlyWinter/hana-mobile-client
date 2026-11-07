/* 审计门禁清单（ALLOWLIST）与磁盘的同步元测试。
 *
 * 背景：tests/support/run-audit-safe-tests.mjs 的清单是人工维护的固定子集，运行时不扫描
 * 目录。曾经为了「不漏掉任何测试」把清单从 107 条扩到 156 条，结果门禁变得又慢又依赖环境
 * （要起网关、单例 20~40 秒），整段被回退。现在的分工是：
 *   - ALLOWLIST 保持轻量，只收快速、离线、稳定的入口；
 *   - EXEMPTIONS 逐个登记未纳入门禁的文件，并写明分组理由；
 *   - 本文件负责「不许静默漏掉」：磁盘上每个 tests/*.test.mjs 必须被显式归类。
 *
 * 断言：清单条目在磁盘上存在；清单无重复且按 .sort() 排序；豁免条目存在、不在清单里、
 * 理由非空、无重复；自动发现集减去清单与豁免的差集为空；--list 的 count= 与清单条数一致。
 *
 * 全部只做目录扫描和两次只读子进程（--manifest / --list），不跑任何被测用例。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TESTS_DIR = path.join(ROOT, 'tests');
const RUNNER = path.join(TESTS_DIR, 'support', 'run-audit-safe-tests.mjs');
const RUNNER_REL = 'tests/support/run-audit-safe-tests.mjs';
const SELF = 'tests/audit_manifest_sync.test.mjs';
const RUNNER_TIMEOUT_MS = 60_000;

function runRunner(flag) {
  const run = spawnSync(process.execPath, [RUNNER, flag], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: RUNNER_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(
    run.error,
    undefined,
    `${RUNNER_REL} ${flag} 启动失败：${run.error?.message ?? ''}`,
  );
  assert.equal(
    run.status,
    0,
    `${RUNNER_REL} ${flag} 退出码 ${run.status}（${flag} 分支不能跑测试）：\n${run.stderr ?? ''}`,
  );
  return run.stdout ?? '';
}

/** 读清单的唯一入口：runner 的 --manifest 只读出口。 */
function readManifest() {
  const raw = runRunner('--manifest');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    assert.fail(`${RUNNER_REL} --manifest 输出不是 JSON：${error.message}\n${raw.slice(0, 400)}`);
  }
  assert.ok(Array.isArray(parsed.allowlist), '--manifest 必须带 allowlist 数组');
  assert.ok(Array.isArray(parsed.exemptions), '--manifest 必须带 exemptions 数组');
  return parsed;
}

/** 与 scripts/run-all-tests.mjs 同口径：tests/ 下（不递归）所有 *.test.mjs。 */
function discoverTests() {
  return fs
    .readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `tests/${name}`)
    .sort();
}

const manifest = readManifest();
const allowlist = manifest.allowlist;
const exemptions = manifest.exemptions;
const allowSet = new Set(allowlist);
const exemptionSet = new Set(exemptions.map((entry) => entry.file));
const onDisk = discoverTests();
const diskSet = new Set(onDisk);

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

function duplicatesOf(list) {
  const seen = new Set();
  const dupes = [];
  for (const item of list) {
    if (seen.has(item)) {
      if (!dupes.includes(item)) dupes.push(item);
    } else {
      seen.add(item);
    }
  }
  return dupes;
}

t('--list 的 count= 与清单条数一致，且逐条打印的就是清单', () => {
  const lines = runRunner('--list').split('\n').filter((line) => line !== '');
  const countLine = lines.at(-1) ?? '';
  const printed = lines.slice(0, -1);
  const match = /^count=(\d+)$/.exec(countLine);

  assert.ok(
    match,
    `${RUNNER_REL} --list 末行应为 count=N，实际是 ${JSON.stringify(countLine)}`,
  );
  assert.equal(
    Number(match[1]),
    allowlist.length,
    `--list 的 count=${match[1]} 与清单实际条数 ${allowlist.length} 不一致；`
      + `count= 由 ALLOWLIST.length 直接算出，出现偏差说明有人手改了输出或清单被拆成了两份`,
  );
  assert.deepEqual(
    printed,
    allowlist,
    '--list 逐行打印的入口必须与 --manifest 的 allowlist 完全一致（顺序也一致）',
  );
});

t('清单无重复且按 .sort() 排序', () => {
  const dupes = duplicatesOf(allowlist);
  assert.deepEqual(
    dupes,
    [],
    `清单有重复条目：${dupes.join('、')}；同一文件只需一条，删掉多余的（${RUNNER_REL}）`,
  );

  const sorted = [...allowlist].sort();
  const misplaced = allowlist
    .map((file, index) => (file === sorted[index] ? null : `${file}（第 ${index + 1} 行，应为 ${sorted[index]}）`))
    .filter(Boolean);
  assert.deepEqual(
    misplaced,
    [],
    `清单没有按 .sort() 排序（UTF-16 顺序），位置不对的条目：${misplaced.join('；')}；`
      + `整段重新排一次，元测试和 --list 都依赖这个顺序`,
  );
});

t('清单里每一条在磁盘上都存在（没有改名/删除留下的死条目）', () => {
  const missing = allowlist.filter((file) => !diskSet.has(file));
  assert.deepEqual(
    missing,
    [],
    `清单里有磁盘上不存在的条目：${missing.join('、')}；`
      + `如果测试被改名或删除，把这一条从 ALLOWLIST 同步删掉（${RUNNER_REL}）`,
  );
});

t('豁免名单每条理由非空、无重复、文件存在且不在清单里', () => {
  const blank = exemptions
    .filter((entry) => typeof entry.reason !== 'string' || entry.reason.trim() === '')
    .map((entry) => entry.file);
  assert.deepEqual(
    blank,
    [],
    `豁免条目缺理由：${blank.join('、')}；每条豁免都要写清「为什么不能进快速离线门禁」`
      + `（例如需要真实网关进程 / 依赖 PowerShell 与网络 / 需要真机或 Android SDK）`,
  );

  const dupes = duplicatesOf(exemptions.map((entry) => entry.file));
  assert.deepEqual(dupes, [], `豁免名单有重复条目：${dupes.join('、')}；同一文件只登记一次`);

  const missing = exemptions.map((entry) => entry.file).filter((file) => !diskSet.has(file));
  assert.deepEqual(
    missing,
    [],
    `豁免名单里有磁盘上不存在的条目：${missing.join('、')}；`
      + `豁免项复活或改名后要同步删掉，否则它会悄悄盖住同名的真实测试`,
  );

  const alive = exemptions.map((entry) => entry.file).filter((file) => allowSet.has(file));
  assert.deepEqual(
    alive,
    [],
    `这些文件同时在清单和豁免名单里：${alive.join('、')}；`
      + `已经把入口加进 ALLOWLIST 的，要从 EXEMPTIONS 删掉（${RUNNER_REL}）`,
  );
});

t('自动发现集减去清单与豁免后为空（新增测试必须显式归类）', () => {
  const unclassified = onDisk.filter((file) => !allowSet.has(file) && !exemptionSet.has(file));
  assert.deepEqual(
    unclassified,
    [],
    `这些测试文件既不在 ALLOWLIST 也不在 EXEMPTIONS：${unclassified.join('、')}；`
      + `快速离线稳定的加进 ALLOWLIST（保持 .sort() 顺序），需要网关/浏览器/PowerShell/真机的`
      + `加进 EXEMPTIONS 并写明分组理由（${RUNNER_REL}）。`
      + `不能放着不管：留空档等于让门禁静默漏掉新测试`,
  );
});

t('本元测试已登记在清单里（自我登记）', () => {
  assert.ok(
    allowSet.has(SELF),
    `${SELF} 必须出现在 ALLOWLIST 里：元测试自己不跑，就不能保证清单被守住`,
  );
  assert.ok(diskSet.has(SELF), `${SELF} 必须真实存在于磁盘上`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

console.log(
  `\n清单 ${allowlist.length} 条、豁免 ${exemptions.length} 条、磁盘 ${onDisk.length} 个 tests/*.test.mjs`,
);
if (failed) {
  console.log(`${failed} 个用例失败`);
  process.exitCode = 1;
}
