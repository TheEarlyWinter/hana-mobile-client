/* tests/chat_view_mode.test.mjs
 *
 * 聊天视图模式（沉静 serene / 经典 classic）的读取与持久化。
 *
 * 为什么单独测：
 *   这条偏好住在宿主的 chat_ui.view_mode 里，手机端要读它、也要能在本地切换。
 *   切换是「先乐观更新、服务端失败再回滚」的两段式，最怕的就是失败后界面停在
 *   一个服务端并不认的模式上；另外手机浏览器隐私模式下 localStorage 会直接抛，
 *   任何一次读写都可能炸掉首屏。这里把这两类边界钉死。
 *
 * 测试风格与仓库其它 *.test.mjs 一致：自带 t() 收集器、假 api / 假 storage。
 */

import assert from 'node:assert/strict';
import {
  VIEW_MODES,
  DEFAULT_VIEW_MODE,
  normalizeViewMode,
  createChatViewMode,
} from '../web/chat-view-mode.js';

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

/** 假 api：记录每次调用的 path / init，并按 handler 返回值或抛错。 */
function makeApi(handler) {
  const calls = [];
  const api = async (path, init) => {
    calls.push({ path, init });
    return handler ? handler(path, init, calls.length) : { chatUi: { viewMode: 'classic' } };
  };
  api.calls = calls;
  return api;
}

/** 假 storage：可选在读/写时抛错，模拟隐私模式与配额溢出。 */
function makeStorage(initial = {}, { throwOnGet = false, throwOnSet = false } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(k) {
      if (throwOnGet) throw new Error('SecurityError: localStorage is not available');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (throwOnSet) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
  };
}

/** 手动控制 resolve 时机的 Promise，用来制造「load 还在路上」的竞态。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/* ------------------------------------------------------------------ 常量与归一化 */

await t('常量：VIEW_MODES 只有 serene / classic，默认是 serene', () => {
  assert.deepEqual([...VIEW_MODES], ['serene', 'classic']);
  assert.equal(DEFAULT_VIEW_MODE, 'serene');
  assert.ok(Object.isFrozen(VIEW_MODES), 'VIEW_MODES 必须是冻结的，避免被运行时改写');
});

await t('normalizeViewMode：只认小写的 classic / serene', () => {
  assert.equal(normalizeViewMode('classic'), 'classic');
  assert.equal(normalizeViewMode('serene'), 'serene');
});

await t('normalizeViewMode：undefined / null / 空串 / 怪值 一律落 serene', () => {
  for (const value of [undefined, null, '', 'weird', 0, 1, true, false, {}, [], () => {}]) {
    assert.equal(normalizeViewMode(value), 'serene', `输入 ${String(value)} 必须落 serene`);
  }
});

await t('normalizeViewMode：大小写写错也算无效，不能猜成 classic', () => {
  for (const value of ['Classic', 'CLASSIC', 'cLaSsIc', 'Serene', 'SERENE', ' classic', 'classic ']) {
    assert.equal(normalizeViewMode(value), 'serene', `输入 ${JSON.stringify(value)} 必须落 serene`);
  }
});

/* ------------------------------------------------------------------ current() 默认值 */

await t('current：没加载过时同步返回默认 serenity，且不发任何请求', () => {
  const api = makeApi();
  const store = createChatViewMode({ api, storage: makeStorage() });

  assert.equal(store.current(), 'serene');
  assert.equal(api.calls.length, 0, 'current() 是纯读，不能触发请求');
});

/* ------------------------------------------------------------------ load() */

await t('load：读服务端 chatUi.viewMode，切到 classic 并 onChange 一次', async () => {
  const api = makeApi(() => ({ chatUi: { viewMode: 'classic', taskChipOverrides: { a: 'b' } } }));
  const seen = [];
  const store = createChatViewMode({ api, storage: makeStorage(), onChange: (m) => seen.push(m) });

  const result = await store.load();

  assert.equal(result, 'classic');
  assert.equal(store.current(), 'classic');
  assert.deepEqual(seen, ['classic'], 'onChange 只应在模式确实变化时触发一次');
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].path, '/api/preferences/chat-ui');
  assert.ok(!(api.calls[0].init && api.calls[0].init.method), 'GET 不能带 method');
});

await t('load：服务端就是默认的 serene 时不重复通知 onChange', async () => {
  const api = makeApi(() => ({ chatUi: { viewMode: 'serene' } }));
  const seen = [];
  const store = createChatViewMode({ api, storage: makeStorage(), onChange: (m) => seen.push(m) });

  assert.equal(await store.load(), 'serene');
  assert.deepEqual(seen, [], '模式没变化就不该回调');
});

