/* web/http-client.js 契约测试
 *
 * 覆盖：默认 fetch 在调用时取 globalThis.fetch、headers/credentials/init 透传、
 * JSON/文本/空响应、错误体与 status/body、fetch 与 res.text 异常、请求超时
 * （含响应头已返回但 body 挂起）、成功后清理 abort 计时器，以及不注入
 * X-Hana-Input-Draft-Owner。不启动服务、不依赖 DOM。
 */

import assert from 'node:assert/strict';
import { createApiClient } from '../web/http-client.js';

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

function response(text, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return { ok, status, statusText, text: async () => text };
}

function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

async function caught(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  assert.fail('期望抛出异常，但没有');
}

/* ---- 默认 fetch ---- */

await t('默认 fetchImpl 在每次调用时读取 globalThis.fetch', async () => {
  const original = globalThis.fetch;
  let first = 0;
  let second = 0;
  try {
    const api = createApiClient();
    globalThis.fetch = async () => {
      first += 1;
      return response('{"n":1}');
    };
    assert.deepEqual(await api('/a'), { n: 1 });

    globalThis.fetch = async () => {
      second += 1;
      return response('{"n":2}');
    };
    assert.deepEqual(await api('/b'), { n: 2 });
    assert.equal(first, 1, '工厂创建后替换 globalThis.fetch 应生效');
    assert.equal(second, 1);
  } finally {
    globalThis.fetch = original;
  }
});

/* ---- 成功响应与请求形状 ---- */

await t('默认 headers / credentials / 无 body 时不带 Content-Type', async () => {
  let captured;
  const api = createApiClient({
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return response('{"ok":true}');
    },
  });

  assert.deepEqual(await api('/api/thing'), { ok: true });
  assert.equal(captured.url, '/api/thing');
  assert.equal(captured.init.credentials, 'same-origin');
  assert.equal(captured.init.headers.Accept, 'application/json');
  assert.equal('Content-Type' in captured.init.headers, false);
  assert.equal('X-Hana-Input-Draft-Owner' in captured.init.headers, false, '不得注入草稿归属头');
});

await t('body 自动带 Content-Type，init.headers / credentials / 其他字段透传', async () => {
  let captured;
  const api = createApiClient({
    fetchImpl: async (url, init) => {
      captured = init;
      return response('{"ok":true}');
    },
  });
  const customSignal = new AbortController().signal;

  await api('/api/post', {
    method: 'POST',
    body: '{"x":1}',
    credentials: 'include',
    headers: { Accept: 'text/plain', 'Content-Type': 'application/custom', 'X-Test': 'yes' },
    cache: 'no-store',
    signal: customSignal,
  });

  assert.equal(captured.method, 'POST');
  assert.equal(captured.body, '{"x":1}');
  assert.equal(captured.cache, 'no-store');
  assert.equal(captured.credentials, 'include', 'init.credentials 覆盖 same-origin');
  assert.equal(captured.headers.Accept, 'text/plain', 'init.headers 覆盖默认 Accept');
  assert.equal(captured.headers['Content-Type'], 'application/custom', 'init.headers 覆盖默认 Content-Type');
  assert.equal(captured.headers['X-Test'], 'yes');
  assert.notEqual(captured.signal, customSignal, 'AbortController 信号必须覆盖 init.signal');
});

await t('非 JSON 文本原样返回，空响应返回 null', async () => {
  const api = createApiClient({
    fetchImpl: async (url) => response(url === '/empty' ? '' : 'plain text'),
  });
  assert.equal(await api('/text'), 'plain text');
  assert.equal(await api('/empty'), null);
});

/* ---- 错误响应 ---- */

await t('非 ok 响应携带 status/body，消息优先级 detail > error > message > body > statusText', async () => {
  const cases = [
    ['{"detail":"bad"}', 422, 'Unprocessable', '422 bad', { detail: 'bad' }],
    ['{"error":"E","message":"M"}', 400, 'Bad Request', '400 E', { error: 'E', message: 'M' }],
    ['{"message":"M"}', 400, 'Bad Request', '400 M', { message: 'M' }],
    ['"oops"', 500, 'Server Error', '500 oops', 'oops'],
    ['', 503, 'Busy', '503 Busy', null],
  ];

  for (const [text, status, statusText, message, body] of cases) {
    const api = createApiClient({
      fetchImpl: async () => response(text, { ok: false, status, statusText }),
    });
    const err = await caught(() => api('/api/fail'));
    assert.equal(err.message, message);
    assert.equal(err.status, status);
    assert.deepEqual(err.body, body);
  }
});

/* ---- 异常传播 ---- */

