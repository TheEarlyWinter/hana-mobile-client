/* scripts/devtools/lib/attach.mjs 的 openEndpoint 资源回收回归（L8）。
 *
 * 场景：adb forward 已经建立（owned=true），但接下来 listTargets / pickTarget 失败。
 * 期望：只撤销 owned=true 的那条转发，并把主错误原样抛回去；owned=false（复用已有转发）时不得撤销。
 *
 * 做法：用 vm.SourceTextModule 加载真实的 attach.mjs 源码，把 ./adb.mjs / ./cdp.mjs / ./errors.mjs
 * 换成 SyntheticModule 替身；被测代码是仓库里那份真实文件，不是副本。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

// vm.SourceTextModule 要显式开实验开关；没有就带着开关重跑自己。
if (typeof vm.SourceTextModule !== 'function') {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', SELF], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

const ROOT = path.resolve(path.dirname(SELF), '..');
const ATTACH = path.join(ROOT, 'scripts', 'devtools', 'lib', 'attach.mjs');

class DevtoolsError extends Error {
  constructor(message, hint, detail) {
    super(message);
    this.hint = hint;
    this.detail = detail;
  }
}

const OPTS = { cdpUrl: '', device: '', port: 9222, timeout: 5000, match: '' };

async function loadAttach(deps) {
  const context = vm.createContext({ console, URL, setTimeout, clearTimeout });
  const source = fs.readFileSync(ATTACH, 'utf8');
  const mod = new vm.SourceTextModule(source, { identifier: 'file:///attach.mjs', context });

  const synth = (identifier, exportsObj) => new vm.SyntheticModule(
    Object.keys(exportsObj),
    function init() {
      for (const [key, value] of Object.entries(exportsObj)) this.setExport(key, value);
    },
    { identifier, context },
  );

  const adb = synth('./adb.mjs', {
    ensureForward: deps.ensureForward,
    findPid: async () => 4242,
    readDevtoolsSockets: async () => ({ readable: true, names: ['webview_devtools_remote_4242'] }),
    resolveSerial: async () => 'SERIAL-1',
    removeForward: deps.removeForward,
  });
  const cdp = synth('./cdp.mjs', {
    isWebViewUserAgent: () => true,
    listTargets: deps.listTargets,
    pickTarget: deps.pickTarget,
  });
  const errors = synth('./errors.mjs', { DevtoolsError, renderError: (e) => String(e && e.message) });

  await mod.link((specifier) => {
    if (specifier === './adb.mjs') return adb;
    if (specifier === './cdp.mjs') return cdp;
    if (specifier === './errors.mjs') return errors;
    throw new Error(`attach.mjs 出现了未预期的 import：${specifier}`);
  });
  await mod.evaluate();
  return mod.namespace;
}

function makeDeps(overrides = {}) {
  const removals = [];
  return {
    removals,
    deps: {
      ensureForward: async () => ({ port: 9333, owned: true }),
      listTargets: async () => [{ type: 'page', url: 'http://127.0.0.1:24000/', webSocketDebuggerUrl: 'ws://x/y' }],
      pickTarget: () => ({ webSocketDebuggerUrl: 'ws://x/y', type: 'page', url: 'http://127.0.0.1:24000/' }),
      removeForward: async (serial, port) => { removals.push({ serial, port }); },
      ...overrides,
    },
  };
}

let bad = 0;
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

t('listTargets 失败时撤销本次建立的 forward，并保留主错误', async () => {
  const { deps, removals } = makeDeps({
    listTargets: async () => { throw new Error('list-boom'); },
  });
  const ns = await loadAttach(deps);
  await assert.rejects(
    () => ns.openEndpoint(OPTS),
    (err) => err && err.message === 'list-boom',
    '应把 listTargets 的错误原样抛出',
  );
  assert.deepEqual(removals, [{ serial: 'SERIAL-1', port: 9333 }], `必须撤销 owned 转发，实际：${JSON.stringify(removals)}`);
});

t('pickTarget 失败时同样撤销自己的 forward', async () => {
  const { deps, removals } = makeDeps({
    pickTarget: () => { throw new Error('pick-boom'); },
  });
  const ns = await loadAttach(deps);
  await assert.rejects(
    () => ns.openEndpoint(OPTS),
    (err) => err && err.message === 'pick-boom',
    '应把 pickTarget 的错误原样抛出',
  );
  assert.deepEqual(removals, [{ serial: 'SERIAL-1', port: 9333 }], `必须撤销 owned 转发，实际：${JSON.stringify(removals)}`);
});

t('复用已有转发（owned=false）时失败不得撤销别人的 forward', async () => {
  const { deps, removals } = makeDeps({
    ensureForward: async () => ({ port: 9222, owned: false }),
    listTargets: async () => { throw new Error('list-boom-reused'); },
  });
  const ns = await loadAttach(deps);
  await assert.rejects(
    () => ns.openEndpoint(OPTS),
    (err) => err && err.message === 'list-boom-reused',
  );
  assert.deepEqual(removals, [], `复用的转发不得撤销，实际：${JSON.stringify(removals)}`);
});

t('成功路径不撤销转发，返回 wsUrl 与套接字名', async () => {
  const { deps, removals } = makeDeps();
  const ns = await loadAttach(deps);
  const ep = await ns.openEndpoint(OPTS);
  assert.equal(ep.wsUrl, 'ws://x/y');
  assert.equal(ep.socketName, 'webview_devtools_remote_4242');
  assert.equal(ep.forward.owned, true);
  assert.deepEqual(removals, [], '成功时调用方自己负责收尾，openEndpoint 不得提前撤销');
});

t('真实模块能正常加载：attach.mjs 从 adb.mjs 导入的 removeForward 确实存在', async () => {
  // 替身模块会“补上”任何名字，所以真实 import 单独验一次：导出名写错的话两个 CLI 会直接起不来。
  const real = await import(pathToFileURL(ATTACH).href);
  assert.equal(typeof real.openEndpoint, 'function');
});

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${String(err.message || err).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
}