await t('load：服务端失败时回退 storage 里的本地值', async () => {
  const api = makeApi(() => {
    throw new Error('503 Service Unavailable');
  });
  const seen = [];
  const store = createChatViewMode({
    api,
    storage: makeStorage({ 'hana.chatViewMode': 'classic' }),
    onChange: (m) => seen.push(m),
  });

  assert.equal(await store.load(), 'classic');
  assert.equal(store.current(), 'classic');
  assert.deepEqual(seen, ['classic']);
});

await t('load：服务端返回形状不对时回退 storage', async () => {
  const shapes = [null, {}, { chatUi: null }, { chatUi: {} }, { chatUi: { viewMode: 42 } }, { chatUi: [] }];

  for (const shape of shapes) {
    const api = makeApi(() => shape);
    const store = createChatViewMode({ api, storage: makeStorage({ 'hana.chatViewMode': 'classic' }) });
    assert.equal(await store.load(), 'classic', `形状 ${JSON.stringify(shape)} 必须回退 storage`);
  }
});

await t('load：服务端与 storage 都拿不到时保持默认，并且不抛错', async () => {
  const api = makeApi(() => {
    throw new Error('offline');
  });
  const store = createChatViewMode({ api, storage: makeStorage() });

  assert.equal(await store.load(), 'serene');
  assert.equal(store.current(), 'serene');

  const broken = createChatViewMode({
    api,
    storage: makeStorage({}, { throwOnGet: true }),
  });
  assert.equal(await broken.load(), 'serene', 'storage 抛错也必须在 load 内部消化');
});

await t('load：storage 里是坏值时归一成 serene，不能把 undefined 漏出去', async () => {
  const api = makeApi(() => {
    throw new Error('offline');
  });
  const store = createChatViewMode({ api, storage: makeStorage({ 'hana.chatViewMode': 'WeIrD' }) });
  assert.equal(await store.load(), 'serene');
});

/* ------------------------------------------------------------------ set() */

await t('set：成功时乐观更新 → PUT 服务端 → 写 storage，返回 true', async () => {
  const api = makeApi(() => ({ chatUi: { viewMode: 'classic' } }));
  const storage = makeStorage();
  const seen = [];
  const store = createChatViewMode({ api, storage, onChange: (m) => seen.push(m) });

  const ok = await store.set('classic');

  assert.equal(ok, true);
  assert.equal(store.current(), 'classic');
  assert.deepEqual(seen, ['classic'], '乐观更新时就该通知界面');
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].path, '/api/preferences/chat-ui');
  assert.equal(api.calls[0].init.method, 'PUT');
  assert.deepEqual(JSON.parse(api.calls[0].init.body), { viewMode: 'classic' });
  assert.equal(storage.getItem('hana.chatViewMode'), 'classic', '成功后才写本地缓存');
});

await t('set：失败时回滚内存与界面（onChange 两次），返回 false 且不抛', async () => {
  const api = makeApi((path, init) => {
    if (init && init.method === 'PUT') throw new Error('409 conflict');
    return { chatUi: { viewMode: 'serene' } };
  });
  const storage = makeStorage();
  const seen = [];
  const store = createChatViewMode({ api, storage, onChange: (m) => seen.push(m) });

  const ok = await store.set('classic');

  assert.equal(ok, false, '没落到服务端就不能报成功');
  assert.equal(store.current(), 'serene', '必须回滚到调用前的模式');
  assert.deepEqual(seen, ['classic', 'serene'], '先乐观通知新值，再回滚通知旧值');
  assert.equal(storage.getItem('hana.chatViewMode'), null, '失败不能污染本地缓存');
});

await t('set：与当前相同不发请求、不回调，直接返回 true', async () => {
  const api = makeApi();
  const seen = [];
  const store = createChatViewMode({ api, storage: makeStorage(), onChange: (m) => seen.push(m) });

  assert.equal(await store.set('serene'), true);
  assert.equal(api.calls.length, 0);
  assert.deepEqual(seen, []);
});

await t('set：非法值先归一，已是 serene 时同样不发请求', async () => {
  const api = makeApi();
  const store = createChatViewMode({ api, storage: makeStorage() });

  assert.equal(await store.set('Classic'), true);
  assert.equal(store.current(), 'serene');
  assert.equal(api.calls.length, 0, '归一后与当前相同，不该打扰服务端');
});

await t('set：非法值归一成 serene 后照常同步服务端', async () => {
  // GET 给 classic，PUT 接受 serene：先让当前模式是 classic，set('weird') 才有「变化」可测。
  const api = makeApi((path, init) => {
    if (init && init.method === 'PUT') return { chatUi: { viewMode: 'serene' } };
    return { chatUi: { viewMode: 'classic' } };
  });
  const storage = makeStorage({ 'hana.chatViewMode': 'classic' });
  const store = createChatViewMode({ api, storage });
  await store.load();
  assert.equal(store.current(), 'classic');

  assert.equal(await store.set('weird'), true);
  assert.equal(store.current(), 'serene');
  assert.deepEqual(JSON.parse(api.calls.at(-1).init.body), { viewMode: 'serene' });
});

