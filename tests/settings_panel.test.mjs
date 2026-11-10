/* tests/settings_panel.test.mjs
 *
 * web/settings-panel.js（设置面板装配）的单元测试。
 *
 * 覆盖拆出去的这一块必须一模一样的接线行为：
 *   1. open() 的顺序：先关会话抽屉 → view.open() → setStreaming(isStreaming()) → 重画 →
 *      controller.load(...)；load 的四个参数在「有会话 / 无会话」两种情形下的取值规则；
 *   2. render() 把宿主的 currentViewMode() / currentThemeMode() 并进 state 再交给 view，
 *      且每次渲染都重新取（不缓存）；构造时先落一次字号；
 *   3. 切模型成功：bumpChipToken() + renderModelChip(新模型)；归属变了则两者都不调；
 *   4. 切模型失败：仍属本次点击才 flash；归属已变不 flash；
 *   5. 思考档位：成功不碰 chip；失败才 flash；过期不 flash；
 *   6. 字号：controller.setFontSize 之后重画；
 *   7. retry / retryThinking / notice / 接入方式 / 退出登录 / reset / close 的转发。
 *
 * 全部离线：settings-controller 与 settings-view 用假实现注入（真模块的行为由
 * tests/settings_controller.test.mjs 与 tests/settings_view.test.mjs 覆盖），
 * 这里只测「装配 + 归属校验」。没有浏览器、没有定时器等待。
 */

import assert from 'node:assert/strict';
import { createSettingsPanel } from '../web/settings-panel.js';

const flush = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/* ------------------------------------------------------------------ */
/* 假 settings-controller / settings-view                             */
/* ------------------------------------------------------------------ */

function makeController() {
  const calls = {
    load: [],
    setStreaming: [],
    switchModel: [],
    setThinkingLevel: [],
    setFontSize: [],
    retry: 0,
    retryThinking: 0,
    reset: 0,
    fetchSessionModel: [],
  };
  // 每个写各留一个钩子，用例可以换成立即成功 / 挂起 / 失败。
  const handlers = {
    switchModel: () => Promise.resolve(),
    setThinkingLevel: () => Promise.resolve(),
    retry: () => Promise.resolve(undefined),
    retryThinking: () => Promise.resolve(null),
  };

  const controller = {
    calls,
    handlers,
    state: { status: 'loaded', models: [], fontSize: '15px', thinkingLevels: ['off', 'high'] },
    load(options) { calls.load.push(options); return Promise.resolve(); },
    setStreaming(value) { calls.setStreaming.push(value); },
    switchModel(modelId, provider) {
      calls.switchModel.push({ modelId, provider });
      return handlers.switchModel(modelId, provider);
    },
    setThinkingLevel(level) {
      calls.setThinkingLevel.push(level);
      return handlers.setThinkingLevel(level);
    },
    setFontSize(size) {
      calls.setFontSize.push(size);
      controller.state = { ...controller.state, fontSize: size };
    },
    retry() { calls.retry += 1; return handlers.retry(); },
    retryThinking() { calls.retryThinking += 1; return handlers.retryThinking(); },
    reset() { calls.reset += 1; },
    getState() { return { ...controller.state }; },
    fetchSessionModel(path) { calls.fetchSessionModel.push(path); return Promise.resolve(null); },
  };
  return controller;
}

function makeView(order) {
  const calls = { open: 0, close: 0, isOpen: 0, render: [] };
  return {
    calls,
    open() {
      calls.open += 1;
      order.push('view.open');
    },
    close() { calls.close += 1; },
    isOpen() { calls.isOpen += 1; return true; },
    render(state) { calls.render.push(state); },
  };
}

/* ------------------------------------------------------------------ */
/* 装配                                                               */
/* ------------------------------------------------------------------ */

const AGENT_HOME = { id: 'agent-home', name: 'Hakimi', chatModel: 'Home Default' };
const AGENT_SECOND = { id: 'agent-2', name: 'Second', chatModel: 'Model Two' };

function defaultState() {
  return {
    principal: { id: 'p-1' },
    session: null,
    currentAgent: AGENT_HOME,
    busy: false,
    viewMode: 'serene',
    themeMode: 'auto',
  };
}

