/* tests/session_list_controller.test.mjs
 *
 * web/session-list-controller.js 契约测试（不加载 app.js、不碰 DOM）
 * 覆盖：
 * 1. 初始 home、显式 URL /api/sessions?namespace=<value>、省略参数刷新当前筛选
 * 2. namespace 改变时同步 onNamespaceChange，未改变不通知；每次 load 都 onLoading
 * 3. home→code 旧成功晚到 / 旧失败晚到均不落地、不报错
 * 4. 同筛选刷新竞态：旧成功、旧失败晚到都不覆盖最新结果
 * 5. 当前请求失败：onError 收到原错误与命名空间，不伪装成空成功
 * 6. 响应非数组且非 { sessions: array } 时清楚报错；{ sessions: [] } 正常接受
 * 7. dispose 使在途成功/失败全部失效，之后 load 不再发请求
 * 8. 非法 namespace 同步抛错且不发请求、不改状态
 * 9. 缺 namespace 的 legacy 行按 home 归类；code 只收明确 namespace=code 的行
 * 10. 身份字段原样保留，不注入 namespace、不从 label/workspaceId 猜路径
 */

import assert from 'node:assert/strict';
import { createSessionListController } from '../web/session-list-controller.js';

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeApi() {
  const calls = [];
  const pending = [];
  function api(path) {
    const d = deferred();
    calls.push(path);
    pending.push(d);
    return d.promise;
  }
  return { api, calls, pending };
}

function harness(overrides = {}) {
  const { api, calls, pending } = makeApi();
  const events = [];
  const loading = [];
  const loaded = [];
  const errors = [];
  const namespaceChanges = [];

  const controller = createSessionListController({
    api,
    onLoading: (ns) => {
      loading.push(ns);
      events.push(`loading:${ns}`);
    },
    onLoaded: (list, ns) => {
      loaded.push({ list, ns });
      events.push(`loaded:${ns}`);
    },
    onError: (error, ns) => {
      errors.push({ error, ns });
      events.push(`error:${ns}`);
    },
    onNamespaceChange: (ns) => {
      namespaceChanges.push({ ns, current: controller.getNamespace() });
      events.push(`namespace:${ns}`);
    },
    ...overrides,
  });

  return { controller, api, calls, pending, events, loading, loaded, errors, namespaceChanges };
}

const legacyRow = {
  sessionId: 'sess_legacy',
  path: 'C:\\Users\\\\example\\.hanako\\agents\\hanako\\sessions\\legacy.jsonl',
  title: '旧版会话',
  modified: 1000,
};
const homeRow = {
  sessionId: 'sess_home',
  path: 'C:\\Users\\\\example\\.hanako\\agents\\hanako\\sessions\\home.jsonl',
  namespace: 'home',
  title: '主页会话',
  modified: 2000,
};
const codeRow = {
  sessionId: 'sess_code',
  path: 'C:\\Users\\\\example\\.hanako\\agents\\hanako\\sessions\\code.jsonl',
  namespace: 'code',
  title: '代码会话',
  modified: 3000,
};
const appRow = { sessionId: 'sess_app', namespace: 'app', title: '聚合列表行' };

/* ------------------------------------------------------------------ */
/* 1. 初始状态、URL 与刷新                                              */
/* ------------------------------------------------------------------ */

await t('初始 home：load() 请求显式 namespace=home 并回传列表', async () => {
  const h = harness();
  assert.equal(h.controller.getNamespace(), 'home');

  const p = h.controller.load();
  assert.deepEqual(h.calls, ['/api/sessions?namespace=home']);
  assert.deepEqual(h.loading, ['home']);
  assert.deepEqual(h.namespaceChanges, [], '初始 load 未改变筛选，不应通知');

  h.pending[0].resolve([legacyRow]);
  const result = await p;

  assert.equal(h.loaded.length, 1);
  assert.equal(h.loaded[0].ns, 'home');
  assert.equal(h.loaded[0].list.length, 1);
  assert.equal(h.loaded[0].list[0], legacyRow, '行对象身份必须保留');
  assert.deepEqual(result, [legacyRow]);
  assert.deepEqual(h.errors, []);
});

