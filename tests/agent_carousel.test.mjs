/* tests/agent_carousel.test.mjs
 *
 * web/agent-carousel.js（首页 Agent 滑轨 + 陪伴大屏）的单元测试。
 *
 * 覆盖拆出去的这一块必须一模一样的行为：
 *   1. 没有 agents：只给 #companionHero 加 no-carousel，不建 pill、不动 hero 内容；
 *   2. 有 agents：每个 pill 的 class / 名字 / 头像调用与当前 Agent 的 active；
 *   3. setActive 只切 active 与 hero，pill 节点（含头像子节点）引用不变；
 *   4. updateHero 写 #homeModelName / #homeWorkspaceName / #heroAgentAvatar，
 *      模型与工作区缺失时用 fallback；
 *   5. avatarUrlFor：头像包 → agents → /api/agents/<id>/avatar，空 id 返回 null；
 *   6. pill 点击调 onSelect(agent)，dispose 之后不再触发。
 *
 * `window.__hana.updateHeroCompanion` / `__hana.selectAgent` 仍在 app.js 里保留同名出口，
 * 由 tests/bugs_regression.test.mjs（真实 import app.js 后直接调 __hana.updateHeroCompanion）
 * 与 tests/mobile_integration.test.mjs 覆盖；本文件只盯模块本身。
 *
 * 全部离线：假 DOM、假 paintAvatar / 假头像地址函数由本文件提供；没有浏览器、没有定时器等待。
 */

import assert from 'node:assert/strict';
import { createAgentCarousel } from '../web/agent-carousel.js';

/* ------------------------------------------------------------------ */
/* 假 DOM                                                             */
/* ------------------------------------------------------------------ */

function makeEl(tag = 'div', id = '') {
  const listeners = new Map();
  const classes = new Set();
  const children = [];

  const node = {
    id,
    tagName: String(tag).toUpperCase(),
    type: '',
    textContent: '',
    children,
    get classList() {
      return {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
          const on = force === undefined ? !classes.has(name) : Boolean(force);
          if (on) classes.add(name);
          else classes.delete(name);
          return on;
        },
      };
    },
    set className(value) {
      classes.clear();
      for (const name of String(value || '').split(/\s+/).filter(Boolean)) classes.add(name);
    },
    get className() {
      return Array.from(classes).join(' ');
    },
    // 迁移后这段渲染只允许 createElement + className/textContent：innerHTML 一律视为回归。
    set innerHTML(value) {
      throw new Error(`agent-carousel 不允许写 innerHTML（收到 ${JSON.stringify(value)}）`);
    },
    get innerHTML() {
      return '';
    },
    appendChild(child) {
      children.push(child);
      child.parentNode = node;
      return child;
    },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index !== -1) children.splice(index, 1);
      if (child) child.parentNode = null;
      return child;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter((item) => item !== fn));
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
    dispatch(type) {
      for (const fn of [...(listeners.get(type) || [])]) fn.call(node, { type, target: node });
    },
  };

  return node;
}

function makeDoc() {
  const nodes = new Map();
  const getEl = (id) => {
    if (!id) return null;
    if (!nodes.has(id)) nodes.set(id, makeEl('div', id));
    return nodes.get(id);
  };

  // index.html 里这五个节点是静态存在的。
  getEl('companionHero');
  getEl('agentCarousel');
  getEl('heroAgentAvatar');
  getEl('homeModelName');
  getEl('homeWorkspaceName');

  return {
    getElementById: getEl,
    createElement: (tag) => makeEl(tag, ''),
    getEl,
  };
}

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

/** 与 app.js 的 modelLabel 同口径：去掉 vendor 前缀，空模型返回 ''。 */
const modelLabel = (model) => {
  if (!model) return '';
  const raw = typeof model === 'string' ? model : (model.name || model.label || model.id || model.model || '');
  if (!raw) return '';
  return String(raw).replace(/^[a-z0-9]+[/:]/i, '');
};

/** 与 avatar-view.js 的 agentAvatarUrl 同口径：显式地址 > hasAvatar 拼 id > null。 */
const agentAvatarUrl = (agent) => {
  if (!agent) return null;
  const given = agent.avatarUrl || agent.avatar?.url;
  if (given) return given;
  if (!agent.hasAvatar) return null;
  const id = agent.id || agent.agentId;
  return id ? `/api/agents/${encodeURIComponent(id)}/avatar` : null;
};

