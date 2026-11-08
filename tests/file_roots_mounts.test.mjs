// 本机挂载清单 → /gw/file 可读根的最小验证。
// 只测「根集合算得对不对」：真网关与真实读取已由 session_file_read 覆盖。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const cases = [];
function t(name, fn) {
  cases.push([name, fn]);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hana-roots-'));
const home = path.join(tmp, 'home');
const mountA = path.join(tmp, 'workspace-a');
const mountB = path.join(tmp, 'workspace-b');
const mountOff = path.join(tmp, 'workspace-disabled');
const mountRemote = path.join(tmp, 'workspace-remote');
await fs.mkdir(home, { recursive: true });
for (const dir of [mountA, mountB, mountOff, mountRemote]) await fs.mkdir(dir, { recursive: true });

await fs.writeFile(path.join(home, 'studio-mounts.json'), JSON.stringify({
  schemaVersion: 1,
  mounts: [
    { mountId: 'm1', provider: 'local_fs', status: 'active', rootLocator: { path: mountA } },
    { mountId: 'm2', provider: 'local_fs', status: 'active', rootLocator: { path: mountB } },
    { mountId: 'm3', provider: 'local_fs', status: 'disabled', rootLocator: { path: mountOff } },
    { mountId: 'm4', provider: 'remote_s3', status: 'active', rootLocator: { path: mountRemote } },
    { mountId: 'm5', provider: 'local_fs', status: 'active', rootLocator: { path: 'relative/path' } },
    { mountId: 'm6', provider: 'local_fs', status: 'active', rootLocator: { path: `${mountA}${path.sep}` } },
  ],
}), 'utf8');

// config.mjs 在 import 时读 HANA_HOME，所以必须先设环境变量，再用查询串绕开模块缓存。
process.env.HANA_HOME = home;
const mod = await import(`../gateway/file-roots.mjs?home=${encodeURIComponent(home)}`);
const { fileRoots, HANA_HOME_ROOTS } = mod;

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

t('本机挂载：active 的 local_fs 根都在，且去重', async () => {
  const roots = await fileRoots('');
  assert.ok(roots.some((r) => samePath(r, mountA)), `缺 ${mountA}`);
  assert.ok(roots.some((r) => samePath(r, mountB)), `缺 ${mountB}`);
  assert.equal(roots.filter((r) => samePath(r, mountA)).length, 1, '同一个根（末尾带分隔符）应去重');
});

t('本机挂载：disabled 的不算可读根', async () => {
  const roots = await fileRoots('');
  assert.ok(!roots.some((r) => samePath(r, mountOff)), '禁用的挂载不能出现在可读根里');
});

t('本机挂载：非 local_fs 的挂载不算', async () => {
  const roots = await fileRoots('');
  assert.ok(!roots.some((r) => samePath(r, mountRemote)), '远端挂载不属于 /gw/file 的范围');
});

t('本机挂载：相对路径被丢弃', async () => {
  const roots = await fileRoots('');
  assert.ok(!roots.some((r) => r === path.resolve('relative/path')), '相对路径不能当根');
});

t('HANA_HOME 三个固定根始终在（挂载文件坏了也不影响）', async () => {
  const before = await fileRoots('');
  for (const root of HANA_HOME_ROOTS) {
    assert.ok(before.some((r) => samePath(r, root)), `缺固定根 ${root}`);
  }
  await fs.writeFile(path.join(home, 'studio-mounts.json'), '{ this is not json', 'utf8');
  const after = await fileRoots('');
  for (const root of HANA_HOME_ROOTS) {
    assert.ok(after.some((r) => samePath(r, root)), '挂载文件写坏后固定根必须还在');
  }
});

t('挂载文件删掉：不抛、不崩，只剩固定根', async () => {
  await fs.rm(path.join(home, 'studio-mounts.json'), { force: true });
  const roots = await fileRoots('');
  assert.equal(roots.length, HANA_HOME_ROOTS.length, `应只剩固定根，实际 ${roots.length}`);
});

let bad = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err && err.message ? err.message : err}`);
  }
}
await fs.rm(tmp, { recursive: true, force: true });
console.log(bad ? `\n${bad} FAILED` : '\nALL PASS');
process.exit(bad ? 1 : 0);
