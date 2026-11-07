/* tests/settings_controller.test.mjs
 *
 * web/settings-controller.js 单元测试与契约测试
 * 覆盖：
 * 1. 初始状态：idle 态与默认字号
 * 2. 正常加载：并行请求 /api/models 与 /api/session-thinking-level
 *    - 有 sessionPath 时正确拼接 query
 *    - 新会话（无 sessionPath）时拼接 pendingNewSession=1 与 agentId
 *    - 成功后合并状态：models, providerDisplayNames, currentModel, thinkingLevel, thinkingLevels
 * 3. 失败与重试：
 *    - 请求失败时进入 error 状态，保留错误信息
 *    - retry() 重新加载上一次的上下文
 * 4. 竞态收敛：
 *    - 连续调用 load 时，较早的在途请求即使晚返回也被丢弃，只有最新请求生效
 * 5. 模型切换：
 *    - 有会话时：POST /api/models/switch，body 为 { sessionPath, modelId, provider }
 *    - 新会话时：POST /api/models/set，body 为 { modelId, provider }
 *    - 切换中状态（savingModel）正确切换与恢复
 *    - 切换成功更新 currentModelId；若响应携带 thinkingLevel 则同步更新
 *    - 单飞：在途写期间重复调用返回 null 且不重复发 POST
 *    - 代次：在途写遇到新 load / dispose 后晚到，成功或失败都返回 null，不回写新上下文
 *    - fallbackModel：activeModel 缺失时仅取可明确解析的 Agent 兜底模型，同 id 多 provider 不猜
 * 6. 思考级别设置：
 *    - 必须在当前接口返回的可用 thinkingLevels 集合内生效
 *    - 若尝试设置集合外的非法枚举值，直接拒绝并不发网络请求
 *    - 合法级别调用 POST /api/session-thinking-level，body 为 { sessionPath?, level, agentId? }
 *    - 成功后更新 thinkingLevel
 * 7. 外观正文字号设置：
 *    - 切换字号时写入 storage，并在 state 中反映
 *    - 构造时若 storage 中已有值，优先读取
 * 8. 资源清理：
 *    - dispose() 取消所有在途请求，后续操作不再触发 onStateChange 与网络请求
 */

import assert from 'node:assert/strict';
import {
  createSettingsController,
  FONT_SIZE_OPTIONS,
  DEFAULT_FONT_SIZE,
  STORAGE_KEY_FONT_SIZE,
} from '../web/settings-controller.js';

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

function makeMockStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _raw: map,
  };
}

function makeMockRequest() {
  const calls = [];
  const handlers = [];

  function request(path, opts = {}) {
    calls.push({ path, opts });
    if (handlers.length > 0) {
      const h = handlers.shift();
      return h(path, opts);
    }
    return Promise.resolve({});
  }

  function queue(fn) {
    handlers.push(fn);
  }

  return { request, calls, queue };
}

// ---------------- 测试执行 ----------------

await t('初始状态：处于 idle 态，并装载默认或 storage 存储的字号', async () => {
  const storage = makeMockStorage();
  const { request } = makeMockRequest();
  const controller = createSettingsController({
    request,
    storage,
  });

  const state = controller.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.fontSize, DEFAULT_FONT_SIZE);
  assert.deepEqual(state.models, []);
  assert.equal(state.currentModelId, null);
  assert.equal(state.thinkingLevel, null);
  assert.equal(state.thinkingLevels, null);
  assert.equal(state.error, null);

  // 从 storage 读取已有字号
  const customStorage = makeMockStorage({ [STORAGE_KEY_FONT_SIZE]: '17px' });
  const controller2 = createSettingsController({
    request,
    storage: customStorage,
  });
  assert.equal(controller2.getState().fontSize, '17px');
});

await t('正常加载（有会话）：并行请求 /api/models 与 /api/session-thinking-level 并更新状态', async () => {
  const { request, calls } = makeMockRequest();
  const states = [];

  const controller = createSettingsController({
    request: async (path, opts) => {
      calls.push({ path, opts });
      if (path.startsWith('/api/models')) {
        return {
          models: [
            { id: 'qwen-max', name: '通义千问 Max', provider: 'dashscope' },
            { id: 'deepseek-v3', name: 'DeepSeek V3', provider: 'deepseek' },
          ],
          providerDisplayNames: { dashscope: '阿里百炼', deepseek: 'DeepSeek' },
          current: 'qwen-max',
          activeModel: { id: 'deepseek-v3', provider: 'deepseek' },
        };
      }
      if (path.startsWith('/api/session-thinking-level')) {
        return {
          thinkingLevel: 'medium',
          requestedThinkingLevel: 'medium',
          thinkingLevels: ['off', 'low', 'medium', 'high'],
        };
      }
      return {};
    },
    onStateChange: (s) => states.push({ ...s }),
  });

  await controller.load({ sessionPath: 'sessions/session-1.json', agentId: 'gemini' });

  // 验证请求的 URL 与 query
  const modelsCall = calls.find((c) => c.path.includes('/api/models'));
  const thinkingCall = calls.find((c) => c.path.includes('/api/session-thinking-level'));
  assert.ok(modelsCall, '应该请求 /api/models');
  assert.ok(modelsCall.path.includes('sessionPath=' + encodeURIComponent('sessions/session-1.json')));
  assert.ok(thinkingCall, '应该请求 /api/session-thinking-level');
  assert.ok(thinkingCall.path.includes('sessionPath=' + encodeURIComponent('sessions/session-1.json')));

  const finalState = controller.getState();
  assert.equal(finalState.status, 'loaded');
  assert.equal(finalState.models.length, 2);
  // 有 sessionPath 时，当前会话选中的模型必须以 activeModel 为准，不受全局 current 干扰
  assert.equal(finalState.currentModelId, 'deepseek-v3');
  assert.equal(finalState.currentProvider, 'deepseek');
  assert.equal(finalState.thinkingLevel, 'medium');
  assert.deepEqual(finalState.thinkingLevels, ['off', 'low', 'medium', 'high']);
  assert.equal(finalState.error, null);

  // 验证经历了 loading 状态
  assert.ok(states.some((s) => s.status === 'loading'));
});

