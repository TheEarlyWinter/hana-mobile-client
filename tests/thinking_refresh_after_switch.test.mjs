/* tests/thinking_refresh_after_switch.test.mjs
 *
 * 「切换模型之后，思考级别必须跟着换」的回归测试。
 *
 * 起因（真机复现，某 Android 13 机型）：
 *   设置面板里先选 Gemini 3.8 Flash（宿主档位 off/medium/high，默认 high），
 *   再点 GPT-5.6-Luna（宿主档位 low/medium/high/max，默认 max）。
 *   模型切过去了，但思考级别还是 Gemini 那三格，而且三格全灰。
 *
 * 根因：
 *   POST /api/models/set 与 /api/models/switch 的响应里都只有 thinkingLevel，
 *   没有 thinkingLevels（宿主 1.5.70 的契约，已在 bundle 里核对）。
 *   控制器只采纳了值，把集合留在上一次 load() 的结果里，
 *   于是「Luna 的值 + Gemini 的集合」，值对不上集合，视图一个都不高亮。
 *
 * 这里锁死的契约：
 *   1. 切模型成功后必须重拉一次 /api/session-thinking-level，集合与值成对提交
 *   2. 重拉的 query 跟着上下文走（有会话带 sessionPath，新会话带 pendingNewSession + agentId）
 *   3. 重拉失败不许把「模型切换」报成失败，只让思考区进入可重试的失败态
 *   4. 旧代次（切模型之前发出的）档位响应不得覆盖新模型的集合
 *   5. 宿主理论上会收敛非法值；万一真给了集合外的值，必须标记「不一致」，不许静默当作正常
 *   6. 模型写与思考写短暂互斥，避免已发出的旧写改掉服务端
 */

import assert from 'node:assert/strict';
import { createSettingsController } from '../web/settings-controller.js';

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

function makeMockStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const GEMINI_LEVELS = ['off', 'medium', 'high'];
const LUNA_LEVELS = ['low', 'medium', 'high', 'max'];

const MODELS_PAYLOAD = {
  models: [
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash', provider: 'gemini' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', provider: 'openai-codex' },
  ],
  providerDisplayNames: { gemini: 'Google Gemini', 'openai-codex': 'OpenAI Codex (OAuth)' },
  current: 'gemini-3.8-flash-high',
};

/**
 * 一个会记账的假宿主。
 * thinkingQueue 里放的是「每次 GET /api/session-thinking-level 依次返回什么」。
 */
function makeHost({ thinkingQueue = [], switchResponse = null, setResponse = null } = {}) {
  const calls = [];
  const queue = [...thinkingQueue];

  async function request(path, opts = {}) {
    calls.push({ path, opts, method: opts.method || 'GET' });

    if (path.startsWith('/api/models/set')) {
      return setResponse || { ok: true, model: 'GPT-5.6-Luna', pendingModel: true, thinkingLevel: 'max' };
    }
    if (path.startsWith('/api/models/switch')) {
      return switchResponse || { ok: true, model: 'GPT-5.6-Luna', adaptations: null, thinkingLevel: 'max' };
    }
    if (path.startsWith('/api/models')) {
      return MODELS_PAYLOAD;
    }
    if (path.startsWith('/api/session-thinking-level')) {
      if (opts.method === 'POST') {
        return { ok: true, thinkingLevel: JSON.parse(opts.body || '{}').level, thinkingLevels: LUNA_LEVELS };
      }
      const next = queue.length > 0 ? queue.shift() : { thinkingLevel: 'high', requestedThinkingLevel: 'high', thinkingLevels: GEMINI_LEVELS };
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(path, opts);
      return next;
    }
    return {};
  }

  return { request, calls, queue };
}

// ---------------- 1. 核心回归：切完模型，集合必须换成新模型的 ----------------

await t('切换模型后：档位集合换成新模型的，值与集合成对提交', async () => {
  const host = makeHost({
    thinkingQueue: [
      { thinkingLevel: 'high', requestedThinkingLevel: 'high', thinkingLevels: GEMINI_LEVELS },
      { thinkingLevel: 'max', requestedThinkingLevel: 'max', thinkingLevels: LUNA_LEVELS },
    ],
  });
  const controller = createSettingsController({ request: host.request, storage: makeMockStorage() });

  await controller.load({ agentId: 'hakimi' });
  assert.deepEqual(controller.getState().thinkingLevels, GEMINI_LEVELS, '初始应为 Gemini 的三档');

  await controller.switchModel('gpt-5.6-luna', 'openai-codex');

  const state = controller.getState();
  assert.equal(state.currentModelId, 'gpt-5.6-luna', '模型必须已经提交');
  assert.deepEqual(state.thinkingLevels, LUNA_LEVELS, '档位集合必须换成 Luna 的四档，不能留着上家的');
  assert.equal(state.thinkingLevel, 'max', '档位的值必须来自切换后的重拉结果');
  assert.equal(state.requestedThinkingLevel, 'max');
  assert.equal(state.thinkingStatus, 'ready', '集合与值都正常时应为 ready');
});

