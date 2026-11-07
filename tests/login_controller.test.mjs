/* tests/login_controller.test.mjs
 *
 * web/login-controller.js 纯控制器契约测试（账号密码登录）。
 * 覆盖：
 * 1. 只发 {username, password}：username trim、password 原样保留空格；
 *    不夹带 credential / mode / scopes / Authorization
 * 2. 空值零请求；401/400/403/5xx/网络错误只给脱敏中文，不回显原始消息，不自动重试
 * 3. 全局在途锁：双击、登录期间退出、退出期间登录都零额外请求；
 *    锁保持到 onAuthenticated / onLoggedOut 完整结束（含 app 的 /session 核对与 boot）
 * 4. onAuthenticated 返回 false 不当成功；reject 不产生未处理拒绝、安全报错后可重试
 * 5. logout 走 POST /api/web-auth/logout；失败不假装成功；dispose 后不再发请求/回调
 * 6. 源码边界：无 credential/mode、不 console、不碰 DOM/存储/location、不直连 fetch
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLoginController } from '../web/login-controller.js';

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

const unhandled = [];
process.on('unhandledRejection', (err) => { unhandled.push(err); });

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
  const queue = [];
  function api(pathname, init = {}) {
    const d = deferred();
    calls.push({ pathname, init });
    queue.push({ pathname, init, ...d });
    return d.promise;
  }
  return { api, calls, queue };
}

function controlledController() {
  const { api, calls, queue } = makeApi();
  const states = [];
  const authed = [];
  const loggedOut = [];
  const controller = createLoginController({
    api,
    onAuthenticated: (result) => authed.push(result),
    onLoggedOut: () => loggedOut.push(true),
    onState: (state) => states.push(state),
  });
  return { controller, calls, queue, states, authed, loggedOut };
}

const bodyOf = (call) => JSON.parse(call.init.body);

await t('只发 {username,password}：username trim、password 原样，不夹带 credential/mode', async () => {
  const { controller, calls, queue } = controlledController();
  const done = controller.login({ username: '  alice  ', password: '  p w  ', credential: 'x', mode: 'credential' });
  assert.equal(calls.length, 1, '应发一次登录请求');
  const call = calls[0];
  assert.equal(call.pathname, '/api/web-auth/login');
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(bodyOf(call), { username: 'alice', password: '  p w  ' });
  assert.deepEqual(Object.keys(bodyOf(call)).sort(), ['password', 'username']);
  assert.equal(String(call.pathname).includes('p w'), false, '密码不能进 URL');
  assert.equal(call.init.headers, undefined, '不能加 Authorization / owner 等自定义头');
  queue[0].resolve({ ok: true });
  assert.equal(await done, true);
});

await t('空值零请求：用户名/密码缺失都给安全提示', async () => {
  const { controller, calls, states } = controlledController();
  assert.equal(await controller.login({ username: '   ', password: 'pw' }), false);
  assert.equal(await controller.login({ username: 'alice', password: '' }), false);
  assert.equal(await controller.login({ mode: 'credential', credential: 'tok' }), false);
  assert.equal(await controller.login(), false);
  assert.equal(calls.length, 0, '必填缺失不能发请求');
  for (const state of states) {
    assert.equal(state.pending, false);
    assert.equal(typeof state.error, 'string');
    assert.ok(state.error.length > 0, '要有中文提示');
  }
});

await t('双击：第二次不发请求，只保留一个在途', async () => {
  const { controller, calls, queue, states } = controlledController();
  const first = controller.login({ username: 'alice', password: 'pw' });
  const second = controller.login({ username: 'bob', password: 'pw2' });
  assert.equal(await second, false);
  assert.equal(calls.length, 1, '双击不能发第二个请求');
  assert.equal(states.at(-1).pending, true);
  assert.ok(states.at(-1).error.includes('正在处理'));
  queue[0].resolve({ ok: true });
  assert.equal(await first, true);
});

await t('登录在途时 logout 被拒，不发退出请求', async () => {
  const { controller, calls, queue, loggedOut } = controlledController();
  const first = controller.login({ username: 'alice', password: 'pw' });
  assert.equal(await controller.logout(), false);
  assert.equal(calls.length, 1);
  assert.equal(loggedOut.length, 0);
  queue[0].resolve({ ok: true });
  assert.equal(await first, true);
});

await t('成功：onAuthenticated 一次，pending 收敛，随后可再次登录', async () => {
  const { controller, calls, queue, states, authed } = controlledController();
  const done = controller.login({ username: 'alice', password: 'pw' });
  assert.deepEqual(states[0], { pending: true, error: null });
  queue[0].resolve({ ok: true, expiresAt: '2030-01-01T00:00:00Z', principal: { id: 'u1' } });
  assert.equal(await done, true);
  assert.equal(authed.length, 1);
  assert.equal(authed[0].expiresAt, '2030-01-01T00:00:00Z');
  assert.deepEqual(states.at(-1), { pending: false, error: null });

  const again = controller.login({ username: 'bob', password: 'pw2' });
  assert.equal(calls.length, 2, '成功后锁必须释放');
  queue[1].resolve({ ok: true });
  assert.equal(await again, true);
});

await t('401：账号密码错误提示，不回显 secret / 原始 message，不自动重试', async () => {
  const { controller, calls, queue, states, authed } = controlledController();
  const done = controller.login({ username: 'alice', password: 'SECRET-PW-XYZ' });
  const error = new Error('401 invalid password: SECRET-PW-XYZ');
  error.status = 401;
  error.body = { detail: 'SECRET-PW-XYZ' };
  queue[0].reject(error);
  assert.equal(await done, false);
  assert.equal(authed.length, 0);
  assert.equal(calls.length, 1, '失败不能自动重试');
  const text = states.at(-1).error;
  assert.ok(text.includes('用户名或密码'), '应提示账号密码问题');
  assert.equal(text.includes('SECRET-PW-XYZ'), false, '错误文案不能回显密码');
  assert.equal(text.includes('invalid password'), false, '错误文案不能用原始 message');
  assert.equal(states.at(-1).pending, false);
});

await t('403/400/5xx/网络错误：中文脱敏提示，绝不冒充成功', async () => {
  const { controller, queue, states } = controlledController();
  const forbidden = controller.login({ username: 'alice', password: 'pw' });
  const e403 = new Error('403 denied');
  e403.status = 403;
  queue[0].reject(e403);
  assert.equal(await forbidden, false);
  assert.ok(states.at(-1).error.includes('登录被拒绝'));

  const bad = controller.login({ username: 'alice', password: 'pw' });
  const e400 = new Error('400 bad'); e400.status = 400;
  queue[1].reject(e400);
  assert.equal(await bad, false);
  assert.ok(states.at(-1).error.includes('格式不正确'));

  const server = controller.login({ username: 'alice', password: 'pw' });
  const e500 = new Error('500 boom'); e500.status = 500;
  queue[2].reject(e500);
  assert.equal(await server, false);
  assert.ok(states.at(-1).error.includes('Hana'));

  const net = controller.login({ username: 'alice', password: 'pw' });
  queue[3].reject(new Error('Failed to fetch'));
  assert.equal(await net, false);
  assert.ok(states.at(-1).error.includes('连不上') || states.at(-1).error.includes('网络'));
  assert.equal(states.at(-1).error.includes('Failed to fetch'), false);
});

await t('logout：POST /api/web-auth/logout，成功回调一次', async () => {
  const { controller, calls, queue, loggedOut, states } = controlledController();
  const done = controller.logout();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/api/web-auth/logout');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, undefined, '退出不带 body');
  assert.equal(calls[0].init.headers, undefined);
  queue[0].resolve({ ok: true });
  assert.equal(await done, true);
  assert.equal(loggedOut.length, 1);
  assert.deepEqual(states.at(-1), { pending: false, error: null });
});

await t('logout 失败：不回调 onLoggedOut，给安全提示，锁释放', async () => {
  const { controller, queue, loggedOut, states } = controlledController();
  const done = controller.logout();
  const error = new Error('500 boom');
  error.status = 500;
  queue[0].reject(error);
  assert.equal(await done, false);
  assert.equal(loggedOut.length, 0, '退出失败不能假装成功');
  assert.ok(states.at(-1).error.includes('Hana'));
  assert.equal(states.at(-1).pending, false);

  const retry = controller.logout();
  queue[1].resolve({ ok: true });
  assert.equal(await retry, true);
  assert.equal(loggedOut.length, 1);
});

await t('dispose：不再发请求，在途响应也不回调', async () => {
  const { controller, calls } = controlledController();
  controller.dispose();
  assert.equal(await controller.login({ username: 'alice', password: 'pw' }), false);
  assert.equal(await controller.logout(), false);
  assert.equal(calls.length, 0, 'dispose 后不能再发请求');

  const second = controlledController();
  const done = second.controller.login({ username: 'alice', password: 'pw' });
  const statesBefore = second.states.length;
  second.controller.dispose();
  second.queue[0].resolve({ ok: true });
  assert.equal(await done, false, 'dispose 后的成功不算成功');
  assert.equal(second.authed.length, 0, 'dispose 后不能回调 onAuthenticated');
  assert.equal(second.states.length, statesBefore, 'dispose 后不再发状态');
});

await t('P0：POST 成功后仍锁定，onAuthenticated 完成前不能再 login/logout', async () => {
  let releaseAuth;
  const authGate = new Promise((resolve) => { releaseAuth = resolve; });
  const calls = [];
  const states = [];
  const api = (pathname) => { calls.push(pathname); return Promise.resolve({ ok: true }); };
  const controller = createLoginController({
    api,
    onAuthenticated: () => authGate,
    onLoggedOut: () => {},
    onState: (state) => states.push(state),
  });

  const first = controller.login({ username: 'alice', password: 'pw' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 1, '先发一次登录');
  assert.equal(states.at(-1).pending, true, '回调期间必须保持 pending');

  assert.equal(await controller.login({ username: 'bob', password: 'pw2' }), false);
  assert.equal(await controller.logout(), false);
  assert.equal(calls.length, 1, '回调完成前不能再发登录/退出请求');

  releaseAuth(true);
  assert.equal(await first, true);
  assert.deepEqual(states.at(-1), { pending: false, error: null });
});

await t('onAuthenticated 返回 false：不当成功，给固定“未生效”提示', async () => {
  const states = [];
  const controller = createLoginController({
    api: () => Promise.resolve({ ok: true }),
    onAuthenticated: () => false,
    onState: (state) => states.push(state),
  });
  assert.equal(await controller.login({ username: 'alice', password: 'pw' }), false);
  assert.equal(states.at(-1).error, '登录没有生效，请重试');
  assert.equal(states.at(-1).pending, false);
});

await t('onAuthenticated 拒绝：不产生未处理拒绝，安全报错后锁释放', async () => {
  const states = [];
  let calls = 0;
  const controller = createLoginController({
    api: () => { calls += 1; return Promise.resolve({ ok: true }); },
    onAuthenticated: async () => { throw new Error('boot blew up: SECRET'); },
    onState: (state) => states.push(state),
  });
  const result = await controller.login({ username: 'alice', password: 'pw' });
  assert.equal(result, false, '回调失败不能当成功');
  assert.equal(states.at(-1).pending, false, '锁必须释放');
  assert.equal(states.at(-1).error.includes('SECRET'), false);

  await new Promise((r) => setTimeout(r, 0));
  assert.equal(unhandled.length, 0, '异步回调的拒绝必须被捕获');

  await controller.login({ username: 'alice', password: 'pw' });
  assert.equal(calls, 2, '失败后锁释放，可以再尝试');
});

await t('onLoggedOut 是异步时：锁保持到完成', async () => {
  let releaseLogout;
  const gate = new Promise((resolve) => { releaseLogout = resolve; });
  const calls = [];
  const controller = createLoginController({
    api: (pathname) => { calls.push(pathname); return Promise.resolve({ ok: true }); },
    onLoggedOut: () => gate,
  });
  const run = controller.logout();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await controller.login({ username: 'alice', password: 'pw' }), false, '退出回调期间不能登录');
  assert.deepEqual(calls, ['/api/web-auth/logout'], '回调期间不能发第二种请求');
  releaseLogout();
  assert.equal(await run, true);
});

await t('源码边界：无 credential/mode/scope，不碰 console/DOM/存储/location', async () => {
  const source = await readFile(new URL('../web/login-controller.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const forbidden = [
    [/console\./, 'console.'],
    [/document\./, 'document.'],
    [/localStorage/, 'localStorage'],
    [/sessionStorage/, 'sessionStorage'],
    [/location\./, 'location.'],
    [/window\./, 'window.'],
    [/[^.\w]fetch\(/, 'fetch('],
    [/\bS\./, 'S.'],
    [/\bcredential\b/i, 'credential'],
    [/\bmode\b/, 'mode'],
    [/scopes/, 'scopes'],
  ];
  for (const [pattern, label] of forbidden) {
    assert.equal(pattern.test(code), false, `控制器不能使用 ${label}`);
  }
});

if (unhandled.length > 0) {
  bad += 1;
  console.log(`FAIL  出现未处理的 Promise 拒绝（${unhandled.length} 条）`);
  for (const err of unhandled) console.log(`      ${err?.stack || err}`);
}

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
