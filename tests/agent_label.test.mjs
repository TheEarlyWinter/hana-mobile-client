/* tests/agent_label.test.mjs — 会话归属 Agent 的显示名（web/agent-label.js）
 *
 * 起点是一个真机上撞到的问题：会话属于 hanako，当前显示名「小鲸鱼」，
 * 但会话记录里留着建会话那一刻的名字「Hakimi」，于是引用一条助手消息会显示
 * 「引用 Hakimi」。这里把解析规则钉死，防止以后又退回「直接用会话快照」。
 */

import assert from 'node:assert/strict';
import { resolveAgentLabel } from '../web/agent-label.js';

let bad = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

const agents = [
  { id: 'hakimi', name: 'Hakimi', isPrimary: true },
  { id: 'hanako', name: '小鲸鱼' },
  { id: 'luna', name: 'Luna' }
];

t('按 agentId 取当前名字，忽略会话里过期的快照', () => {
  const label = resolveAgentLabel({
    session: { agentId: 'hanako', agentName: 'Hakimi' },
    agents,
    fallback: 'Hana'
  });
  assert.equal(label, '小鲸鱼');
});

t('Agent 改过名（id 相同、名字是新的）也取新名字', () => {
  const renamed = [{ id: 'hanako', name: '深海小鲸鱼' }];
  const label = resolveAgentLabel({ session: { agentId: 'hanako', agentName: '小鲸鱼' }, agents: renamed });
  assert.equal(label, '深海小鲸鱼');
});

t('会话没有 agentId 时按名字找，拿到列表里的规范写法', () => {
  const label = resolveAgentLabel({ session: { agentName: '  Luna ' }, agents });
  assert.equal(label, 'Luna');
});

t('会话名字在列表里找不到，就用会话自己的（总比编一个强）', () => {
  const label = resolveAgentLabel({ session: { agentName: '已退役助手' }, agents, fallback: 'Hana' });
  assert.equal(label, '已退役助手');
});

t('会话完全没信息时退到全局兜底', () => {
  assert.equal(resolveAgentLabel({ session: {}, agents, fallback: 'Hana' }), 'Hana');
});

t('Agent 列表缺失也不抛错', () => {
  assert.equal(resolveAgentLabel({ session: { agentId: 'hanako' }, agents: null, fallback: 'Hana' }), 'Hana');
  assert.equal(resolveAgentLabel({}), '');
  assert.equal(resolveAgentLabel(), '');
});

t('agentId 命中的 Agent 自己没名字，继续按名字兜底而不是返回空', () => {
  const halfBaked = [{ id: 'hanako' }, { id: 'hakimi', name: 'Hakimi' }];
  const label = resolveAgentLabel({ session: { agentId: 'hanako', agentName: 'Hakimi' }, agents: halfBaked });
  assert.equal(label, 'Hakimi');
});

t('主流形状：主 Agent 是 A，会话属于 B —— 取 B 不是 A', () => {
  const label = resolveAgentLabel({
    session: { agentId: 'hanako', agentName: 'Hakimi' },
    agents: [{ id: 'hakimi', name: 'Hakimi', isPrimary: true }, { id: 'hanako', name: '小鲸鱼' }],
    fallback: 'Hakimi'
  });
  assert.equal(label, '小鲸鱼');
});

if (bad > 0) {
  console.log(`\n${bad} 个用例失败`);
  process.exit(1);
}
console.log('\nALL PASS');