await t('切换到 code：同步通知、显式 URL；随后 load() 刷新当前 code', async () => {
  const h = harness();

  const p1 = h.controller.load('code');
  assert.equal(h.controller.getNamespace(), 'code');
  assert.deepEqual(h.namespaceChanges, [{ ns: 'code', current: 'code' }]);
  assert.deepEqual(h.events.slice(0, 2), ['namespace:code', 'loading:code']);
  assert.deepEqual(h.calls, ['/api/sessions?namespace=code']);

  h.pending[0].resolve([codeRow, legacyRow, homeRow, appRow]);
  await p1;
  assert.deepEqual(h.loaded[0].list, [codeRow]);
  assert.equal(h.loaded[0].ns, 'code');

  // 省略参数刷新当前筛选：不再通知 namespace，但每次 load 都通知 loading
  const p2 = h.controller.load();
  assert.deepEqual(h.namespaceChanges, [{ ns: 'code', current: 'code' }]);
  assert.deepEqual(h.calls[1], '/api/sessions?namespace=code');
  assert.deepEqual(h.loading, ['code', 'code']);

  h.pending[1].resolve({ sessions: [codeRow] });
  await p2;
  assert.equal(h.loaded.length, 2);
  assert.deepEqual(h.loaded[1].list, [codeRow]);
});

await t('每次 load 都 onLoading：被后发请求取代的调用也不例外', async () => {
  const h = harness();
  const p1 = h.controller.load();
  const p2 = h.controller.load('code');
  const p3 = h.controller.load();

  assert.deepEqual(h.loading, ['home', 'code', 'code']);
  assert.deepEqual(h.namespaceChanges.map((item) => item.ns), ['code']);
  assert.deepEqual(h.calls, [
    '/api/sessions?namespace=home',
    '/api/sessions?namespace=code',
    '/api/sessions?namespace=code',
  ]);

  h.pending[2].resolve([]);
  await p3;
  h.pending[0].resolve([legacyRow]);
  h.pending[1].resolve([codeRow]);
  await p1;
  await p2;

  assert.equal(h.loaded.length, 1, '只有最新请求可以落地');
  assert.equal(h.loaded[0].ns, 'code');
});

/* ------------------------------------------------------------------ */
/* 2. 竞态：旧成功 / 旧失败晚到                                          */
/* ------------------------------------------------------------------ */

await t('home→code：旧 home 成功晚到不得更新状态', async () => {
  const h = harness();
  const oldLoad = h.controller.load('home');
  const newLoad = h.controller.load('code');

  h.pending[0].resolve([legacyRow, homeRow]);
  assert.equal(await oldLoad, undefined);
  assert.equal(h.loaded.length, 0, '旧 home 成功不得触发 onLoaded');
  assert.deepEqual(h.errors, []);

  h.pending[1].resolve([codeRow]);
  await newLoad;
  assert.equal(h.loaded.length, 1);
  assert.equal(h.loaded[0].ns, 'code');
  assert.deepEqual(h.loaded[0].list, [codeRow]);
});

await t('home→code：旧 home 失败晚到不得报错', async () => {
  const h = harness();
  const oldLoad = h.controller.load('home');
  const newLoad = h.controller.load('code');
  const staleError = new Error('旧 home 请求失败');

  h.pending[0].reject(staleError);
  assert.equal(await oldLoad, undefined);
  assert.deepEqual(h.errors, [], '旧失败不得触发 onError');

  h.pending[1].resolve([codeRow]);
  await newLoad;
  assert.equal(h.loaded.length, 1);
  assert.equal(h.loaded[0].ns, 'code');
});

await t('同筛选刷新：旧成功晚到不得覆盖最新结果', async () => {
  const h = harness();
  const first = h.controller.load();
  const second = h.controller.load();

  h.pending[0].resolve([{ ...legacyRow, title: '旧结果' }]);
  await first;
  assert.equal(h.loaded.length, 0);

  h.pending[1].resolve([{ ...legacyRow, title: '新结果' }]);
  await second;
  assert.equal(h.loaded.length, 1);
  assert.equal(h.loaded[0].list[0].title, '新结果');
});

await t('同筛选刷新：旧失败晚到不得报错', async () => {
  const h = harness();
  const first = h.controller.load();
  const second = h.controller.load();

  h.pending[0].reject(new Error('旧刷新失败'));
  await first;
  assert.deepEqual(h.errors, []);

  h.pending[1].resolve([]);
  await second;
  assert.equal(h.loaded.length, 1);
  assert.deepEqual(h.loaded[0].list, []);
});

await t('旧请求的非法响应也不得报错', async () => {
  const h = harness();
  const oldLoad = h.controller.load('home');
  const newLoad = h.controller.load('code');

  h.pending[0].resolve({ nope: true });
  await oldLoad;
  assert.deepEqual(h.errors, []);

  h.pending[1].resolve([codeRow]);
  await newLoad;
  assert.equal(h.loaded.length, 1);
});

/* ------------------------------------------------------------------ */
/* 3. 当前请求错误与响应格式                                            */
/* ------------------------------------------------------------------ */

