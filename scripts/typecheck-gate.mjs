#!/usr/bin/env node
/**
 * 类型检查闸门：锁住「每个文件的 typecheck 错误数」，只允许变少。
 *
 * 为什么不做「零错误才过」：项目里有 800 多条 `@param {object}` 泛化造成的历史错误，
 * 一刀切的门槛只会被人用 `continue-on-error` 绕过去。这里改成棘轮（ratchet）：
 *   - 总数比基线多 → 失败；
 *   - 任何文件的错误数比基线多 → 失败（新文件带错误也算）；
 *   - 变少 → 通过，并提示可以更新基线。
 *
 * 用法：
 *   node scripts/typecheck-gate.mjs             检查（CI 用）
 *   node scripts/typecheck-gate.mjs --update    把当前结果写成新基线
 *   node scripts/typecheck-gate.mjs --json      机器可读输出
 *
 * 基线文件：docs/typecheck-baseline.json（随仓库提交，故意放在 docs 下，改它要过 review）。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(repoRoot, 'docs', 'typecheck-baseline.json');
const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

const args = process.argv.slice(2);
const update = args.includes('--update');
const asJson = args.includes('--json');

/** 跑 tsc，返回原始输出。退出码非 0 是正常的（有类型错误），只要不是崩溃。 */
function runTsc() {
  if (!fs.existsSync(tscBin)) {
    console.error('找不到本地 typescript：先跑 npm install');
    process.exit(2);
  }
  const result = spawnSync(process.execPath, [tscBin, '-p', 'jsconfig.json', '--pretty', 'false'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  // 1 = 有错误，0 = 没错误；其它值当崩溃处理。
  if (result.status !== 0 && result.status !== 1) {
    console.error(out.trim() || `tsc 异常退出：${result.status}`);
    process.exit(2);
  }
  return out;
}

/** 解析 `web/x.js(12,3): error TS2339: ...`，按文件聚合条数。 */
export function parseErrors(output) {
  const files = {};
  let total = 0;
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^(.+?)\((\d+),(\d+)\):\s*error\s+TS\d+:/u.exec(line.trim());
    if (!match) continue;
    const file = match[1].replace(/\\/g, '/').replace(/^\.\//, '');
    files[file] = (files[file] || 0) + 1;
    total += 1;
  }
  return { total, files };
}

function readBaseline() {
  try {
    const parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    if (typeof parsed?.total !== 'number' || typeof parsed?.files !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function main() {
  const current = parseErrors(runTsc());

  if (update) {
    const payload = {
      // 基线的含义写在这里，别让人以为这是「允许的错误数」
      note: 'typecheck 棘轮基线：只允许每个文件的错误数下降。由 scripts/typecheck-gate.mjs --update 生成。',
      updatedAt: new Date().toISOString().slice(0, 10),
      total: current.total,
      files: Object.fromEntries(Object.entries(current.files).sort(([a], [b]) => a.localeCompare(b))),
    };
    fs.writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`基线已更新：${current.total} 条 / ${Object.keys(current.files).length} 个文件`);
    return;
  }

  const baseline = readBaseline();
  if (!baseline) {
    console.error(`缺少或损坏的基线：${path.relative(repoRoot, baselinePath)}`);
    console.error('首次接入请先跑：node scripts/typecheck-gate.mjs --update');
    process.exit(2);
  }

  const regressions = [];
  for (const [file, count] of Object.entries(current.files)) {
    const before = baseline.files[file] || 0;
    if (count > before) regressions.push({ file, before, after: count });
  }
  const improvements = [];
  for (const [file, before] of Object.entries(baseline.files)) {
    const after = current.files[file] || 0;
    if (after < before) improvements.push({ file, before, after });
  }

  if (asJson) {
    console.log(JSON.stringify({ total: current.total, baselineTotal: baseline.total, regressions, improvements }, null, 2));
  } else {
    console.log(`typecheck: ${current.total} 条（基线 ${baseline.total} 条）`);
    for (const item of regressions) {
      console.log(`  + ${item.file}：${item.before} → ${item.after}`);
    }
    if (improvements.length) {
      console.log(`  变少的文件 ${improvements.length} 个（可跑 --update 收紧基线）`);
    }
  }

  if (regressions.length) {
    console.error(`\n类型错误回退：${regressions.length} 个文件比基线多。修掉，或确认后跑 --update 更新基线。`);
    process.exit(1);
  }
}

main();