// ---------------- 2. 重拉的 query 跟着上下文走 ----------------

await t('重拉档位：有会话带 sessionPath，新会话带 pendingNewSession 与 agentId', async () => {
  const host = makeHost({
    thinkingQueue: [
      { thinkingLevel: 'high', requestedThinkingLevel: 'high', thinkingLevels: GEMINI_LEVELS },
      { thinkingLevel: 'max', requestedThinkingLevel: 'max', thinkingLevels: LUNA_LEVELS },
      { thinkingLevel: 'max', requestedThinkingLevel: 'max', thinkingLevels: LUNA_LEVELS },
    ],
  });
  const controller = createSettingsController({ request: host.request, storage: makeMockStorage() });

  // 新会话上下文
  await controller.load({ agentId: 'hakimi' });
  await controller.switchModel('gpt-5.6-luna', 'openai-codex');
  const newSessionRefresh = host.calls.filter((c) => c.path.startsWith('/api/session-thinking-level') && c.method === 'GET').pop();
  assert.ok(newSessionRefresh.path.includes('pendingNewSession=1'), `新会话重拉必须带 pendingNewSession=1，实际：${newSessionRefresh.path}`);
  assert.ok(newSessionRefresh.path.includes('agentId=hakimi'), `新会话重拉必须带 agentId，实际：${newSessionRefresh.path}`);

  // 已有会话上下文
  const host2 = makeHost({
    thinkingQueue: [
      { thinkingLevel: 'high', requestedThinkingLevel: 'high', thinkingLevels: GEMINI_LEVELS },
      { thinkingLevel: 'max', requestedThinkingLevel: 'max', thinkingLevels: LUNA_LEVELS },
    ],
  });
  const controller2 = createSettingsController({ request: host2.request, storage: makeMockStorage() });
  await controller2.load({ sessionPath: 'sessions/x.json', agentId: 'hakimi' });
  await controller2.switchModel('gpt-5.6-luna', 'openai-codex');
  const sessionRefresh = host2.calls.filter((c) => c.path.startsWith('/api/session-thinking-level') && c.method === 'GET').pop();
  assert.ok(sessionRefresh.path.includes('sessionPath=' + encodeURIComponent('sessions/x.json')), `有会话时必须带 sessionPath，实际：${sessionRefresh.path}`);
  assert.equal(sessionRefresh.path.includes('pendingNewSession'), false, '有会话时不该带 pendingNewSession');
});

// ---------------- 3. 重拉失败不许误伤模型切换 ----------------

await t('重拉失败：模型仍然切换成功，思考区进入可重试的失败态', async () => {
  const host = makeHost({
    thinkingQueue: [
      { thinkingLevel: 'high', requestedThinkingLevel: 'high', thinkingLevels: GEMINI_LEVELS },
      new Error('网络抖动'),
    ],
  });
  const controller = createSettingsController({ request: host.request, storage: makeMockStorage() });

  await controller.load({ agentId: 'hakimi' });
  const res = await controller.switchModel('gpt-5.6-luna', 'openai-codex');

  assert.ok(res, 'switchModel 不应因为档位重拉失败而返回 null');
  const state = controller.getState();
  assert.equal(state.currentModelId, 'gpt-5.6-luna', '模型必须保留，不能回滚');
  assert.equal(state.thinkingLevels, null, '失败后不得继续展示旧模型的档位');
  assert.equal(state.thinkingStatus, 'error', '思考区应为可重试的失败态');
  assert.ok(state.thinkingError, '失败态要带错误信息');
});

// ---------------- 4. 旧代次的档位响应不得覆盖新模型 ----------------

await t('竞态：切模型之前发出的档位响应晚到，不得覆盖新模型的集合', async () => {
  const late = deferred();
  let thinkingHttpGetCount = 0;

  const request = async (path, opts = {}) => {
    if (path.startsWith('/api/models/set') || path.startsWith('/api/models/switch')) {
      return { ok: true, model: 'GPT-5.6-Luna', thinkingLevel: 'max' };
    }
    if (path.startsWith('/api/models')) return MODELS_PAYLOAD;
    if (path.startsWith('/api/session-thinking-level') && (!opts.method || opts.method === 'GET')) {
      thinkingHttpGetCount += 1;
      if (thinkingHttpGetCount === 1) return late.promise; // 第一次故意挂住
      return { thinkingLevel: 'max', requestedThinkingLevel: 'max', thinkingLevels: LUNA_LEVELS };
    }
    return {};
  };

  const controller = createSettingsController({ request, storage: makeMockStorage() });
  const firstLoad = controller.load({ agentId: 'hakimi' });

  // load 的档位请求还挂着，就先切模型
  await controller.switchModel('gpt-5.6-luna', 'openai-codex');
  const afterSwitch = controller.getState();
  assert.deepEqual(afterSwitch.thinkingLevels, LUNA_LEVELS, '切换后的集合应为 Luna');

  // 现在让那个旧请求返回 Gemini 的集合
  late.resolve({ thinkingLevel: 'high', requestedThinkingLevel: 'high', thinkingLevels: GEMINI_LEVELS });
  await firstLoad;
  await tick();

  assert.deepEqual(controller.getState().thinkingLevels, LUNA_LEVELS, '旧请求晚到，绝不能把集合盖回 Gemini');
  assert.equal(controller.getState().thinkingLevel, 'max', '旧请求晚到也不能改值');
});