await t('当前请求失败：onError 收到原错误与命名空间，不伪装空成功', async () => {
  const h = harness();
  const error = new Error('网络断开');
  const p = h.controller.load();

  h.pending[0].reject(error);
  assert.equal(await p, undefined);

  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].error, error, '必须原样传递错误对象');
  assert.equal(h.errors[0].ns, 'home');
  assert.equal(h.loaded.length, 0, '失败时不得触发 onLoaded');
  assert.deepEqual(h.events.filter((item) => item.startsWith('loaded')), []);

  // 后续成功可正常恢复
  const retry = h.controller.load();
  h.pending[1].resolve([legacyRow]);
  await retry;
  assert.equal(h.loaded.length, 1);
  assert.deepEqual(h.loaded[0].list, [legacyRow]);
});

await t('响应格式非法：清楚报错且不当作空列表', async () => {
  const badResponses = [{}, { sessions: 'nope' }, null, 'oops', 42];
  for (const raw of badResponses) {
    const h = harness();
    const p = h.controller.load();
    h.pending[0].resolve(raw);
    await p;

    assert.equal(h.loaded.length, 0, `响应 ${JSON.stringify(raw)} 不得触发 onLoaded`);
    assert.equal(h.errors.length, 1, `响应 ${JSON.stringify(raw)} 应报错`);
    assert.match(h.errors[0].error.message, /会话列表响应格式/, '错误信息应说明列表响应格式问题');
    assert.equal(h.errors[0].ns, 'home');
  }
});

await t('响应 { sessions: [] } 正常接受为空列表', async () => {
  const h = harness();
  const p = h.controller.load();
  h.pending[0].resolve({ sessions: [] });
  await p;

  assert.deepEqual(h.errors, []);
  assert.equal(h.loaded.length, 1);
  assert.deepEqual(h.loaded[0].list, []);
});

/* ------------------------------------------------------------------ */
/* 4. dispose                                                          */
/* ------------------------------------------------------------------ */

await t('dispose：在途成功与失败全部失效，之后 load 不再发请求', async () => {
  const h = harness();
  const first = h.controller.load();
  const second = h.controller.load('code');

  h.controller.dispose();
  h.pending[0].resolve([legacyRow]);
  h.pending[1].reject(new Error('晚到失败'));

  assert.equal(await first, undefined);
  assert.equal(await second, undefined);
  assert.equal(h.loaded.length, 0, 'dispose 后成功不得落地');
  assert.equal(h.errors.length, 0, 'dispose 后失败不得报错');

  const callsBefore = h.calls.length;
  const afterDispose = h.controller.load('home');
  assert.equal(await afterDispose, undefined);
  assert.equal(h.calls.length, callsBefore, 'dispose 后 load 不得发请求');
  assert.equal(h.loading.length, 2, 'dispose 后 load 不得再通知 loading');
  assert.equal(h.namespaceChanges.length, 1, 'dispose 后 load 不得再通知 namespace');
  assert.equal(h.controller.getNamespace(), 'code', 'getNamespace 仍返回最后的筛选值');

  h.controller.dispose(); // 幂等
});

await t('onLoading 内 dispose：不再发出请求，也不回调', async () => {
  const calls = [];
  const loaded = [];
  const errors = [];
  const controller = createSessionListController({
    api: (path) => {
      calls.push(path);
      return Promise.resolve([]);
    },
    onLoading: () => controller.dispose(),
    onLoaded: (list) => loaded.push(list),
    onError: (err) => errors.push(err),
  });

  assert.equal(await controller.load(), undefined);
  assert.deepEqual(calls, [], 'onLoading 已 dispose，请求不得发出');
  assert.deepEqual(loaded, []);
  assert.deepEqual(errors, []);
  assert.equal(controller.getNamespace(), 'home');
});

/* ------------------------------------------------------------------ */
/* 5. 非法 namespace                                                   */
/* ------------------------------------------------------------------ */

await t('非法 namespace：同步抛错、不发请求、不改状态', async () => {
  const h = harness();
  for (const value of ['all', 'HOME', '', null, 0, {}]) {
    assert.throws(
      () => h.controller.load(value),
      /home \/ code/,
      `namespace ${String(value)} 应被拒绝`,
    );
  }
  assert.deepEqual(h.calls, [], '非法 namespace 不得发请求');
  assert.deepEqual(h.loading, []);
  assert.deepEqual(h.namespaceChanges, []);
  assert.equal(h.controller.getNamespace(), 'home');

  // 非法调用之后，合法调用仍正常
  const p = h.controller.load('code');
  assert.equal(h.controller.getNamespace(), 'code');
  assert.deepEqual(h.calls, ['/api/sessions?namespace=code']);
  h.pending[0].resolve([]);
  await p;
});

await t('构造参数校验：非法 initialNamespace 与缺失 api 直接抛错', () => {
  assert.throws(
    () => createSessionListController({ api: () => Promise.resolve([]), initialNamespace: 'all' }),
    /home \/ code/,
  );
  assert.throws(() => createSessionListController({}), /api/);
});