const AGENTS = [
  { id: 'cat', name: '猫娘', chatModel: 'vendor/DeepSeek V9' },
  { id: 'trace', name: '寻迹' },
  { id: 'luna', agentName: 'Luna' },
];

function makeHarness({ packed = {} } = {}) {
  const doc = makeDoc();
  const state = { agents: AGENTS.slice(), paintCalls: [], selections: [] };

  const panel = createAgentCarousel({
    document: doc,
    getElement: doc.getElementById,
    paintAvatar: (host, opts = {}) => {
      state.paintCalls.push({ host, ...opts });
      host.textContent = opts.name || '';
    },
    agentAvatarUrl,
    modelLabel,
    onSelect: (agent) => state.selections.push(agent),
    packedAvatarUrlOf: (id) => packed[id] || null,
    agentsOf: () => state.agents,
  });

  const pills = () => doc.getEl('agentCarousel').children;
  return { doc, panel, state, pills };
}

const pillNames = (pills) => pills.map((pill) => pill.children[1].textContent);

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('没有 agents：给 companionHero 加 no-carousel，不建 pill、不动 hero', () => {
  const { doc, panel, state, pills } = makeHarness();

  panel.render({ agents: [], currentAgent: null, agentName: 'Hana', homeFolder: 'ws-home' });

  assert.equal(doc.getEl('companionHero').classList.contains('no-carousel'), true, '空列表要加 no-carousel');
  assert.deepEqual(pills(), [], '空列表不能建 pill');
  assert.equal(state.paintCalls.length, 0, '空列表不重画 hero（迁移前的提前 return）');
  assert.equal(doc.getEl('homeModelName').textContent, '', 'hero 的模型文案不被动');
  assert.equal(doc.getEl('homeWorkspaceName').textContent, '', 'hero 的工作区文案不被动');

  // 迁移前的写法只加不摘：后来有 agents 了也留着这个 class。这里锁住，不改语义。
  panel.render({ agents: AGENTS.slice(), currentAgent: AGENTS[0], agentName: AGENTS[0].name, homeFolder: 'ws-home' });
  assert.equal(doc.getEl('companionHero').classList.contains('no-carousel'), true, '有 agents 后也不摘（迁移前行为）');
  assert.equal(pills().length, 3, '有 agents 后正常建 pill');
});

t('3 个 agents：建 3 个 pill，名字与头像调用正确，当前 Agent 有 active', () => {
  const { doc, panel, state, pills } = makeHarness();

  panel.render({
    agents: AGENTS,
    currentAgent: AGENTS[1],
    agentName: AGENTS[1].name,
    homeFolder: 'ws-home',
  });

  const built = pills();
  assert.equal(built.length, 3, '每个 agent 一个 pill');
  assert.deepEqual(pillNames(built), ['猫娘', '寻迹', 'Luna'], 'pill 名字按 name → agentName 回退');

  for (const pill of built) {
    assert.equal(pill.tagName, 'BUTTON', 'pill 必须是 button');
    assert.equal(pill.type, 'button', 'pill.type 必须是 button');
    assert.equal(pill.className.split(' ').includes('agent-pill'), true, 'pill 要有 agent-pill class');
    assert.equal(pill.children.length, 2, 'pill 结构：头像 + 名字');
    assert.equal(pill.children[0].className, 'agent-pill-avatar', '第一个子节点是头像位');
    assert.equal(pill.children[1].className, 'agent-pill-name', '第二个子节点是名字');
  }

  assert.equal(built[1].classList.contains('active'), true, '当前 Agent 的 pill 要 active');
  assert.equal(built[0].classList.contains('active'), false);
  assert.equal(built[2].classList.contains('active'), false);

  // 3 次 pill 头像 + 1 次 hero 头像；pill 头像的 url / name 与 agent 对应。
  assert.equal(state.paintCalls.length, 4, '三个 pill 各画一次头像，hero 再画一次');
  assert.deepEqual(
    state.paintCalls.slice(0, 3).map((call) => [call.host, call.url, call.name]),
    [
      [built[0].children[0], null, '猫娘'],
      [built[1].children[0], null, '寻迹'],
      [built[2].children[0], null, 'Luna'],
    ],
    'pill 头像的宿主、地址与名字都要对得上',
  );

  assert.equal(state.paintCalls[3].host, doc.getEl('heroAgentAvatar'), 'hero 头像走 paintAvatar');
  assert.equal(state.paintCalls[3].name, '寻迹', 'hero 头像名字取当前 Agent');
  assert.equal(doc.getEl('homeModelName').textContent, 'DeepSeek V4.1', '当前 Agent 没有 chatModel 时用 fallback');
  assert.equal(doc.getEl('homeWorkspaceName').textContent, 'ws-home', 'hero 工作区名用传入值');
});