// ---------------- 5. 集合外的值必须标记不一致 ----------------

await t('宿主给了集合外的值时：标记 inconsistent，不静默当作正常', async () => {
  const host = makeHost({
    thinkingQueue: [
      { thinkingLevel: 'high', requestedThinkingLevel: 'high', thinkingLevels: GEMINI_LEVELS },
      { thinkingLevel: 'ultra', requestedThinkingLevel: 'ultra', thinkingLevels: LUNA_LEVELS },
    ],
  });
  const controller = createSettingsController({ request: host.request, storage: makeMockStorage() });

  await controller.load({ agentId: 'hakimi' });
  await controller.switchModel('gpt-5.6-luna', 'openai-codex');

  const state = controller.getState();
  assert.equal(state.thinkingStatus, 'inconsistent', '值不在集合里时必须是 inconsistent');
  assert.deepEqual(state.thinkingLevels, LUNA_LEVELS, '集合本身仍要保留，供界面说明问题');
});

// ---------------- 6. 模型写与思考写互斥 ----------------

await t('互斥：思考写在途时不接受切模型', async () => {
  const thinkingPost = deferred();
  const request = async (path, opts = {}) => {
    if (path.startsWith('/api/models')) return MODELS_PAYLOAD;
    if (path.startsWith('/api/session-thinking-level') && opts.method === 'POST') return thinkingPost.promise;
    if (path.startsWith('/api/session-thinking-level')) {
      return { thinkingLevel: 'high', requestedThinkingLevel: 'high', thinkingLevels: GEMINI_LEVELS };
    }
    return {};
  };

  const controller = createSettingsController({ request, storage: makeMockStorage() });
  await controller.load({ agentId: 'hakimi' });

  const writing = controller.setThinkingLevel('medium');
  await tick();

  await assert.rejects(
    () => controller.switchModel('gpt-5.6-luna', 'openai-codex'),
    /思考|档位/,
    '思考写还在途时，切模型必须被明确拒绝，而不是静默排队或照常发出'
  );

  thinkingPost.resolve({ ok: true, thinkingLevel: 'medium', thinkingLevels: GEMINI_LEVELS });
  await writing;
});

await t('互斥：模型写在途时不接受思考写', async () => {
  const modelPost = deferred();
  const request = async (path, opts = {}) => {
    if (path.startsWith('/api/models/set') || path.startsWith('/api/models/switch')) return modelPost.promise;
    if (path.startsWith('/api/models')) return MODELS_PAYLOAD;
    if (path.startsWith('/api/session-thinking-level')) {
      return { thinkingLevel: 'high', requestedThinkingLevel: 'high', thinkingLevels: GEMINI_LEVELS };
    }
    return {};
  };

  const controller = createSettingsController({ request, storage: makeMockStorage() });
  await controller.load({ agentId: 'hakimi' });

  const switching = controller.switchModel('gpt-5.6-luna', 'openai-codex');
  await tick();

  await assert.rejects(
    () => controller.setThinkingLevel('medium'),
    /模型|切换/,
    '模型写还在途时，思考写必须被明确拒绝'
  );

  modelPost.resolve({ ok: true, model: 'GPT-5.6-Luna', thinkingLevel: 'max' });
  await switching;
});

// ---------------- 7. 重试只重拉档位 ----------------

await t('重试档位：只重拉 thinking-level，不重发模型列表', async () => {
  const host = makeHost({
    thinkingQueue: [
      { thinkingLevel: 'high', requestedThinkingLevel: 'high', thinkingLevels: GEMINI_LEVELS },
      new Error('宿主 500'),
      { thinkingLevel: 'max', requestedThinkingLevel: 'max', thinkingLevels: LUNA_LEVELS },
    ],
  });
  const controller = createSettingsController({ request: host.request, storage: makeMockStorage() });

  await controller.load({ agentId: 'hakimi' });
  await controller.switchModel('gpt-5.6-luna', 'openai-codex');
  assert.equal(controller.getState().thinkingStatus, 'error');

  const modelsCallsBefore = host.calls.filter((c) => c.path.startsWith('/api/models')).length;
  await controller.retryThinking();

  const modelsCallsAfter = host.calls.filter((c) => c.path.startsWith('/api/models')).length;
  assert.equal(modelsCallsAfter, modelsCallsBefore, '重试档位不应该再去拉模型列表');
  assert.deepEqual(controller.getState().thinkingLevels, LUNA_LEVELS);
  assert.equal(controller.getState().thinkingStatus, 'ready');
});

// ---------------- 收尾 ----------------

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
  process.exit(0);
}