/* ------------------------------------------------------------------ */
/* 6. 行级 namespace 归类与身份保留                                     */
/* ------------------------------------------------------------------ */

await t('缺 namespace 的 legacy 行按 home 归类；显式不匹配的行不混入 home', async () => {
  const h = harness();
  const p = h.controller.load();
  h.pending[0].resolve([legacyRow, homeRow, codeRow, appRow]);
  await p;

  assert.deepEqual(h.loaded[0].list, [legacyRow, homeRow], 'home 只收缺省与显式 home 的行');
  assert.equal(h.loaded[0].list[0], legacyRow);
  assert.equal(h.loaded[0].list[1], homeRow);
});

await t('code 只收明确 namespace=code 的行，legacy 与 label 不冒充', async () => {
  const fakeCodeByLabel = { sessionId: 'sess_label', label: 'code', workspaceId: 'code' };
  const h = harness();
  const p = h.controller.load('code');
  h.pending[0].resolve([legacyRow, fakeCodeByLabel, homeRow, codeRow, appRow]);
  await p;

  assert.deepEqual(h.loaded[0].list, [codeRow], 'code 列表只接受明确 namespace=code 的行');
});

await t('身份字段原样保留：不注入 namespace、不改写、不猜路径', async () => {
  const richRow = {
    sessionId: 'sess_rich',
    path: 'C:\\sessions\\rich.jsonl',
    agentId: 'agent_1',
    agentName: 'Hana',
    label: '会话标签',
    workspaceId: 'ws_1',
    namespace: 'home',
    title: '富字段会话',
    modified: 4000,
    messageCount: 7,
    extra: { nested: true },
  };
  const snapshot = structuredClone(richRow);

  const h = harness();
  const p = h.controller.load();
  const raw = [richRow, legacyRow];
  const rawSnapshot = structuredClone(raw);
  h.pending[0].resolve(raw);
  await p;

  const list = h.loaded[0].list;
  assert.notEqual(list, raw, '返回新数组，不把原始响应数组直接外泄');
  assert.equal(list[0], richRow, '行对象身份保留');
  assert.deepEqual(list[0], snapshot, '身份 metadata 原样保留');
  assert.equal('namespace' in legacyRow, false, '不得给 legacy 行注入 namespace');
  assert.equal('path' in legacyRow, true, '原有 path 不得被改写');
  assert.deepEqual(raw, rawSnapshot, '不得修改响应数组及其行');

  // 调用方修改返回数组不应影响控制器后续结果
  list.length = 0;
  const again = h.controller.load();
  h.pending[1].resolve(raw);
  await again;
  assert.equal(h.loaded[1].list.length, 2);
});

await t('api 同步抛错：走 onError，不产生未处理异常', async () => {
  const error = new Error('同步失败');
  const errors = [];
  const loaded = [];
  const controller = createSessionListController({
    api: () => {
      throw error;
    },
    onLoaded: (list) => loaded.push(list),
    onError: (err, ns) => errors.push({ err, ns }),
  });

  const p = controller.load();
  assert.equal(await p, undefined);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].err, error);
  assert.equal(errors[0].ns, 'home');
  assert.deepEqual(loaded, []);
});

await t('reset：在途成功失效、筛选回初始，控制器之后仍可 load', async () => {
  const h = harness();
  h.controller.load('code');
  assert.equal(h.controller.getNamespace(), 'code');
  const stale = h.pending[0];

  h.controller.reset();
  assert.equal(h.controller.getNamespace(), 'home', 'reset 后回到初始筛选');
  assert.equal(h.loaded.length, 0);
  assert.equal(h.errors.length, 0, 'reset 不报错');

  // 旧用户的响应晚到：不能回填。
  stale.resolve([codeRow]);
  await tick();
  assert.equal(h.loaded.length, 0, 'reset 前发出的请求结果必须丢弃');
  assert.equal(h.errors.length, 0);

  // 控制器仍可用：新 load 正常落地。
  const next = h.controller.load();
  assert.equal(h.calls.at(-1), '/api/sessions?namespace=home');
  h.pending.at(-1).resolve([homeRow]);
  assert.deepEqual(await next, [homeRow]);
  assert.equal(h.loaded.length, 1);
});

await t('reset：旧请求失败也不报错，不影响之后的新请求', async () => {
  const h = harness();
  h.controller.load('code');
  const stale = h.pending[0];
  h.controller.reset();

  const boom = new Error('network');
  stale.reject(boom);
  await tick();
  assert.equal(h.errors.length, 0, '旧用户的失败不能在 reset 后报错');

  const next = h.controller.load('home');
  h.pending.at(-1).resolve({ sessions: [homeRow] });
  assert.deepEqual(await next, [homeRow]);
});

if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
