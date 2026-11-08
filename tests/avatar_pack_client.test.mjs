/* tests/avatar_pack_client.test.mjs
 *
 * web/avatar-pack.js 的单元测试。
 *
 * 这个模块存在的理由：手机端一次打开要画 6~13 个头像，每个都是一次往返。
 * 它把 N 个请求合并成 1 个，所以测试的重点不是「能不能取到」，而是
 * 「有没有重复取」和「取坏了会不会把界面带崩」。
 *
 * 覆盖：
 * 1. 正常：多个 id 只发 1 个请求，urlFor 命中 data URL
 * 2. 分片：maxIds 小于 id 数时拆成多个请求，全部命中
 * 3. in-flight 合并：同一批并发 prime 只发一次
 * 4. 已缓存跳过：第二次 prime 不再为已命中的 id 发请求
 * 5. 失败静默：reject / 非 200 / 坏 JSON 都正常 resolve，urlFor 返回 null
 * 6. 坏响应：avatars 不是对象、值是数字 → 不抛、不产生条目
 * 7. 入参防御：非字符串 id 被忽略，不抛
 */

import assert from 'node:assert/strict';
import { createAvatarPack } from '../web/avatar-pack.js';

let bad = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

/** 记录每次请求的 ids 与完整 URL，返回可控的响应。 */
function recorder({ status = 200, body = null, jsonThrows = false, gate = null } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const ids = decodeURIComponent(new URL(url, 'http://gw.test').searchParams.get('ids') || '')
      .split(',')
      .filter(Boolean);
    calls.push({ url, ids });
    if (gate) await gate;
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    if (jsonThrows) return { ok: true, status, json: async () => { throw new SyntaxError('bad json'); } };
    const payload = typeof body === 'function' ? body(ids) : body;
    return { ok: true, status, json: async () => payload };
  };
  return { fetchImpl, calls };
}

/** 最常见的成功响应：每个 id 一个假 data URL。 */
const echo = (ids) => ({
  avatars: Object.fromEntries(ids.map((id) => [id, `data:image/png;base64,${id}`])),
  skipped: [],
});

await t('正常：多个 id 只发一个请求，urlFor 命中', async () => {
  const { fetchImpl, calls } = recorder({ body: echo });
  const pack = createAvatarPack({ fetchImpl });
  await pack.prime(['hanako', 'hakimi', 'user']);

  assert.equal(calls.length, 1, '三个 id 应合并成一个请求');
  assert.deepEqual(calls[0].ids, ['hanako', 'hakimi', 'user']);
  assert.equal(pack.urlFor('hanako'), 'data:image/png;base64,hanako');
  assert.equal(pack.urlFor('user'), 'data:image/png;base64,user');
  assert.equal(pack.size(), 3);
});

await t('分片：maxIds=2 时 5 个 id 拆成 3 个请求，全部命中', async () => {
  const { fetchImpl, calls } = recorder({ body: echo });
  const pack = createAvatarPack({ fetchImpl, maxIds: 2 });
  await pack.prime(['a', 'b', 'c', 'd', 'e']);

  assert.equal(calls.length, 3, '5 个 id / 每片 2 个 = 3 片');
  assert.deepEqual(calls.map((c) => c.ids.length), [2, 2, 1]);
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    assert.equal(pack.urlFor(id), `data:image/png;base64,${id}`);
  }
});

await t('in-flight 合并：同一批并发 prime 只发一次', async () => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const { fetchImpl, calls } = recorder({ body: echo, gate });
  const pack = createAvatarPack({ fetchImpl });

  const first = pack.prime(['x', 'y']);
  const second = pack.prime(['x', 'y']); // 第一批还在飞
  open();
  await Promise.all([first, second]);

  assert.equal(calls.length, 1, '同一批并发只应发一次请求');
  assert.equal(pack.urlFor('x'), 'data:image/png;base64,x');
});

await t('已缓存跳过：第二次 prime 只请求新 id', async () => {
  const { fetchImpl, calls } = recorder({ body: echo });
  const pack = createAvatarPack({ fetchImpl });
  await pack.prime(['a']);
  await pack.prime(['a', 'b']);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].ids, ['a']);
  assert.deepEqual(calls[1].ids, ['b'], '已缓存的 a 不应重复请求');
});

await t('全命中缓存时不发请求', async () => {
  const { fetchImpl, calls } = recorder({ body: echo });
  const pack = createAvatarPack({ fetchImpl });
  await pack.prime(['a', 'b']);
  await pack.prime(['a', 'b']);
  assert.equal(calls.length, 1, '全部命中缓存就不该再发请求');
});

await t('失败静默：fetch reject 时 prime 正常 resolve，urlFor 为 null', async () => {
  const pack = createAvatarPack({ fetchImpl: async () => { throw new Error('offline'); } });
  await pack.prime(['a']); // 不应抛
  assert.equal(pack.urlFor('a'), null);
  assert.equal(pack.size(), 0);
});

await t('失败静默：非 200 时不缓存也不抛', async () => {
  const { fetchImpl } = recorder({ status: 503 });
  const pack = createAvatarPack({ fetchImpl });
  await pack.prime(['a']);
  assert.equal(pack.urlFor('a'), null);
});

await t('失败静默：JSON 坏掉时不抛', async () => {
  const { fetchImpl } = recorder({ jsonThrows: true });
  const pack = createAvatarPack({ fetchImpl });
  await pack.prime(['a']);
  assert.equal(pack.urlFor('a'), null);
});

await t('坏响应：avatars 不是对象时不产生条目', async () => {
  const pack = createAvatarPack({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ avatars: 'nope' }) }) });
  await pack.prime(['a']);
  assert.equal(pack.size(), 0);
});

await t('坏响应：值不是字符串的条目被丢弃，其它条目保留', async () => {
  const pack = createAvatarPack({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ avatars: { bad: 42, empty: '', good: 'data:image/png;base64,aGk=' } }),
    }),
  });
  await pack.prime(['bad', 'empty', 'good']);
  assert.equal(pack.urlFor('bad'), null);
  assert.equal(pack.urlFor('empty'), null);
  assert.equal(pack.urlFor('good'), 'data:image/png;base64,aGk=');
});

await t('入参防御：非字符串 id 被忽略，不抛', async () => {
  const { fetchImpl, calls } = recorder({ body: echo });
  const pack = createAvatarPack({ fetchImpl });
  await pack.prime([null, 42, { id: 'x' }, '', 'ok']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ids, ['ok'], '只应请求合法字符串 id');
  assert.equal(pack.urlFor(42), null, '非字符串查询返回 null 而不是抛');
  assert.equal(pack.urlFor(null), null);
});

await t('clear 之后回到未命中，且能重新取', async () => {
  const { fetchImpl, calls } = recorder({ body: echo });
  const pack = createAvatarPack({ fetchImpl });
  await pack.prime(['a']);
  pack.clear();
  assert.equal(pack.urlFor('a'), null);
  await pack.prime(['a']);
  assert.equal(calls.length, 2);
  assert.equal(pack.urlFor('a'), 'data:image/png;base64,a');
});

if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