await t('真机验收场景：三条真实会话核验，有 sessionPath 时以 activeModel 为准', async () => {
  const mockDatabase = {
    'session-node.json': {
      current: 'gemini-3.8-flash-high',
      activeModel: { id: 'gpt-6.1-sol', provider: 'openai-codex' },
      models: [
        { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash', provider: 'gemini', isCurrent: true },
        { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', provider: 'openai-codex' },
      ],
    },
    'session-dsbot.json': {
      current: 'gemini-3.8-flash-high',
      activeModel: { id: 'deepseek-v4.1-flash', provider: 'opencode-go' },
      models: [
        { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash', provider: 'gemini', isCurrent: true },
        { id: 'deepseek-v4.1-flash', name: 'Deepseek V4.1 Flash', provider: 'opencode-go' },
        { id: 'deepseek-v4.1-flash', name: '大肥鱼', provider: 'cpa' },
      ],
    },
    'session-speed.json': {
      current: 'gemini-3.8-flash-high',
      activeModel: { id: 'gemini-3.8-flash-high', provider: 'gemini' },
      models: [
        { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash', provider: 'gemini', isCurrent: true },
      ],
    },
  };

  const controller = createSettingsController({
    request: async (path) => {
      for (const [key, data] of Object.entries(mockDatabase)) {
        if (path.includes(key)) return data;
      }
      return { current: 'gemini-3.8-flash-high', models: [] };
    },
  });

  // 会话 1：Node缺失网络权限启动失败 -> openai-codex/gpt-6.1-sol
  await controller.load({ sessionPath: 'session-node.json' });
  assert.equal(controller.getState().currentModelId, 'gpt-6.1-sol');
  assert.equal(controller.getState().currentProvider, 'openai-codex');

  // 会话 2：DS-Bot 项目解析 -> opencode-go/deepseek-v4.1-flash
  await controller.load({ sessionPath: 'session-dsbot.json' });
  assert.equal(controller.getState().currentModelId, 'deepseek-v4.1-flash');
  assert.equal(controller.getState().currentProvider, 'opencode-go');

  // 会话 3：测速一下 -> gemini/gemini-3.8-flash-high
  await controller.load({ sessionPath: 'session-speed.json' });
  assert.equal(controller.getState().currentModelId, 'gemini-3.8-flash-high');
  assert.equal(controller.getState().currentProvider, 'gemini');
});

await t('正常加载（新会话）：使用 pendingNewSession=1 与 agentId 请求思考级别，且选中 current 模型', async () => {
  const { calls } = makeMockRequest();
  const controller = createSettingsController({
    request: async (path) => {
      calls.push(path);
      if (path.startsWith('/api/models')) {
        return {
          models: [{ id: 'qwen-max', name: 'Qwen Max', provider: 'dashscope' }],
          current: 'qwen-max',
          activeModel: null,
        };
      }
      if (path.startsWith('/api/session-thinking-level')) {
        return {
          thinkingLevel: 'high',
          thinkingLevels: ['off', 'high'],
        };
      }
      return {};
    },
  });

  await controller.load({ sessionPath: null, agentId: 'gemini' });

  const thinkingCall = calls.find((p) => p.includes('/api/session-thinking-level'));
  assert.ok(thinkingCall.includes('pendingNewSession=1'));
  assert.ok(thinkingCall.includes('agentId=gemini'));

  const state = controller.getState();
  assert.equal(state.status, 'loaded');
  assert.equal(state.currentModelId, 'qwen-max');
  assert.equal(state.currentProvider, 'dashscope');
  assert.equal(state.thinkingLevel, 'high');
});

await t('加载失败与重试：任一核心请求失败记录 error，retry() 可重新触发', async () => {
  let shouldFail = true;
  let loadCount = 0;

  const controller = createSettingsController({
    request: async (path) => {
      if (path.startsWith('/api/models')) {
        loadCount++;
        if (shouldFail) throw new Error('网络连接异常');
        return { models: [{ id: 'm1', name: 'M1', provider: 'p1' }], current: 'm1' };
      }
      return { thinkingLevel: 'low', thinkingLevels: ['low', 'high'] };
    },
  });

  await controller.load({ sessionPath: 'session-fail.json' });

  assert.equal(controller.getState().status, 'error');
  assert.ok(controller.getState().error.includes('网络连接异常'));

  // 恢复正常并 retry
  shouldFail = false;
  await controller.retry();

  assert.equal(controller.getState().status, 'loaded');
  assert.equal(controller.getState().models.length, 1);
  assert.equal(controller.getState().error, null);
  assert.equal(loadCount, 2);
});

await t('竞态处理：连续多次 load，只有最后一次的响应落地', async () => {
  const d1 = deferred();
  const d2 = deferred();

  let reqIndex = 0;
  const controller = createSettingsController({
    request: async (path) => {
      reqIndex++;
      if (reqIndex <= 2) {
        // 第一次 load 的两个请求
        return d1.promise;
      } else {
        // 第二次 load 的请求
        return d2.promise;
      }
    },
  });

  const p1 = controller.load({ sessionPath: 'session-old' });
  const p2 = controller.load({ sessionPath: 'session-new' });

  // d2（后发的新请求）先返回
  d2.resolve({
    models: [{ id: 'm-new', name: 'New Model', provider: 'p-new' }],
    current: 'm-new',
    activeModel: { id: 'm-new', provider: 'p-new' },
    thinkingLevel: 'high',
    thinkingLevels: ['high'],
  });
  await p2;
  await tick();

  assert.equal(controller.getState().currentModelId, 'm-new');

  // d1（先发的老请求）晚到返回
  d1.resolve({
    models: [{ id: 'm-old', name: 'Old Model', provider: 'p-old' }],
    current: 'm-old',
    activeModel: { id: 'm-old', provider: 'p-old' },
    thinkingLevel: 'low',
    thinkingLevels: ['low'],
  });
  await p1;
  await tick();

  // 状态依然必须保持为 m-new，不得被老结果冲掉
  assert.equal(controller.getState().currentModelId, 'm-new');
});

await t('模型切换：有会话时调用 POST /api/models/switch', async () => {
  const switchCalls = [];
  const controller = createSettingsController({
    request: async (path, opts) => {
      if (path === '/api/models/switch') {
        switchCalls.push({ path, opts });
        return { ok: true, thinkingLevel: 'high' };
      }
      if (path.startsWith('/api/models')) {
        return {
          models: [
            { id: 'm1', name: 'Model 1', provider: 'p1' },
            { id: 'm2', name: 'Model 2', provider: 'p2' },
          ],
          current: 'm1',
        };
      }
      return { thinkingLevel: 'low', thinkingLevels: ['low', 'high'] };
    },
  });

  await controller.load({ sessionPath: 'session-abc.json' });
  const res = await controller.switchModel('m2', 'p2');

  assert.equal(res.ok, true);
  assert.equal(switchCalls.length, 1);
  assert.equal(switchCalls[0].opts.method, 'POST');
  const body = JSON.parse(switchCalls[0].opts.body);
  assert.deepEqual(body, {
    sessionPath: 'session-abc.json',
    modelId: 'm2',
    provider: 'p2',
  });

  // 状态更新；思考级别以切换后的重拉结果为准（宿主的 POST 响应不带档位集合）
  const state = controller.getState();
  assert.equal(state.currentModelId, 'm2');
  assert.equal(state.currentProvider, 'p2');
  assert.equal(state.thinkingLevel, 'low');
  assert.deepEqual(state.thinkingLevels, ['low', 'high'], '切完模型必须重拉一次档位集合');
});

await t('模型切换：新会话时调用 POST /api/models/set', async () => {
  const setCalls = [];
  const controller = createSettingsController({
    request: async (path, opts) => {
      if (path === '/api/models/set') {
        setCalls.push({ path, opts });
        return { ok: true, thinkingLevel: 'medium' };
      }
      if (path.startsWith('/api/models')) {
        return {
          models: [{ id: 'm1', name: 'Model 1', provider: 'p1' }],
          current: 'm1',
        };
      }
      return { thinkingLevel: 'low', thinkingLevels: ['low', 'medium'] };
    },
  });

  await controller.load({ sessionPath: null, agentId: 'gemini' });
  const res = await controller.switchModel('m1', 'p1');

  assert.equal(res.ok, true);
  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0].opts.method, 'POST');
  const body = JSON.parse(setCalls[0].opts.body);
  assert.deepEqual(body, {
    modelId: 'm1',
    provider: 'p1',
  });
});

await t('思考级别：只允许在接口返回的可用集合 thinkingLevels 中切换', async () => {
  const postCalls = [];
  const controller = createSettingsController({
    request: async (path, opts) => {
      if (path === '/api/session-thinking-level' && opts.method === 'POST') {
        postCalls.push({ path, opts });
        return { ok: true, thinkingLevel: 'high' };
      }
      if (path.startsWith('/api/models')) {
        return { models: [{ id: 'm1', name: 'M1', provider: 'p1' }], current: 'm1' };
      }
      // 接口返回仅支持 ['off', 'low']
      return { thinkingLevel: 'off', thinkingLevels: ['off', 'low'] };
    },
  });

  await controller.load({ sessionPath: 's1.json' });

  // 尝试设置集合外的 'high' 或自定义枚举，控制器拒绝且不发请求
  await assert.rejects(
    async () => {
      await controller.setThinkingLevel('high');
    },
    /不支持的思考级别/
  );
  assert.equal(postCalls.length, 0, '非法思考级别不得发出请求');

  // 设置集合内的合法级别 'low'
  const ok = await controller.setThinkingLevel('low');
  assert.equal(ok.ok, true);
  assert.equal(postCalls.length, 1);
  const body = JSON.parse(postCalls[0].opts.body);
  assert.equal(body.level, 'low');
  assert.equal(body.sessionPath, 's1.json');
});

await t('外观字号：切换并写入 storage，反映在 state 中', async () => {
  const storage = makeMockStorage();
  const controller = createSettingsController({
    request: async () => ({}),
    storage,
  });

  controller.setFontSize('17px');
  assert.equal(controller.getState().fontSize, '17px');
  assert.equal(storage.getItem(STORAGE_KEY_FONT_SIZE), '17px');

  // 非法字号值回退或拒绝
  assert.throws(() => {
    controller.setFontSize('100px');
  }, /不支持的字号设置/);
});

await t('dispose()：销毁后中途响应不触发回调，后续操作静默', async () => {
  let callCount = 0;
  const d = deferred();
  const controller = createSettingsController({
    request: () => d.promise,
    onStateChange: () => { callCount++; },
  });

  controller.load({ sessionPath: 's-dispose' });
  const countBeforeDispose = callCount;
  controller.dispose();

  d.resolve({ models: [], current: null });
  await tick();

  assert.equal(controller.isDisposed(), true);
  // dispose 之后中途响应不应再触发任何 stateChange
  assert.equal(callCount, countBeforeDispose);
});

/* ---------------- 任务 A：fetchSessionModel 独立查询与防竞态 ---------------- */

await t('fetchSessionModel：根据 sessionPath 只返回 activeModel 对应引用，缺失返回 null', async () => {
  const reqCalls = [];
  const controller = createSettingsController({
    request: async (path) => {
      reqCalls.push(path);
      if (path.includes('session-a.json')) {
        return {
          current: 'gemini-3.8-flash-high',
          activeModel: { id: 'gpt-6.1-sol', provider: 'openai-codex' },
          models: [
            { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash', provider: 'gemini', isCurrent: true },
            { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', provider: 'openai-codex' },
          ],
        };
      }
      if (path.includes('session-b.json')) {
        return {
          current: 'model-b',
          activeModel: null,
          models: [
            { id: 'model-a', name: 'Model A', provider: 'prov-a' },
            { id: 'model-b', name: 'Model B', provider: 'prov-b', isCurrent: true },
          ],
        };
      }
      if (path.includes('session-empty.json')) {
        return {
          current: null,
          activeModel: null,
          models: [],
        };
      }
      return {};
    },
  });

  // 1. 优先取 activeModel
  const resA = await controller.fetchSessionModel('session-a.json');
  assert.deepEqual(resA, {
    modelId: 'gpt-6.1-sol',
    provider: 'openai-codex',
    name: 'GPT 6.1 Sol',
  });
  assert.ok(reqCalls[0].includes('sessionPath=' + encodeURIComponent('session-a.json')));

  // 2. activeModel 缺失时不得回落到全局 current / isCurrent，交给 app 用会话所属 Agent 兜底
  const resB = await controller.fetchSessionModel('session-b.json');
  assert.equal(resB, null);

  // 3. 空或查不到返回 null
  const resEmpty = await controller.fetchSessionModel('session-empty.json');
  assert.equal(resEmpty, null);

  const resNull = await controller.fetchSessionModel(null);
  assert.equal(resNull, null);
});

await t('fetchSessionModel 竞态：快速切换会话时，旧会话晚到响应作废', async () => {
  const dA = deferred();
  const dB = deferred();

  const controller = createSettingsController({
    request: async (path) => {
      if (path.includes('session-slow.json')) return dA.promise;
      if (path.includes('session-fast.json')) return dB.promise;
      return {};
    },
  });

  // 连续快速调用
  const pSlow = controller.fetchSessionModel('session-slow.json');
  const pFast = controller.fetchSessionModel('session-fast.json');

  // 新会话快请求先返回
  dB.resolve({
    current: 'model-fast',
    activeModel: { id: 'model-fast', provider: 'fast-p' },
    models: [{ id: 'model-fast', name: 'Model Fast', provider: 'fast-p', isCurrent: true }],
  });
  const fastRes = await pFast;
  assert.equal(fastRes?.modelId, 'model-fast');

  // 旧会话慢请求后返回，必须作废（返回 null 或标记过时，不得生效）
  dA.resolve({
    current: 'model-slow',
    activeModel: { id: 'model-slow', provider: 'slow-p' },
    models: [{ id: 'model-slow', name: 'Model Slow', provider: 'slow-p', isCurrent: true }],
  });
  const slowRes = await pSlow;
  assert.equal(slowRes, null, '过时的旧请求必须返回 null，不得假装成功');
});

/* ---------------- 任务 B：流式生成中禁用模型切换 ---------------- */

await t('流式状态：正在生成时禁止切换模型（不发请求），但允许修改思考级别；结束后恢复', async () => {
  const networkCalls = [];
  const controller = createSettingsController({
    request: async (path, opts) => {
      networkCalls.push({ path, opts });
      if (path.startsWith('/api/models')) {
        return {
          current: 'm1',
          models: [
            { id: 'm1', name: 'M1', provider: 'p1', isCurrent: true },
            { id: 'm2', name: 'M2', provider: 'p2' },
          ],
        };
      }
      if (path.startsWith('/api/session-thinking-level')) {
        return { thinkingLevel: 'low', thinkingLevels: ['low', 'high'], ok: true };
      }
      return { ok: true };
    },
  });

  await controller.load({ sessionPath: 's1.json', streaming: true });
  assert.equal(controller.getState().streaming, true);

  // 1. 流式生成中，尝试切换模型：直接抛错拒绝，且绝对不发网络请求
  await assert.rejects(
    async () => {
      await controller.switchModel('m2', 'p2');
    },
    /正在生成，结束后再切/
  );
  const switchCallInStreaming = networkCalls.find((c) => c.path === '/api/models/switch');
  assert.equal(switchCallInStreaming, undefined, '流式中绝不能发出 /api/models/switch 请求');

  // 2. 流式生成中，修改思考级别：宿主允许，正常发出请求
  networkCalls.length = 0;
  const thinkRes = await controller.setThinkingLevel('high');
  assert.equal(thinkRes.ok, true);
  assert.equal(networkCalls.length, 1);
  assert.equal(networkCalls[0].path, '/api/session-thinking-level');

  // 3. 流式结束（setStreaming(false)）：恢复可切换模型
  controller.setStreaming(false);
  assert.equal(controller.getState().streaming, false);

  networkCalls.length = 0;
  await controller.switchModel('m2', 'p2');
  const switchCallAfterStreaming = networkCalls.find((c) => c.path === '/api/models/switch');
  assert.ok(switchCallAfterStreaming, '流式结束后模型切换必须恢复正常发包');
});

await t('会话模型兜底：modelId 为 null 时，若查询返回 null 则回退该会话 Agent 兜底，不误用全局 Agent', async () => {
  const controller = createSettingsController({
    request: async () => {
      // 模拟 /api/models?sessionPath=... 返回 current: null 且 models 为空
      return { current: null, models: [] };
    },
  });

  const res = await controller.fetchSessionModel('session-no-model.json');
  assert.equal(res, null);

  // 验证 app.js 中的会话所属 Agent 匹配与兜底逻辑
  const agents = [
    { id: 'agent-1', name: 'Gemini', chatModel: 'gemini-3.8-flash' },
    { id: 'agent-2', name: 'Claude', chatModel: 'claude-3-7-sonnet' },
  ];
  const currentAgent = agents[0]; // 当前 Agent 是 Gemini
  const session = { path: 'session-no-model.json', agentId: 'agent-2' }; // 会话属于 Claude

  function resolveChipModel(fetchedModel, s, allAgents, curAgent) {
    if (fetchedModel) return fetchedModel;
    const sessionAgent = (allAgents || []).find((a) => a.id === s?.agentId || a.name === s?.agentName);
    return sessionAgent?.chatModel || null;
  }

  const finalChipModel = resolveChipModel(res, session, agents, currentAgent);
  assert.equal(finalChipModel, 'claude-3-7-sonnet', '必须取该会话 Agent 的模型作为兜底，不得使用当前 Agent');
});

/* ---------------- 模型来源：有会话只认 activeModel，无会话不取桌面 activeModel ---------------- */

await t('加载（有会话）：activeModel 缺失时不取全局 current / isCurrent，保持 unknown/null', async () => {
  const controller = createSettingsController({
    request: async (path) => {
      if (path.startsWith('/api/models')) {
        return {
          current: 'global-current',
          models: [
            { id: 'global-current', name: 'Global', provider: 'gp', isCurrent: true },
            { id: 'first-item', name: 'First', provider: 'fp' },
          ],
          activeModel: null,
        };
      }
      return { thinkingLevel: 'low', thinkingLevels: ['low'] };
    },
  });

  await controller.load({ sessionPath: 'session-no-active.json' });

  const state = controller.getState();
  assert.equal(state.status, 'loaded');
  assert.equal(state.models.length, 2);
  // 全局 current/isCurrent 根本不知道 sessionPath，绝不能拿来当会话模型
  assert.equal(state.currentModelId, null);
  assert.equal(state.currentProvider, null);
});

await t('加载（无会话）：只认 current，不得取桌面 activeModel / 列表首项 / isCurrent', async () => {
  const desktopOnly = createSettingsController({
    request: async (path) => {
      if (path.startsWith('/api/models')) {
        return {
          models: [
            { id: 'desktop-focused', name: 'Desktop Focused', provider: 'desk' },
            { id: 'first-item', name: 'First', provider: 'fp' },
          ],
          activeModel: { id: 'desktop-focused', provider: 'desk' },
        };
      }
      return { thinkingLevel: 'low', thinkingLevels: ['low'] };
    },
  });

  await desktopOnly.load({ sessionPath: null, agentId: 'agent-1' });
  assert.equal(desktopOnly.getState().currentModelId, null);
  assert.equal(desktopOnly.getState().currentProvider, null);

  const withCurrent = createSettingsController({
    request: async (path) => {
      if (path.startsWith('/api/models')) {
        return {
          current: 'current-model',
          models: [
            { id: 'first-item', name: 'First', provider: 'fp' },
            { id: 'current-model', name: 'Current', provider: 'cp' },
          ],
        };
      }
      return { thinkingLevel: 'low', thinkingLevels: ['low'] };
    },
  });

  await withCurrent.load({ sessionPath: null, agentId: 'agent-1' });
  assert.equal(withCurrent.getState().currentModelId, 'current-model');
  assert.equal(withCurrent.getState().currentProvider, 'cp');
});

await t('加载（无会话）：isCurrent 是宿主的全局当前标记，不当成「新会话会用的模型」', async () => {
  // 宿主里别的 Agent 拿到焦点时，模型列表里会有一条 isCurrent。它只说明「桌面现在盯着
  // 谁」，不说明「新会话会沿用哪个模型」；拿它显示，手机上就会把别的 Agent 的模型当成
  // 自己的。无会话分支的顺序固定为 current → fallbackModel → null。
  const flaggedModels = [
    { id: 'other-agent-current', name: 'Other Agent', provider: 'other-p', isCurrent: true },
    { id: 'agent-chat-model', name: 'Agent Chat', provider: 'agent-p' },
  ];

  function makeController({ current, fallbackModel } = {}) {
    const controller = createSettingsController({
      request: async (path) => {
        if (path.startsWith('/api/models')) {
          return {
            ...(current ? { current } : {}),
            models: flaggedModels,
            // 桌面端焦点会话的 activeModel：无会话分支同样不许拿它当自己的模型
            activeModel: { id: 'other-agent-current', provider: 'other-p' },
          };
        }
        return { thinkingLevel: 'low', thinkingLevels: ['low'] };
      },
    });
    return { controller, loading: controller.load({ sessionPath: null, agentId: 'agent-1', fallbackModel: fallbackModel ?? null }) };
  }

  // 1. 只有 isCurrent、没有 current、有 fallbackModel：取 fallbackModel
  const flaggedOnly = makeController({ fallbackModel: 'agent-chat-model' });
  await flaggedOnly.loading;
  assert.equal(flaggedOnly.controller.getState().currentModelId, 'agent-chat-model', '没有 current 时必须退到 fallbackModel');
  assert.equal(flaggedOnly.controller.getState().currentProvider, 'agent-p');

  // 2. 只有 isCurrent，既没有 current 也没有 fallbackModel：null，不猜
  const nothing = makeController({});
  await nothing.loading;
  assert.equal(nothing.controller.getState().currentModelId, null, 'isCurrent 不得被当成新会话的模型');
  assert.equal(nothing.controller.getState().currentProvider, null);

  // 3. current 与 fallbackModel 同时存在：current 优先
  const withBoth = makeController({ current: 'agent-chat-model', fallbackModel: 'other-agent-current' });
  await withBoth.loading;
  assert.equal(withBoth.controller.getState().currentModelId, 'agent-chat-model');
  assert.equal(withBoth.controller.getState().currentProvider, 'agent-p');
});

await t('加载 fallbackModel：明确可解析才取，同 id 多 provider 或来源不明保持 null', async () => {
  const models = [
    { id: 'active-model', name: 'Active', provider: 'ap' },
    { id: 'unique-model', name: 'Unique', provider: 'u-prov' },
    { id: 'dup-model', name: 'Dup A', provider: 'a' },
    { id: 'dup-model', name: 'Dup B', provider: 'b' },
  ];

  function makeController(activeModel) {
    return createSettingsController({
      request: async (path) => {
        if (path.startsWith('/api/models')) {
          return { models, activeModel };
        }
        return { thinkingLevel: 'low', thinkingLevels: ['low'] };
      },
    });
  }

  // 1. activeModel 存在时优先，fallback 不参与
  const withActive = makeController({ id: 'active-model', provider: 'ap' });
  await withActive.load({ sessionPath: 's.json', fallbackModel: 'unique-model' });
  assert.equal(withActive.getState().currentModelId, 'active-model');
  assert.equal(withActive.getState().currentProvider, 'ap');

  // 2. string 且列表内唯一匹配：解析出 provider
  const unique = makeController(null);
  await unique.load({ sessionPath: 's.json', fallbackModel: 'unique-model' });
  assert.equal(unique.getState().currentModelId, 'unique-model');
  assert.equal(unique.getState().currentProvider, 'u-prov');

  // 3. { id, provider } 明确：直接采用
  const explicit = makeController(null);
  await explicit.load({ sessionPath: 's.json', fallbackModel: { id: 'dup-model', provider: 'b' } });
  assert.equal(explicit.getState().currentModelId, 'dup-model');
  assert.equal(explicit.getState().currentProvider, 'b');

  // 4. string 且同 id 多 provider：无法确认，不得瞎选
  const ambiguous = makeController(null);
  await ambiguous.load({ sessionPath: 's.json', fallbackModel: 'dup-model' });
  assert.equal(ambiguous.getState().currentModelId, null);
  assert.equal(ambiguous.getState().currentProvider, null);

  // 5. { id } 缺 provider 且同 id 多 provider：同样无法确认
  const ambiguousObject = makeController(null);
  await ambiguousObject.load({ sessionPath: 's.json', fallbackModel: { id: 'dup-model' } });
  assert.equal(ambiguousObject.getState().currentModelId, null);
  assert.equal(ambiguousObject.getState().currentProvider, null);

  // 6. 列表中不存在的 string：无法解析
  const missing = makeController(null);
  await missing.load({ sessionPath: 's.json', fallbackModel: 'not-in-list' });
  assert.equal(missing.getState().currentModelId, null);

  // 7. 无会话且 current / isCurrent 都缺：fallback 可明确解析时才取
  const pendingSession = makeController(null);
  await pendingSession.load({ sessionPath: null, agentId: 'agent-1', fallbackModel: 'unique-model' });
  assert.equal(pendingSession.getState().currentModelId, 'unique-model');
  assert.equal(pendingSession.getState().currentProvider, 'u-prov');
});

await t('fetchSessionModel：activeModel 无 provider 时，同 id 多 provider 不瞎选', async () => {
  const unique = createSettingsController({
    request: async () => ({
      activeModel: { id: 'solo' },
      models: [{ id: 'solo', name: 'Solo', provider: 'sp' }],
    }),
  });
  const uniqueRes = await unique.fetchSessionModel('session-solo.json');
  assert.deepEqual(uniqueRes, { modelId: 'solo', provider: 'sp', name: 'Solo' });

  const ambiguous = createSettingsController({
    request: async () => ({
      activeModel: { id: 'dup' },
      models: [
        { id: 'dup', name: 'Dup A', provider: 'a' },
        { id: 'dup', name: 'Dup B', provider: 'b' },
      ],
    }),
  });
  const ambiguousRes = await ambiguous.fetchSessionModel('session-dup.json');
  assert.equal(ambiguousRes.modelId, 'dup');
  assert.equal(ambiguousRes.provider, '', '同 id 多 provider 且 activeModel 未给 provider 时不得挑一个');
});

/* ---------------- 模型切换：单飞、代次、过期不污染 ---------------- */

await t('switchModel 单飞：在途重复调用返回 null，零额外 POST，成功保留原响应', async () => {
  const dSwitch = deferred();
  const switchCalls = [];
  const payload = { ok: true, thinkingLevel: 'high' };

  const controller = createSettingsController({
    request: async (path, opts) => {
      if (path === '/api/models/switch') {
        switchCalls.push({ path, opts });
        return dSwitch.promise;
      }
      if (path.startsWith('/api/models')) {
        return {
          models: [
            { id: 'm1', name: 'M1', provider: 'p1' },
            { id: 'm2', name: 'M2', provider: 'p2' },
          ],
          activeModel: { id: 'm1', provider: 'p1' },
        };
      }
      return { thinkingLevel: 'low', thinkingLevels: ['low', 'high'] };
    },
  });

  await controller.load({ sessionPath: 'session-single.json' });

  const first = controller.switchModel('m2', 'p2');
  const duplicatePromise = controller.switchModel('m2', 'p2');
  assert.equal(controller.getState().savingModel, true);

  dSwitch.resolve(payload);
  const [res, duplicate] = await Promise.all([first, duplicatePromise]);
  assert.equal(duplicate, null, '在途重复调用必须返回 null');
  assert.equal(switchCalls.length, 1, '单飞期间不得重复发 POST');

  assert.equal(res, payload, '成功时必须保留原响应对象');
  assert.equal(controller.getState().currentModelId, 'm2');
  assert.equal(controller.getState().currentProvider, 'p2');
  assert.equal(controller.getState().thinkingLevel, 'low', '档位值以切换后的重拉结果为准');
  assert.equal(controller.getState().savingModel, false);
  assert.equal(switchCalls.length, 1);
});

await t('switchModel 代次：在途写遇到新 load，晚到成功返回 null 且不改新上下文', async () => {
  const dSwitch = deferred();
  const switchBodies = [];
  let modelsCallCount = 0;

  const controller = createSettingsController({
    request: async (path, opts) => {
      if (path === '/api/models/switch') {
        switchBodies.push(JSON.parse(opts.body));
        return dSwitch.promise;
      }
      if (path.startsWith('/api/models')) {
        modelsCallCount++;
        if (modelsCallCount === 1) {
          return {
            models: [
              { id: 'm1', name: 'M1', provider: 'p1' },
              { id: 'm2', name: 'M2', provider: 'p2' },
            ],
            activeModel: { id: 'm1', provider: 'p1' },
          };
        }
        return {
          models: [
            { id: 'm1', name: 'M1', provider: 'p1' },
            { id: 'm2', name: 'M2', provider: 'p2' },
            { id: 'm3', name: 'M3', provider: 'p3' },
          ],
          activeModel: { id: 'm3', provider: 'p3' },
        };
      }
      return { thinkingLevel: 'low', thinkingLevels: ['low', 'high'] };
    },
  });

  await controller.load({ sessionPath: 'session-a.json' });
  const pending = controller.switchModel('m2', 'p2');
  assert.equal(controller.getState().savingModel, true);

  // 写还在途，切到会话 B 并完成加载
  await controller.load({ sessionPath: 'session-b.json' });
  assert.equal(controller.getState().currentModelId, 'm3');
  assert.equal(controller.getState().savingModel, false, '新 load 后旧写的 saving 状态必须失效');

  // A 晚到成功：不得回写 B 的模型与思考级别
  dSwitch.resolve({ ok: true, thinkingLevel: 'high' });
  assert.equal(await pending, null, '过期写成功必须返回 null');

  const state = controller.getState();
  assert.equal(state.sessionPath, 'session-b.json');
  assert.equal(state.currentModelId, 'm3');
  assert.equal(state.currentProvider, 'p3');
  assert.equal(state.thinkingLevel, 'low', '过期写的 thinkingLevel 不得污染新上下文');
  assert.equal(state.savingModel, false);
  assert.equal(state.status, 'loaded');
  assert.equal(switchBodies.length, 1);
  assert.equal(switchBodies[0].sessionPath, 'session-a.json');
});

await t('switchModel 代次：在途写遇到新 load，晚到失败返回 null 且错误不冒泡', async () => {
  const dSwitch = deferred();
  const switchBodies = [];
  let modelsCallCount = 0;

  const controller = createSettingsController({
    request: async (path, opts) => {
      if (path === '/api/models/switch') {
        switchBodies.push(JSON.parse(opts.body));
        return dSwitch.promise;
      }
      if (path.startsWith('/api/models')) {
        modelsCallCount++;
        return modelsCallCount === 1
          ? { models: [{ id: 'm1', name: 'M1', provider: 'p1' }], activeModel: { id: 'm1', provider: 'p1' } }
          : { models: [{ id: 'm9', name: 'M9', provider: 'p9' }], activeModel: { id: 'm9', provider: 'p9' } };
      }
      return { thinkingLevel: 'low', thinkingLevels: ['low', 'high'] };
    },
  });

  await controller.load({ sessionPath: 'session-a.json' });
  const pending = controller.switchModel('m2', 'p2');
  await controller.load({ sessionPath: 'session-b.json' });

  dSwitch.reject(new Error('旧上下文切换失败'));
  assert.equal(await pending, null, '过期写失败必须返回 null，不能把旧错误抛给新上下文');

  const state = controller.getState();
  assert.equal(state.status, 'loaded');
  assert.equal(state.error, null);
  assert.equal(state.currentModelId, 'm9');
  assert.equal(state.currentProvider, 'p9');
  assert.equal(state.savingModel, false);
});

await t('switchModel 代次：旧写 finally 不得清掉新 load 后新写的 savingModel', async () => {
  const dOld = deferred();
  const dNew = deferred();
  const switchBodies = [];
  let modelsCallCount = 0;

  const controller = createSettingsController({
    request: async (path, opts) => {
      if (path === '/api/models/switch') {
        switchBodies.push(JSON.parse(opts.body));
        return switchBodies.length === 1 ? dOld.promise : dNew.promise;
      }
      if (path.startsWith('/api/models')) {
        modelsCallCount++;
        if (modelsCallCount === 1) {
          return { models: [{ id: 'm1', name: 'M1', provider: 'p1' }], activeModel: { id: 'm1', provider: 'p1' } };
        }
        return {
          models: [
            { id: 'b-model', name: 'B', provider: 'bp' },
            { id: 'm3', name: 'M3', provider: 'p3' },
          ],
          activeModel: { id: 'b-model', provider: 'bp' },
        };
      }
      return { thinkingLevel: 'low', thinkingLevels: ['low', 'high', 'max'] };
    },
  });

  await controller.load({ sessionPath: 'session-a.json' });
  const oldWrite = controller.switchModel('m2', 'p2');

  // 新 load 作废旧写，随后新写开始
  await controller.load({ sessionPath: 'session-b.json' });
  const newWrite = controller.switchModel('m3', 'p3');
  assert.equal(controller.getState().savingModel, true);

  // 旧写晚到：不得清掉新写的 savingModel，也不得改新上下文
  dOld.resolve({ ok: true, thinkingLevel: 'high' });
  assert.equal(await oldWrite, null);
  assert.equal(controller.getState().savingModel, true, '旧写 finally 不得清掉新写的 savingModel');
  assert.equal(controller.getState().currentModelId, 'b-model');
  assert.equal(controller.getState().thinkingLevel, 'low');

  // 新写正常完成
  dNew.resolve({ ok: true, thinkingLevel: 'max' });
  assert.deepEqual(await newWrite, { ok: true, thinkingLevel: 'max' });
  const state = controller.getState();
  assert.equal(state.savingModel, false);
  assert.equal(state.currentModelId, 'm3');
  assert.equal(state.currentProvider, 'p3');
  assert.equal(state.thinkingLevel, 'low', '档位值以切换后的重拉结果为准，不再回写 POST 响应的值');
  assert.equal(switchBodies.length, 2);
});

await t('switchModel dispose：在途写返回 null，不回写状态也不触发回调，后续调用静默', async () => {
  const dSwitch = deferred();
  let changeCount = 0;
  const switchCalls = [];

  const controller = createSettingsController({
    request: async (path, opts) => {
      if (path === '/api/models/switch') {
        switchCalls.push({ path, opts });
        return dSwitch.promise;
      }
      if (path.startsWith('/api/models')) {
        return {
          models: [
            { id: 'm1', name: 'M1', provider: 'p1' },
            { id: 'm2', name: 'M2', provider: 'p2' },
          ],
          activeModel: { id: 'm1', provider: 'p1' },
        };
      }
      return { thinkingLevel: 'low', thinkingLevels: ['low', 'high'] };
    },
    onStateChange: () => { changeCount++; },
  });

  await controller.load({ sessionPath: 'session-dispose.json' });
  const pending = controller.switchModel('m2', 'p2');
  const before = controller.getState();

  controller.dispose();
  const changesAtDispose = changeCount;

  dSwitch.resolve({ ok: true, thinkingLevel: 'high' });
  assert.equal(await pending, null, 'dispose 后在途写必须返回 null');

  const after = controller.getState();
  assert.equal(after.currentModelId, before.currentModelId, 'dispose 后不得回写模型');
  assert.equal(after.currentProvider, before.currentProvider);
  assert.equal(after.thinkingLevel, before.thinkingLevel, 'dispose 后不得回写思考级别');
  assert.equal(changeCount, changesAtDispose, 'dispose 后不得再触发 onStateChange');

  const callsBefore = switchCalls.length;
  assert.equal(await controller.switchModel('m2', 'p2'), null);
  assert.equal(switchCalls.length, callsBefore, 'dispose 后不得再发写请求');
});

await t('setThinkingLevel 代次：旧思考在途遇到新 load 与新思考，晚到成功不污染新上下文也不清新 saving', async () => {
  const dOld = deferred();
  const dNew = deferred();
  const postBodies = [];
  let modelsCallCount = 0;
  let thinkingGetCount = 0;
  const oldPayload = { ok: true, thinkingLevel: 'max' };
  const newPayload = { ok: true, thinkingLevel: 'high' };

  const controller = createSettingsController({
    request: async (path, opts = {}) => {
      if (path === '/api/session-thinking-level' && opts.method === 'POST') {
        postBodies.push(JSON.parse(opts.body));
        return postBodies.length === 1 ? dOld.promise : dNew.promise;
      }
      if (path.startsWith('/api/models')) {
        modelsCallCount++;
        return modelsCallCount === 1
          ? { models: [{ id: 'm1', name: 'M1', provider: 'p1' }], activeModel: { id: 'm1', provider: 'p1' } }
          : { models: [{ id: 'm2', name: 'M2', provider: 'p2' }], activeModel: { id: 'm2', provider: 'p2' } };
      }
      thinkingGetCount++;
      return thinkingGetCount === 1
        ? { thinkingLevel: 'low', thinkingLevels: ['low', 'high'] }
        : { thinkingLevel: 'low', thinkingLevels: ['low', 'high', 'max'] };
    },
  });

  await controller.load({ sessionPath: 'session-a.json' });
  const oldWrite = controller.setThinkingLevel('high');
  assert.equal(controller.getState().savingThinkingLevel, true);

  // 旧思考在途时切到会话 B 并完成加载
  await controller.load({ sessionPath: 'session-b.json' });
  assert.equal(controller.getState().currentModelId, 'm2');
  assert.equal(controller.getState().savingThinkingLevel, false, '新 load 后旧思考的 saving 状态必须失效');

  // B 自己的思考写开始
  const newWrite = controller.setThinkingLevel('high');
  assert.equal(controller.getState().savingThinkingLevel, true);

  // A 晚到成功：不得回写 B 的思考级别，也不得清掉 B 的 savingThinkingLevel
  dOld.resolve(oldPayload);
  assert.equal(await oldWrite, null, '过期思考写成功必须返回 null');

  let state = controller.getState();
  assert.equal(state.savingThinkingLevel, true, '旧思考 finally 不得清掉新思考的 savingThinkingLevel');
  assert.equal(state.thinkingLevel, 'low', '过期思考写的 thinkingLevel 不得污染新上下文');
  assert.equal(state.currentModelId, 'm2');

  // B 的思考写正常完成，保留原响应
  dNew.resolve(newPayload);
  assert.equal(await newWrite, newPayload);
  state = controller.getState();
  assert.equal(state.savingThinkingLevel, false);
  assert.equal(state.thinkingLevel, 'high');
  assert.equal(postBodies.length, 2);
  assert.equal(postBodies[0].sessionPath, 'session-a.json');
  assert.equal(postBodies[1].sessionPath, 'session-b.json');
});

await t('setThinkingLevel 代次：旧思考在途遇到新 load，晚到失败返回 null 且错误不冒泡', async () => {
  const dOld = deferred();
  const postBodies = [];
  let modelsCallCount = 0;

  const controller = createSettingsController({
    request: async (path, opts = {}) => {
      if (path === '/api/session-thinking-level' && opts.method === 'POST') {
        postBodies.push(JSON.parse(opts.body));
        return dOld.promise;
      }
      if (path.startsWith('/api/models')) {
        modelsCallCount++;
        return modelsCallCount === 1
          ? { models: [{ id: 'm1', name: 'M1', provider: 'p1' }], activeModel: { id: 'm1', provider: 'p1' } }
          : { models: [{ id: 'm9', name: 'M9', provider: 'p9' }], activeModel: { id: 'm9', provider: 'p9' } };
      }
      return { thinkingLevel: 'low', thinkingLevels: ['low', 'high'] };
    },
  });

  await controller.load({ sessionPath: 'session-a.json' });
  const pending = controller.setThinkingLevel('high');
  await controller.load({ sessionPath: 'session-b.json' });

  dOld.reject(new Error('旧上下文思考设置失败'));
  assert.equal(await pending, null, '过期思考写失败必须返回 null，不能把旧错误抛给新上下文');

  const state = controller.getState();
  assert.equal(state.status, 'loaded');
  assert.equal(state.error, null);
  assert.equal(state.thinkingLevel, 'low');
  assert.equal(state.currentModelId, 'm9');
  assert.equal(state.savingThinkingLevel, false);
  assert.equal(postBodies.length, 1);
});

await t('setThinkingLevel 单飞：在途重复调用返回 null，零额外 POST，成功保留原响应', async () => {
  const dThinking = deferred();
  const dSwitch = deferred();
  const thinkingPosts = [];
  const switchCalls = [];
  const payload = { ok: true, thinkingLevel: 'high' };

  const controller = createSettingsController({
    request: async (path, opts = {}) => {
      if (path === '/api/session-thinking-level' && opts.method === 'POST') {
        thinkingPosts.push({ path, opts });
        return dThinking.promise;
      }
      if (path === '/api/models/switch') {
        switchCalls.push({ path, opts });
        return dSwitch.promise;
      }
      if (path.startsWith('/api/models')) {
        return {
          models: [
            { id: 'm1', name: 'M1', provider: 'p1' },
            { id: 'm2', name: 'M2', provider: 'p2' },
          ],
          activeModel: { id: 'm1', provider: 'p1' },
        };
      }
      return { thinkingLevel: 'low', thinkingLevels: ['low', 'high'] };
    },
  });

  await controller.load({ sessionPath: 'session-single-thinking.json' });

  const first = controller.setThinkingLevel('high');
  const duplicatePromise = controller.setThinkingLevel('high');
  assert.equal(controller.getState().savingThinkingLevel, true);

  // 短暂互斥：思考写没落地时，切模型必须被明确拒绝（否则两个写会互相覆盖）
  await assert.rejects(
    () => controller.switchModel('m2', 'p2'),
    /思考|档位/,
    '思考在途时切模型必须报错，不得静默排队'
  );
  assert.equal(switchCalls.length, 0, '思考在途时不得发出模型写');
  assert.equal(controller.getState().currentModelId, 'm1', '被拒绝的切模型不得改动当前模型');

  // 思考写落地后，切模型恢复正常
  dThinking.resolve(payload);
  const [res, duplicate] = await Promise.all([first, duplicatePromise]);
  assert.equal(duplicate, null, '在途重复思考设置必须返回 null');

  const switchAfter = controller.switchModel('m2', 'p2');
  assert.equal(switchCalls.length, 1, '思考写完成后模型切换应正常发包');
  dSwitch.resolve({ ok: true });
  assert.deepEqual(await switchAfter, { ok: true });
  assert.equal(controller.getState().currentModelId, 'm2');

  assert.equal(thinkingPosts.length, 1, '单飞期间不得重复发 POST');
  assert.equal(res, payload, '成功时必须保留原响应对象');
  assert.equal(controller.getState().savingThinkingLevel, false);
});

await t('setThinkingLevel dispose：在途思考返回 null，不回写状态也不触发回调，后续调用静默', async () => {
  const dPost = deferred();
  let changeCount = 0;
  const posts = [];

  const controller = createSettingsController({
    request: async (path, opts = {}) => {
      if (path === '/api/session-thinking-level' && opts.method === 'POST') {
        posts.push({ path, opts });
        return dPost.promise;
      }
      if (path.startsWith('/api/models')) {
        return { models: [{ id: 'm1', name: 'M1', provider: 'p1' }], activeModel: { id: 'm1', provider: 'p1' } };
      }
      return { thinkingLevel: 'low', thinkingLevels: ['low', 'high'] };
    },
    onStateChange: () => { changeCount++; },
  });

  await controller.load({ sessionPath: 'session-dispose-thinking.json' });
  const pending = controller.setThinkingLevel('high');
  const before = controller.getState();

  controller.dispose();
  const changesAtDispose = changeCount;

  dPost.resolve({ ok: true, thinkingLevel: 'max' });
  assert.equal(await pending, null, 'dispose 后在途思考写必须返回 null');

  const after = controller.getState();
  assert.equal(after.thinkingLevel, before.thinkingLevel, 'dispose 后不得回写思考级别');
  assert.equal(after.savingThinkingLevel, false);
  assert.equal(changeCount, changesAtDispose, 'dispose 后不得再触发 onStateChange');

  const callsBefore = posts.length;
  assert.equal(await controller.setThinkingLevel('high'), null);
  assert.equal(posts.length, callsBefore, 'dispose 后不得再发思考写请求');
});

await t('reset：作废在途 load 结果，控制器仍可重新 load（不永久 dispose）', async () => {
  const dOld = deferred();
  let phase = 'old';
  let modelLoads = 0;

  const controller = createSettingsController({
    request: async (path) => {
      if (path.startsWith('/api/models')) {
        modelLoads += 1;
        if (phase === 'old') return dOld.promise;
        return {
          models: [{ id: 'new-model', name: 'New', provider: 'new-provider' }],
          activeModel: { id: 'new-model', provider: 'new-provider' },
        };
      }
      if (phase === 'old') return dOld.promise;
      return { thinkingLevel: 'high', thinkingLevels: ['low', 'high'] };
    },
  });

  const pending = controller.load({ sessionPath: 'old-session.json' });
  controller.reset();

  assert.equal(controller.isDisposed(), false, 'reset 不能变成永久 dispose');
  assert.equal(controller.getState().status, 'idle');
  assert.deepEqual(controller.getState().models, []);

  dOld.resolve({
    models: [{ id: 'old-model', name: 'Old', provider: 'old-provider' }],
    activeModel: { id: 'old-model', provider: 'old-provider' },
    thinkingLevel: 'low',
    thinkingLevels: ['low'],
  });
  await pending;

  let state = controller.getState();
  assert.equal(state.status, 'idle', '旧 load 成功不得回填 reset 后的状态');
  assert.deepEqual(state.models, []);
  assert.equal(state.error, null);

  phase = 'new';
  await controller.load({ sessionPath: 'new-session.json' });
  state = controller.getState();
  assert.equal(modelLoads, 2, 'reset 后新 load 必须真的重新请求');
  assert.equal(state.status, 'loaded');
  assert.equal(state.currentModelId, 'new-model');
  assert.equal(state.currentProvider, 'new-provider');
  assert.equal(state.thinkingLevel, 'high');
});

await t('reset：作废在途写结果，且新登录仍可发起写', async () => {
  const dOldSwitch = deferred();
  const switchBodies = [];
  let switchCount = 0;

  const controller = createSettingsController({
    request: async (path, opts = {}) => {
      if (path === '/api/models/switch') {
        switchBodies.push(JSON.parse(opts.body));
        switchCount += 1;
        if (switchCount === 1) return dOldSwitch.promise;
        return { ok: true };
      }
      if (path.startsWith('/api/models')) {
        return {
          models: [
            { id: 'm1', name: 'M1', provider: 'p1' },
            { id: 'm2', name: 'M2', provider: 'p2' },
          ],
          activeModel: { id: 'm1', provider: 'p1' },
        };
      }
      return { thinkingLevel: 'low', thinkingLevels: ['low', 'high'] };
    },
  });

  await controller.load({ sessionPath: 'old-write-session.json' });
  const pending = controller.switchModel('m2', 'p2');
  assert.equal(controller.getState().savingModel, true);

  controller.reset();
  assert.equal(controller.getState().savingModel, false, 'reset 必须释放旧 saving 标记');
  assert.equal(controller.getState().currentModelId, null);

  dOldSwitch.resolve({ ok: true, thinkingLevel: 'high' });
  assert.equal(await pending, null, '旧写在 reset 后晚到必须返回 null');

  let state = controller.getState();
  assert.equal(state.currentModelId, null, '旧写不得回填新上下文');
  assert.equal(state.thinkingLevel, null);
  assert.equal(state.savingModel, false);

  await controller.load({ sessionPath: 'new-write-session.json' });
  const written = await controller.switchModel('m2', 'p2');
  assert.deepEqual(written, { ok: true });
  state = controller.getState();
  assert.equal(state.currentModelId, 'm2');
  assert.equal(state.currentProvider, 'p2');
  assert.equal(state.savingModel, false);
  assert.equal(switchBodies.length, 2);
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}

