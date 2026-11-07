/* tests/login_view.test.mjs
 *
 * 登录视图纯 DOM 契约测试（账号密码单模式，不再有手机凭证/双模式切换）。
 * 覆盖：
 * 1. 提交 payload 恰好 {username,password}：username trim、password 原样保留空格；
 *    密码在提交瞬间清空，用户名保留
 * 2. pending 防重/禁用；submitLocked 防止 onSubmit 未完成时重复提交
 * 3. Enter / Shift+Enter / IME 组合输入 / keyCode 229
 * 4. 错误只显示视图收到的字符串；setState 恢复按钮
 * 5. btnSwitchLogin 只发意图，pending 时禁用
 * 6. dispose 解绑；缺 DOM 安全
 * 7. index.html 只有账号密码入口，没有 credential/tabs；三张抽屉大按钮已收进设置面板
 * 8. 源码无 credential/mode/setMode、无剪贴板/URL/存储/日志/网络访问
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLoginView } from '../web/login-view.js';

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

function createMockElement(tag, id) {
  const listeners = new Map();
  const attrs = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    id,
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    setAttribute(k, v) { attrs.set(k, String(v)); },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    },
    dispatchEvent(event) {
      const type = typeof event === 'string' ? event : event.type;
      const payload = typeof event === 'string' ? { type } : event;
      for (const fn of [...(listeners.get(type) || [])]) fn.call(el, payload);
    },
    focus() {},
    listenerCount(type) { return (listeners.get(type) || []).length; },
  };
  return el;
}

function createLoginDocument() {
  const elements = new Map();
  const doc = {
    getElementById: (id) => elements.get(id) || null,
    _add(id, tag) {
      const el = createMockElement(tag, id);
      elements.set(id, el);
      return el;
    },
  };
  for (const [id, tag] of [
    ['inUser', 'input'],
    ['inPass', 'input'],
    ['btnLogin', 'button'],
    ['loginErr', 'p'],
    ['loginHint', 'p'],
    ['btnSwitchLogin', 'button'],
  ]) doc._add(id, tag);
  doc.getElementById('btnLogin').textContent = '登录';
  doc.getElementById('btnSwitchLogin').textContent = '退出登录';
  return doc;
}

function makeView(doc = createLoginDocument()) {
  const calls = { submit: [], switch: 0 };
  const view = createLoginView({
    document: doc,
    onSubmit: (payload) => { calls.submit.push(payload); },
    onSwitchLogin: () => { calls.switch += 1; },
  });
  return { doc, view, calls, $: (id) => doc.getElementById(id) };
}

const key = (k, extra = {}) => ({ type: 'keydown', key: k, ...extra });

await t('提交 payload 恰好 {username,password}：username trim、密码空格保留、提交即清密码', async () => {
  const { view, calls, $ } = makeView();
  $('inUser').value = '  alice  ';
  $('inPass').value = '  p w  ';
  $('btnLogin').dispatchEvent('click');

  assert.equal(calls.submit.length, 1);
  assert.deepEqual(calls.submit[0], { username: 'alice', password: '  p w  ' });
  assert.deepEqual(Object.keys(calls.submit[0]).sort(), ['password', 'username']);
  assert.equal($('inPass').value, '', '提交即清密码');
  assert.equal($('inUser').value, '  alice  ', '用户名保留');
});

await t('空字段也原样交纯 payload，视图不做业务校验', async () => {
  const { view, calls, $ } = makeView();
  $('inUser').value = '';
  $('inPass').value = '';
  $('btnLogin').dispatchEvent('click');
  assert.deepEqual(calls.submit, [{ username: '', password: '' }]);
});

await t('pending：按钮/字段/退出按钮禁用，重复点击零提交', async () => {
  const { view, calls, $ } = makeView();
  $('inUser').value = 'alice';
  $('inPass').value = 'pw';
  view.setState({ pending: true, error: '' });

  assert.equal($('btnLogin').disabled, true);
  assert.equal($('inUser').disabled, true);
  assert.equal($('inPass').disabled, true);
  assert.equal($('btnSwitchLogin').disabled, true);
  assert.equal($('btnLogin').textContent, '登录中…');

  $('btnLogin').dispatchEvent('click');
  assert.equal(calls.submit.length, 0, 'pending 时不能再提交');

  view.setState({ pending: false, error: '' });
  assert.equal($('btnLogin').disabled, false);
  assert.equal($('btnLogin').textContent, '登录');
  $('btnLogin').dispatchEvent('click');
  assert.equal(calls.submit.length, 1);
});

await t('submitLocked：onSubmit 未完成前重复点击不重复提交，完成后可再提交', async () => {
  const doc = createLoginDocument();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const view = createLoginView({ document: doc, onSubmit: (payload) => { calls.push(payload); return gate; } });
  doc.getElementById('inUser').value = 'alice';
  doc.getElementById('inPass').value = 'pw';

  doc.getElementById('btnLogin').dispatchEvent('click');
  doc.getElementById('btnLogin').dispatchEvent('click');
  assert.equal(calls.length, 1, '异步提交未完成不能重复');

  release();
  await new Promise((r) => setTimeout(r, 0));
  doc.getElementById('btnLogin').dispatchEvent('click');
  assert.equal(calls.length, 2, '完成后可以再次提交');
});

await t('Enter 提交；IME 组合输入与 keyCode 229 不提交', async () => {
  const { view, calls, $ } = makeView();
  $('inUser').value = 'alice';
  $('inPass').value = 'pw';
  $('inPass').dispatchEvent(key('Enter', { isComposing: true }));
  assert.equal(calls.submit.length, 0, 'IME 组合中不提交');
  $('inPass').dispatchEvent(key('Enter', { keyCode: 229 }));
  assert.equal(calls.submit.length, 0, 'keyCode 229 不提交');
  $('inPass').dispatchEvent(key('Enter'));
  assert.equal(calls.submit.length, 1, '普通 Enter 提交');
});

await t('错误只显示视图收到的字符串；setState 可清空', async () => {
  const { view, $ } = makeView();
  view.setState({ error: '用户名或密码不正确' });
  assert.equal($('loginErr').textContent, '用户名或密码不正确');
  view.setState({ error: '' });
  assert.equal($('loginErr').textContent, '');
  view.setState({ error: 'x' });
  view.setState({ pending: false });
  assert.equal($('loginErr').textContent, 'x', '不带 error 字段时不清错误');
});

await t('btnSwitchLogin 只发意图；pending 时禁用不触发', async () => {
  const { view, calls, $ } = makeView();
  $('btnSwitchLogin').dispatchEvent('click');
  assert.equal(calls.switch, 1);
  view.setState({ pending: true });
  $('btnSwitchLogin').dispatchEvent('click');
  assert.equal(calls.switch, 1, 'pending 时不能退出');
});

await t('dispose：解绑监听，之后点击无效；缺 DOM 安全', async () => {
  const { view, calls, $ } = makeView();
  view.dispose();
  $('btnLogin').dispatchEvent('click');
  $('btnSwitchLogin').dispatchEvent('click');
  assert.equal(calls.submit.length, 0);
  assert.equal(calls.switch, 0);
  assert.equal($('btnLogin').listenerCount('click'), 0);

  const emptyDoc = { getElementById: () => null };
  const emptyView = createLoginView({ document: emptyDoc });
  emptyView.setState({ pending: false, error: '' });
  emptyView.clearSecrets();
  emptyView.dispose();
});

await t('dispose 清空尚未提交的密码，不能因清理凭证分支而退回秘密残留', async () => {
  const { view, calls, $ } = makeView();
  $('inUser').value = 'alice';
  $('inPass').value = 'FAKE-UNSUBMITTED-PASSWORD';
  view.dispose();
  assert.equal($('inPass').value, '', 'dispose 必须清除尚未提交的密码');
  assert.equal($('inUser').value, 'alice', '不需要清除非秘密用户名');
  view.dispose();
  $('btnLogin').dispatchEvent('click');
  assert.equal(calls.submit.length, 0);
});

await t('index.html：只有账号密码入口；接入方式与退出登录已从抽屉搬进设置面板', async () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  for (const id of ['inUser', 'inPass', 'btnLogin', 'loginErr', 'loginHint']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  // 抽屉底部不再堆三张满宽按钮：接入方式与退出登录都降级进设置面板，
  // 所以这两个 ID 不该再出现在静态页面里（设置面板的退出入口由 settings_view 覆盖）。
  for (const gone of ['btnSwitchLogin', 'btnServerMode']) {
    assert.equal(html.includes(`id="${gone}"`), false, `index.html 不应再有 #${gone}，它已经收进设置面板`);
  }
  // 设置入口改为用户栏整行：id 必须在 .foot-user 这个可点行上，而不是一张独立按钮卡片。
  assert.ok(
    /class="foot-user"\s+id="btnSettings"[^>]*role="button"/.test(html),
    '设置入口应该是 .foot-user 整行（role=button），不是额外一张按钮',
  );
  for (const banned of ['inCredential', 'tabLoginPassword', 'tabLoginCredential', 'loginCredentialPanel', 'loginPasswordPanel', 'login-mode-tab']) {
    assert.equal(html.includes(banned), false, `index.html 不能还有 ${banned}`);
  }
  // 退出入口现在由设置面板动态构建：文案住在 settings-view.js，index.html 不再承载按钮。
  const settingsSource = readFileSync(new URL('../web/settings-view.js', import.meta.url), 'utf8');
  assert.ok(settingsSource.includes('退出登录'), '设置面板应提供「退出登录」入口');
  assert.equal(html.includes('>退出登录<'), false, 'index.html 不应再直接放退出按钮');
  assert.equal(html.includes('切换登录'), false, '不应再提「切换登录」');
});

await t('源码边界：无 credential/mode/setMode，不碰存储/网络/日志', async () => {
  const source = readFileSync(new URL('../web/login-view.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const [pattern, label] of [
    [/\bcredential\b/i, 'credential'],
    [/\bmode\b/i, 'mode'],
    [/setMode/, 'setMode'],
    [/clipboard/i, 'clipboard'],
    [/localStorage|sessionStorage/, 'storage'],
    [/fetch\(/, 'fetch('],
    [/console\./, 'console.'],
    [/location\./, 'location.'],
  ]) {
    assert.equal(pattern.test(code), false, `视图不能使用 ${label}`);
  }
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