t('setActive(other)：active 从旧 pill 移到新 pill，且没有重建 DOM', () => {
  const { doc, panel, state, pills } = makeHarness();

  panel.render({ agents: AGENTS, currentAgent: AGENTS[0], agentName: AGENTS[0].name, homeFolder: 'ws-home' });
  const before = pills().slice();
  const avatarBefore = before.map((pill) => pill.children[0]);
  const paintsAfterRender = state.paintCalls.length;
  assert.equal(before[0].classList.contains('active'), true, '前置：第一个 pill 是 active');

  panel.setActive(AGENTS[2], { agentName: AGENTS[2].agentName, homeFolder: 'ws-home' });

  const after = pills();
  assert.equal(after.length, 3, '不能多也不能少');
  after.forEach((pill, index) => {
    assert.equal(pill, before[index], `第 ${index} 个 pill 必须是同一个节点（不重建 DOM）`);
    assert.equal(pill.children[0], avatarBefore[index], `第 ${index} 个 pill 的头像节点也不能重建`);
  });
  assert.equal(after[0].classList.contains('active'), false, '旧 pill 要摘掉 active');
  assert.equal(after[2].classList.contains('active'), true, '新 pill 要有 active');

  // active 切换只补画 hero，不重画 pill 头像。
  assert.equal(state.paintCalls.length, paintsAfterRender + 1, 'setActive 只画一次 hero');
  assert.equal(state.paintCalls.at(-1).host, doc.getEl('heroAgentAvatar'));
  assert.equal(state.paintCalls.at(-1).name, 'Luna', 'hero 头像名字取新 Agent 的 name / agentName');
  assert.equal(doc.getEl('homeModelName').textContent, 'DeepSeek V4.1', '新 Agent 没有模型时用 fallback');
  assert.equal(doc.getEl('homeWorkspaceName').textContent, 'ws-home', '工作区名沿用宿主传入值');
});

t('updateHero：模型缺失与工作区为空都走 fallback，头像交给 paintAvatar', () => {
  const { doc, panel, state } = makeHarness();
  panel.render({ agents: AGENTS, currentAgent: AGENTS[0], agentName: AGENTS[0].name, homeFolder: 'ws-home' });

  // 当前 Agent 没有 chatModel、homeFolder 为空：两个文案都用 fallback。
  panel.updateHero({ currentAgent: { id: 'plain', name: '素人' }, agentName: '素人', homeFolder: '' });
  assert.equal(doc.getEl('homeModelName').textContent, 'DeepSeek V4.1', '缺模型时用 fallback 模型名');
  assert.equal(doc.getEl('homeWorkspaceName').textContent, '工作区', '空工作区时用 fallback 工作区名');
  assert.equal(state.paintCalls.at(-1).host, doc.getEl('heroAgentAvatar'), 'hero 头像要重画');
  assert.equal(state.paintCalls.at(-1).name, '素人');
  assert.equal(state.paintCalls.at(-1).fallback, '素人');

  // 有模型、有工作区：用真实值，模型名按 modelLabel 去前缀。
  panel.updateHero({
    currentAgent: { id: 'plain', name: '素人', chatModel: 'vendor/DeepSeek V9' },
    agentName: '素人',
    homeFolder: 'C:/work/alpha',
  });
  assert.equal(doc.getEl('homeModelName').textContent, 'DeepSeek V9');
  assert.equal(doc.getEl('homeWorkspaceName').textContent, 'C:/work/alpha');

  // 当前 Agent 没有名字：头像名字用宿主给的 agentName 兜底。
  panel.updateHero({ currentAgent: { id: 'nameless' }, agentName: 'Hana', homeFolder: 'ws' });
  assert.equal(state.paintCalls.at(-1).name, 'Hana', 'currentAgent.name 缺失时用 agentName');

  // 无参（__hana.updateHeroCompanion() 的形状）：按现有快照重画，不抛错、不改文案。
  const paints = state.paintCalls.length;
  panel.updateHero();
  assert.equal(state.paintCalls.length, paints + 1, '无参也要重画一次');
  assert.equal(doc.getEl('homeModelName').textContent, 'DeepSeek V4.1');
  assert.equal(doc.getEl('homeWorkspaceName').textContent, 'ws');
});