await t('fetch 抛非 Abort 异常时原样抛出', async () => {
  const boom = new Error('network down');
  const api = createApiClient({ fetchImpl: async () => { throw boom; } });
  assert.equal(await caught(() => api('/api/x')), boom);
});

await t('fetch 抛 AbortError 转成请求超时', async () => {
  const api = createApiClient({ fetchImpl: async () => { throw abortError(); } });
  const err = await caught(() => api('/api/slow'));
  assert.equal(err.message, '请求超时：/api/slow');
  assert.equal(err.code, 'timeout', '超时错误必须带 code，调用方靠它区分超时与 HTTP 失败');
});

await t('res.text 抛非 Abort 异常时原样抛出', async () => {
  const boom = new Error('body boom');
  const api = createApiClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => { throw boom; },
    }),
  });
  assert.equal(await caught(() => api('/api/x')), boom);
});

await t('res.text 抛 AbortError 也转成请求超时', async () => {
  const api = createApiClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => { throw abortError(); },
    }),
  });
  const err = await caught(() => api('/api/slow-body'));
  assert.equal(err.message, '请求超时：/api/slow-body');
  assert.equal(err.code, 'timeout');
});

await t('超时是 code=timeout 的普通错误，不携带 HTTP status', async () => {
  const api = createApiClient({
    timeoutMs: 20,
    fetchImpl: (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(abortError()));
      }),
  });

  const err = await caught(() => api('/api/timeout'));
  assert.equal(err.message, '请求超时：/api/timeout', '中文提示原样保留，界面直接展示');
  assert.equal(err.code, 'timeout');
  assert.equal('status' in err, false, '超时不是 HTTP 响应，不能带 status（否则会被当成服务端报错）');
  assert.equal('body' in err, false);
});

/* ---- 超时 ---- */

await t('fetch 一直挂起时按 timeoutMs 超时', async () => {
  let aborted = false;
  const api = createApiClient({
    timeoutMs: 25,
    fetchImpl: (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(abortError());
        });
      }),
  });

  const err = await caught(() => api('/api/hang'));
  assert.equal(err.message, '请求超时：/api/hang');
  assert.equal(aborted, true, '应通过 AbortController 中止 fetch');
});

await t('响应头已返回但 body 一直挂起时仍按 timeoutMs 超时', async () => {
  let aborted = false;
  const api = createApiClient({
    timeoutMs: 25,
    fetchImpl: async (url, init) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () =>
        new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => {
            aborted = true;
            reject(abortError());
          });
        }),
    }),
  });

  const err = await caught(() => api('/api/hang-body'));
  assert.equal(err.message, '请求超时：/api/hang-body');
  assert.equal(aborted, true, '读取 body 阶段也必须受同一个超时控制');
});

await t('成功后清理 abort 计时器，不再触发 abort', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const RealAbortController = globalThis.AbortController;

  const timers = [];
  let aborts = 0;
  globalThis.setTimeout = (fn, ms) => {
    const handle = { fn, ms, cleared: false };
    timers.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (handle) handle.cleared = true;
  };
  globalThis.AbortController = class {
    constructor() {
      this.signal = { aborted: false };
    }
    abort() {
      aborts += 1;
      this.signal.aborted = true;
    }
  };

  try {
    const api = createApiClient({ fetchImpl: async () => response('{"ok":true}') });
    assert.deepEqual(await api('/api/fast'), { ok: true });

    assert.equal(timers.length, 1, '应安排且只安排一个超时计时器');
    assert.equal(timers[0].ms, 15000, '默认 timeoutMs 应为 15000');
    assert.equal(timers[0].cleared, true, '请求成功/失败后都必须 clearTimeout');
    assert.equal(aborts, 0, '成功后不得再调用 abort');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    globalThis.AbortController = RealAbortController;
  }
});

await t('自定义 timeoutMs 会用于计时器', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const RealAbortController = globalThis.AbortController;
  let scheduledMs = null;

  globalThis.setTimeout = (fn, ms) => {
    scheduledMs = ms;
    return { fn, ms };
  };
  globalThis.clearTimeout = () => {};
  globalThis.AbortController = class {
    constructor() {
      this.signal = { aborted: false };
    }
    abort() {
      this.signal.aborted = true;
    }
  };

  try {
    const api = createApiClient({
      timeoutMs: 1234,
      fetchImpl: async () => response('{"ok":true}'),
    });
    await api('/api/fast');
    assert.equal(scheduledMs, 1234);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    globalThis.AbortController = RealAbortController;
  }
});

if (bad) {
  console.error(`\n${bad} http-client test(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nALL PASS');
}