function makeHarness(overrides = {}) {
  const order = [];
  const hostState = overrides.state || defaultState();
  const controller = overrides.controller || makeController();
  const view = makeView(order);

  const hookCalls = {
    flash: [],
    chipTokens: 0,
    chipModels: [],
    findAgent: [],
    navigationEpoch: 0,
  };
  const apiCalls = [];
  const sysCalls = [];
  let viewOptions = null;
  let controllerOptions = null;

  const panel = createSettingsPanel({
    document: { fakeDoc: true },
    getElement: (id) => ({ id }),
    api: (pathname, init) => {
      apiCalls.push({ pathname, init });
      return Promise.resolve({ ok: true });
    },
    views: {
      closeDrawer: () => {
        sysCalls.push('closeDrawer');
        order.push('closeDrawer');
      },
      openLogin: () => sysCalls.push('openLogin'),
      goServerMode: () => sysCalls.push('goServerMode'),
    },
    getState: () => hostState,
    hooks: {
      navigationEpoch: () => {
        hookCalls.navigationEpoch += 1;
        return hostState.epoch || 0;
      },
      findAgentForSession: (session) => {
        hookCalls.findAgent.push(session);
        return session && session.agentId === AGENT_SECOND.id ? AGENT_SECOND : null;
      },
      renderModelChip: (model) => hookCalls.chipModels.push(model),
      bumpChipToken: () => { hookCalls.chipTokens += 1; },
      flash: (msg, opts) => hookCalls.flash.push({ msg, opts }),
      isStreaming: () => Boolean(hostState.busy),
      onThemeSelect: (mode) => sysCalls.push(`theme:${mode}`),
      onViewModeSelect: (mode) => sysCalls.push(`viewMode:${mode}`),
      currentViewMode: () => hostState.viewMode,
      currentThemeMode: () => hostState.themeMode,
    },
    createController: (options) => {
      controllerOptions = options;
      return controller;
    },
    createView: (options) => {
      viewOptions = options;
      order.push('createView');
      return view;
    },
  });

  return {
    panel,
    order,
    hostState,
    controller,
    view,
    hookCalls,
    apiCalls,
    sysCalls,
    getViewOptions: () => viewOptions,
    getControllerOptions: () => controllerOptions,
  };
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('构造：controller 拿到 request 与 onStateChange，view 拿到容器、文档与当前档位', () => {
  const h = makeHarness();
  const ctlOpts = h.getControllerOptions();
  const viewOpts = h.getViewOptions();

  assert.equal(typeof ctlOpts.request, 'function', 'controller 必须拿到 request');
  assert.equal(typeof ctlOpts.onStateChange, 'function', 'controller 必须拿到 onStateChange');

  assert.deepEqual(viewOpts.container, { id: 'settingsContainer' }, '容器就是 #settingsContainer');
  assert.deepEqual(viewOpts.document, { fakeDoc: true }, 'document 原样交给视图');
  assert.equal(viewOpts.viewMode, 'serene', '初始聊天视图取 currentViewMode()');
  assert.equal(viewOpts.themeMode, 'auto', '初始外观取 currentThemeMode()');
  assert.equal(h.panel.controller, h.controller, 'panel.controller 就是建出来的那个实例');
  assert.equal(h.panel.view, h.view, 'panel.view 就是建出来的那个实例');
});

t('构造时先落一次字号（启动路径）：view.render 收到 controller 的 state + 两个档位', () => {
  const h = makeHarness();
  assert.equal(h.view.calls.render.length, 1, '构造完成后应已渲染一次（落上次选的字号）');
  const first = h.view.calls.render[0];
  assert.equal(first.fontSize, '15px', '字号来自 controller 的 state');
  assert.equal(first.status, 'loaded', '其余字段原样透传');
  assert.equal(first.viewMode, 'serene', '并进当前聊天视图');
  assert.equal(first.themeMode, 'auto', '并进当前外观档位');
});

t('controller 的 onStateChange 会落到 view.render（生产路径），并带上最新档位', () => {
  const h = makeHarness();
  h.hostState.viewMode = 'classic';
  h.hostState.themeMode = 'dark';

  h.getControllerOptions().onStateChange({ status: 'loading', models: [] });
  const last = h.view.calls.render.at(-1);
  assert.equal(last.status, 'loading');
  assert.equal(last.viewMode, 'classic', '每次渲染都重新取 currentViewMode()，不用旧值');
  assert.equal(last.themeMode, 'dark', '每次渲染都重新取 currentThemeMode()');
});

t('构造后：request 把 pathname / init 原样转给 api', async () => {
  const h = makeHarness();
  const init = { method: 'POST', body: '{}' };
  await h.getControllerOptions().request('/api/models/switch', init);
  assert.equal(h.apiCalls.length, 1);
  assert.equal(h.apiCalls[0].pathname, '/api/models/switch');
  assert.equal(h.apiCalls[0].init, init);
});

t('open()：先关抽屉再开视图，并把 isStreaming() 交给 controller', () => {
  const h = makeHarness();
  h.hostState.busy = true;
  h.view.calls.render.length = 0;

  h.panel.open();

  assert.deepEqual(h.order, ['createView', 'closeDrawer', 'view.open'], '先关会话抽屉，再打开设置视图');
  assert.deepEqual(h.controller.calls.setStreaming, [true], 'setStreaming 收到 Boolean(busy)');
  assert.equal(h.view.calls.render.length, 1, '打开时按本地状态重画一次（字号先落地）');
  assert.equal(h.view.calls.render[0].viewMode, 'serene');
});

t('open() 有会话：agentId 用会话自己的 Agent，fallbackModel 用该 Agent 的 chatModel', () => {
  const session = { path: 'C:/sessions/a.jsonl', agentId: 'agent-2' };
  const h = makeHarness({
    state: { ...defaultState(), session, busy: true, currentAgent: AGENT_HOME },
  });

  h.panel.open();

  assert.equal(h.hookCalls.findAgent.length, 1, '有会话时必须按会话找 Agent');
  assert.equal(h.hookCalls.findAgent[0], session);
  assert.equal(h.controller.calls.load.length, 1);
  assert.deepEqual(h.controller.calls.load[0], {
    sessionPath: 'C:/sessions/a.jsonl',
    agentId: 'agent-2',
    streaming: true,
    fallbackModel: 'Model Two',
  });
});

t('open() 无会话：agentId / fallbackModel 用当前 Agent，且不去找会话所属 Agent', () => {
  const h = makeHarness({
    state: { ...defaultState(), session: null, busy: false, currentAgent: AGENT_HOME },
  });

  h.panel.open();

  assert.equal(h.hookCalls.findAgent.length, 0, '没有会话时不调用 findAgentForSession');
  assert.deepEqual(h.controller.calls.load[0], {
    sessionPath: null,
    agentId: 'agent-home',
    streaming: false,
    fallbackModel: 'Home Default',
  });
});

t('open() 有会话但找不回 Agent：agentId 仍用会话的，fallbackModel 退回 null（不借当前 Agent）', () => {
  const session = { path: 'C:/sessions/unknown.jsonl', agentId: 'agent-ghost' };
  const h = makeHarness({ state: { ...defaultState(), session } });

  h.panel.open();

  assert.deepEqual(h.controller.calls.load[0], {
    sessionPath: 'C:/sessions/unknown.jsonl',
    agentId: 'agent-ghost',
    streaming: false,
    fallbackModel: null,
  });
});

t('切模型成功：bumpChipToken + renderModelChip(响应里的模型)', async () => {
  const h = makeHarness();
  h.controller.handlers.switchModel = () => Promise.resolve({ model: { id: 'model-x', name: 'Model X' } });

  h.getViewOptions().onSelectModel('model-x', 'prov');
  await flush();

  assert.deepEqual(h.controller.calls.switchModel, [{ modelId: 'model-x', provider: 'prov' }]);
  assert.equal(h.hookCalls.chipTokens, 1, '写成功后要作废旧 chip GET');
  assert.deepEqual(h.hookCalls.chipModels, [{ id: 'model-x', name: 'Model X' }], 'chip 画成响应里的模型');
  assert.deepEqual(h.hookCalls.flash, [], '成功不提示');
});

t('切模型成功但响应只有 modelId：chip 用 modelId 兜底；controller 返回 null 时什么都不写', async () => {
  const h = makeHarness();
  h.controller.handlers.switchModel = () => Promise.resolve({ modelId: 'model-y' });
  h.getViewOptions().onSelectModel('model-y', 'prov');
  await flush();
  assert.deepEqual(h.hookCalls.chipModels, ['model-y'], '响应里没有 model 时用 modelId 兜底');

  // null = 过期写 / 重复写：不回写 chip，也不再作废 GET。
  h.controller.handlers.switchModel = () => Promise.resolve(null);
  h.getViewOptions().onSelectModel('model-z', 'prov');
  await flush();
  assert.equal(h.hookCalls.chipTokens, 1, 'null 结果不能 bumpChipToken');
  assert.equal(h.hookCalls.chipModels.length, 1, 'null 结果不能改 chip');
});

t('切模型成功但归属变了（await 期间换了 principal）：chip 与 token 都不动', async () => {
  const h = makeHarness();
  const gate = deferred();
  h.controller.handlers.switchModel = () => gate.promise;

  h.getViewOptions().onSelectModel('model-x', 'prov');
  await flush();
  assert.equal(h.controller.calls.switchModel.length, 1, '前置：请求已发出');

  h.hostState.principal = { id: 'p-2' };
  gate.resolve({ model: { id: 'model-x', name: 'Model X' } });
  await flush();

  assert.equal(h.hookCalls.chipTokens, 0, '归属变了不能作废当前会话的 chip GET');
  assert.deepEqual(h.hookCalls.chipModels, [], '归属变了不能改当前界面的 chip');
});

t('切模型成功但归属变了（await 期间换了会话）：chip 与 token 都不动', async () => {
  const h = makeHarness({ state: { ...defaultState(), session: { path: 'C:/a.jsonl', agentId: 'agent-2' } } });
  const gate = deferred();
  h.controller.handlers.switchModel = () => gate.promise;

  h.getViewOptions().onSelectModel('model-x', 'prov');
  await flush();

  h.hostState.session = { path: 'C:/b.jsonl', agentId: 'agent-2' };
  gate.resolve({ model: { id: 'model-x', name: 'Model X' } });
  await flush();

  assert.equal(h.hookCalls.chipTokens, 0);
  assert.deepEqual(h.hookCalls.chipModels, []);
});

t('切模型成功但导航代次变了：chip 与 token 都不动', async () => {
  const h = makeHarness();
  const gate = deferred();
  h.controller.handlers.switchModel = () => gate.promise;

  h.getViewOptions().onSelectModel('model-x', 'prov');
  await flush();

  h.hostState.epoch = 7;
  gate.resolve({ model: { id: 'model-x', name: 'Model X' } });
  await flush();

  assert.equal(h.hookCalls.chipTokens, 0);
  assert.deepEqual(h.hookCalls.chipModels, []);
});

t('切模型失败：仍属本次点击就 flash 一次（用错误文案兜底）', async () => {
  const h = makeHarness();
  h.controller.handlers.switchModel = () => Promise.reject(new Error('写模型失败'));

  h.getViewOptions().onSelectModel('model-x', 'prov');
  await flush();

  assert.equal(h.hookCalls.flash.length, 1, '同会话失败要提示一次');
  assert.equal(h.hookCalls.flash[0].msg, '写模型失败');
  assert.equal(h.hookCalls.chipTokens, 0, '失败不改 chip');
});

t('切模型失败但归属已变：不 flash（旧会话/旧身份的错误不外泄）', async () => {
  const h = makeHarness();
  const gate = deferred();
  h.controller.handlers.switchModel = () => gate.promise;

  h.getViewOptions().onSelectModel('model-x', 'prov');
  await flush();

  h.hostState.principal = { id: 'p-2' };
  gate.reject(new Error('写模型失败'));
  await flush();

  assert.deepEqual(h.hookCalls.flash, [], '过期失败不能冒到新身份头上');
});

t('思考档位成功：不碰 chip（token 与 chip 都不动）', async () => {
  const h = makeHarness();
  h.controller.handlers.setThinkingLevel = () => Promise.resolve({ thinkingLevel: 'high' });

  h.getViewOptions().onSelectThinkingLevel('high');
  await flush();

  assert.deepEqual(h.controller.calls.setThinkingLevel, ['high']);
  assert.equal(h.hookCalls.chipTokens, 0, '思考档位不改模型 chip');
  assert.deepEqual(h.hookCalls.chipModels, []);
  assert.deepEqual(h.hookCalls.flash, [], '成功不提示');
});

t('思考档位失败：仍属本次点击就 flash；过期则不 flash', async () => {
  const h = makeHarness();
  h.controller.handlers.setThinkingLevel = () => Promise.reject(new Error('写档位失败'));
  h.getViewOptions().onSelectThinkingLevel('high');
  await flush();
  assert.equal(h.hookCalls.flash.length, 1);
  assert.equal(h.hookCalls.flash[0].msg, '写档位失败');

  // 过期：await 期间会话被换掉
  const gate = deferred();
  h.controller.handlers.setThinkingLevel = () => gate.promise;
  h.getViewOptions().onSelectThinkingLevel('off');
  await flush();
  h.hostState.session = { path: 'C:/other.jsonl', agentId: 'agent-2' };
  gate.reject(new Error('写档位失败'));
  await flush();
  assert.equal(h.hookCalls.flash.length, 1, '过期失败不能再冒提示');
});

t('思考档位成功但归属已变：controller 返回非 null 也不改任何界面（chip 本来就不碰）', async () => {
  const h = makeHarness();
  const gate = deferred();
  h.controller.handlers.setThinkingLevel = () => gate.promise;

  h.getViewOptions().onSelectThinkingLevel('high');
  await flush();

  h.hostState.principal = { id: 'p-2' };
  gate.resolve({ thinkingLevel: 'high' });
  await flush();

  assert.deepEqual(h.hookCalls.flash, []);
  assert.equal(h.hookCalls.chipTokens, 0);
});

t('字号变更：controller.setFontSize 之后重画（render 次数 +1，state 带新字号）', () => {
  const h = makeHarness();
  const before = h.view.calls.render.length;

  h.getViewOptions().onSelectFontSize('17px');

  assert.deepEqual(h.controller.calls.setFontSize, ['17px']);
  assert.equal(h.view.calls.render.length, before + 1, '字号变更后必须重画一次');
  assert.equal(h.view.calls.render.at(-1).fontSize, '17px', '重画用的是 controller 的新 state');
});

t('retry / retryThinking / notice / 接入方式 / 退出登录 / onClose 各自转发', async () => {
  const h = makeHarness();
  const viewOpts = h.getViewOptions();

  await viewOpts.onRetry();
  assert.equal(h.controller.calls.retry, 1, 'onRetry 走 controller.retry');

  await viewOpts.onRetryThinking();
  assert.equal(h.controller.calls.retryThinking, 1, 'onRetryThinking 走 controller.retryThinking');
  assert.deepEqual(h.hookCalls.flash, [], '档位重拉成功不提示');

  viewOpts.onNotice('正在生成，结束后再切');
  assert.equal(h.hookCalls.flash.length, 1, 'onNotice 走 flash');
  assert.equal(h.hookCalls.flash[0].msg, '正在生成，结束后再切');
  assert.equal(h.hookCalls.flash[0].opts?.level, 'info', 'notice 一律 info 级');

  viewOpts.onServerMode();
  viewOpts.onLogout();
  assert.deepEqual(h.sysCalls, ['goServerMode', 'openLogin'], '接入方式与退出登录交给宿主');

  viewOpts.onSelectTheme('dark');
  viewOpts.onSelectViewMode('classic');
  assert.deepEqual(h.sysCalls.slice(2), ['theme:dark', 'viewMode:classic'], '外观与聊天视图的落地也在宿主');

  const beforeClose = h.view.calls.close;
  viewOpts.onClose();
  assert.equal(h.view.calls.close, beforeClose + 1, 'onClose 关的是 view 自己');
});

t('retryThinking 失败：flash 兜底文案', async () => {
  const h = makeHarness();
  h.controller.handlers.retryThinking = () => Promise.reject(new Error(''));

  await h.getViewOptions().onRetryThinking();

  assert.equal(h.hookCalls.flash.length, 1);
  assert.equal(h.hookCalls.flash[0].msg, '读取思考档位失败', '空错误消息时用兜底文案');
});

t('reset() 转发 controller.reset，close() / isOpen() 转发 view', () => {
  const h = makeHarness();

  h.panel.reset();
  assert.equal(h.controller.calls.reset, 1, 'reset 走 controller.reset');

  h.panel.close();
  assert.equal(h.view.calls.close, 1, 'close 走 view.close');

  assert.equal(h.panel.isOpen(), true);
  assert.equal(h.view.calls.isOpen, 1, 'isOpen 走 view.isOpen');
});

/* ------------------------------------------------------------------ */

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${error?.stack || error}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} 通过`);
if (failed) {
  console.log(`${failed} 个用例失败`);
  process.exitCode = 1;
}