await t('set：set 之后 load 失败也不会把用户的选择吃掉', async () => {
  const api = makeApi((path, init) => {
    if (init && init.method === 'PUT') return { chatUi: { viewMode: 'classic' } };
    throw new Error('offline');
  });
  const store = createChatViewMode({ api, storage: makeStorage({}, { throwOnGet: true }) });

  await store.set('classic');
  assert.equal(await store.load(), 'classic', '本地读数失败时应保持当前模式，而不是打回默认');
});

await t('set / load 竞态：首屏 load 还在路上时用户切换，旧响应不能覆盖新选择', async () => {
  const gate = deferred();
  const api = makeApi((path, init) => {
    if (init && init.method === 'PUT') return { chatUi: { viewMode: 'classic' } };
    return gate.promise;
  });
  const seen = [];
  const store = createChatViewMode({ api, storage: makeStorage(), onChange: (m) => seen.push(m) });

  const inflight = store.load();
  assert.equal(await store.set('classic'), true);

  gate.resolve({ chatUi: { viewMode: 'serene' } });
  assert.equal(await inflight, 'classic', '过期的 GET 必须丢弃');
  assert.equal(store.current(), 'classic');
  assert.deepEqual(seen, ['classic'], '过期响应不应再触发 onChange');
});

await t('set 竞态：先发的 PUT 后到，不能把 storage 改回旧值', async () => {
  const gates = [];
  const api = async (path, init) => {
    if (init && init.method === 'PUT') {
      const g = deferred();
      gates.push({ body: JSON.parse(init.body).viewMode, gate: g });
      return g.promise;
    }
    return { chatUi: { viewMode: 'serene' } };
  };
  const storage = makeStorage();
  const store = createChatViewMode({ api, storage });

  const first = store.set('classic');
  const second = store.set('serene');
  assert.equal(store.current(), 'serene', '后一次乐观更新立即生效');

  gates[1].gate.resolve({ chatUi: { viewMode: 'serene' } });
  assert.equal(await second, true);
  gates[0].gate.resolve({ chatUi: { viewMode: 'classic' } });
  assert.equal(await first, true);

  assert.equal(store.current(), 'serene', '界面仍是后一次选择');
  assert.equal(storage.getItem('hana.chatViewMode'), 'serene', '过期请求的成功不能回写本地缓存');
});

/* ------------------------------------------------------------------ 降级路径 */

await t('无 api：load 直接读 storage，set 只更新内存 + storage 并返回 true', async () => {
  const storage = makeStorage({ 'hana.chatViewMode': 'classic' });
  const seen = [];
  const store = createChatViewMode({ storage, onChange: (m) => seen.push(m) });

  assert.equal(await store.load(), 'classic');
  assert.deepEqual(seen, ['classic']);

  assert.equal(await store.set('serene'), true);
  assert.equal(store.current(), 'serene');
  assert.equal(storage.getItem('hana.chatViewMode'), 'serene');
  assert.deepEqual(seen, ['classic', 'serene']);
});

await t('不传 storage：读写 globalThis.localStorage', async () => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const previous = globalThis.localStorage;
  const fake = makeStorage({ 'hana.chatViewMode': 'classic' });
  globalThis.localStorage = fake;

  try {
    const store = createChatViewMode({});
    assert.equal(await store.load(), 'classic', 'load 应读到全局 localStorage');
    assert.equal(await store.set('serene'), true);
    assert.equal(fake.getItem('hana.chatViewMode'), 'serene', 'set 应写到全局 localStorage');
  } finally {
    if (had) globalThis.localStorage = previous;
    else delete globalThis.localStorage;
  }
});

await t('storage 抛错：load 与 set 主流程都不受影响', async () => {
  const api = makeApi(() => ({ chatUi: { viewMode: 'classic' } }));
  const store = createChatViewMode({ api, storage: makeStorage({}, { throwOnGet: true, throwOnSet: true }) });

  assert.equal(await store.load(), 'classic', 'storage 读炸了也还有服务端');
  assert.equal(await store.set('classic'), true);

  const offline = makeApi(() => {
    throw new Error('offline');
  });
  const store2 = createChatViewMode({ api: offline, storage: makeStorage({}, { throwOnGet: true }) });
  assert.equal(await store2.load(), 'serene');
});

await t('onChange 抛错不影响 load / set 的返回值与状态', async () => {
  const api = makeApi(() => ({ chatUi: { viewMode: 'classic' } }));
  const store = createChatViewMode({
    api,
    storage: makeStorage(),
    onChange: () => {
      throw new Error('view 渲染炸了');
    },
  });

  assert.equal(await store.load(), 'classic');
  assert.equal(store.current(), 'classic');
  assert.equal(await store.set('serene'), true);
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