t('avatarUrlFor：头像包优先，其次 agents，最后按 id 拼兜底地址', () => {
  const { panel, state } = makeHarness({ packed: { cat: '/api/avatars/packed-cat', ghost: '/api/avatars/packed-ghost' } });
  state.agents = [
    { id: 'cat', avatarUrl: '/custom/cat.png' },
    { agentId: 'trace', hasAvatar: true },
    { id: 'plain' },
  ];

  assert.equal(panel.avatarUrlFor('cat'), '/api/avatars/packed-cat', '头像包命中优先于 agents 里的地址');
  assert.equal(panel.avatarUrlFor('ghost'), '/api/avatars/packed-ghost', '头像包命中就够了，不必在 agents 里');
  assert.equal(panel.avatarUrlFor('trace'), '/api/agents/trace/avatar', '未命中头像包时按 agents（含 agentId）取地址');
  assert.equal(panel.avatarUrlFor('plain'), null, 'agents 里但没有头像时就是 null');
  assert.equal(panel.avatarUrlFor('unknown id'), '/api/agents/unknown%20id/avatar', '都不命中时给兜底地址并转义');

  assert.equal(panel.avatarUrlFor(''), null, '空 id 返回 null');
  assert.equal(panel.avatarUrlFor(null), null, 'null id 返回 null');
  assert.equal(panel.avatarUrlFor(undefined), null, 'undefined id 返回 null');
});

t('点 pill 触发 onSelect(agent)，dispose 之后点击不再触发', () => {
  const { panel, state, pills } = makeHarness();
  panel.render({ agents: AGENTS, currentAgent: AGENTS[0], agentName: AGENTS[0].name, homeFolder: 'ws-home' });

  const built = pills();
  assert.deepEqual(built.map((pill) => pill.listenerCount('click')), [1, 1, 1], '每个 pill 各一个 click 监听');

  built[0].dispatch('click');
  built[2].dispatch('click');
  assert.equal(state.selections.length, 2, '点两次触发两次');
  assert.equal(state.selections[0], AGENTS[0], '回传的就是建 pill 时那个 agent 对象');
  assert.equal(state.selections[1], AGENTS[2]);

  panel.dispose();
  assert.deepEqual(built.map((pill) => pill.listenerCount('click')), [0, 0, 0], 'dispose 要摘掉所有 pill 监听');

  built[1].dispatch('click');
  assert.equal(state.selections.length, 2, 'dispose 之后点击不再触发 onSelect');

  panel.dispose(); // 幂等：生命周期收尾可能调不止一次
});

t('再次 render：旧 pill 被清掉、旧监听不再生效，也不会重复堆叠', () => {
  const { panel, state, pills } = makeHarness();
  panel.render({ agents: AGENTS, currentAgent: AGENTS[0], agentName: AGENTS[0].name, homeFolder: 'ws-home' });
  const oldFirst = pills()[0];

  panel.render({ agents: AGENTS.slice(1), currentAgent: AGENTS[1], agentName: AGENTS[1].name, homeFolder: 'ws-home' });

  const rebuilt = pills();
  assert.equal(rebuilt.length, 2, '重画后数量按新列表，不叠加上一轮的 pill');
  assert.equal(rebuilt.includes(oldFirst), false, '旧 pill 已被摘掉');
  assert.equal(oldFirst.listenerCount('click'), 0, '旧 pill 的监听随重画一起摘掉');
  assert.equal(rebuilt[0].classList.contains('active'), true, '新的当前 Agent 有 active');

  const selections = state.selections.length;
  oldFirst.dispatch('click');
  assert.equal(state.selections.length, selections, '点已经摘掉的旧 pill 不能再换助手');
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
