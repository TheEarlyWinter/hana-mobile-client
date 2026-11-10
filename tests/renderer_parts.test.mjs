/* tests/renderer_parts.test.mjs
 *
 * 从 chat-renderer.js 搬出去的两块纯逻辑，各守一摊：
 *
 *   web/renderer-stats.js — 尾注的时钟 / 首响 / 速度、折叠条上的思考时长、计数防御；
 *   web/tool-line.js      — 工具行的显示名、收尾时的「完成 / 失败」与 ✓ / ✗。
 *
 * 为什么要单独测：这些字符串和门槛以前藏在渲染器的闭包里，只能靠「开一场消息」
 * 间接看到；搬成纯函数之后边界（0 字符、超长、未知速度、缺字段）就能一条条钉住。
 * 最后一段还从真渲染器抽一次尾注文本——证明渲染器确实用的是这两个模块，
 * 而不是留了一份抄本。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { clockText, countOf, footStatsText, speedOf, thinkLabel } from '../web/renderer-stats.js';
import { prettyToolName, toolMark, toolStateText } from '../web/tool-line.js';
import { sereneSummary } from '../web/turn-summary.js';

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

/* ------------------------------------------------------------------ */
/* 1. 工具行的显示名                                                    */
/* ------------------------------------------------------------------ */

t('prettyToolName：宿主真实形态（app 前缀 + 双下划线重复段 + _bro + 调用 hash）', () => {
  // 这一段名字在真机上出现过：前缀、宿主 id、调用 hash 都不该露给用户
  assert.equal(
    prettyToolName('app__twinkstar_web_access__twinkstar_web_access_bro_006a28b90908'),
    'twinkstar web access',
  );
  assert.equal(prettyToolName('mcp__fs__fs'), 'fs', 'A__A 的分段重复要合并成一段');
  assert.equal(prettyToolName('tool_name__tool_name'), 'tool name');
  assert.equal(prettyToolName('app__x__y_bro_006a28b90908'), 'x y');
  assert.equal(prettyToolName('app__onlyprefix'), 'onlyprefix');
});

t('prettyToolName：只削结构，不改大小写、不做驼峰分词', () => {
  // 分词与「这是哪类工具」是 tool-ops.js 的事，这里不许越界
  assert.equal(prettyToolName('readFile'), 'readFile');
  assert.equal(prettyToolName('Bash'), 'Bash');
  assert.equal(prettyToolName('current_status'), 'current status', '下划线在显示名里是空格');
  assert.equal(prettyToolName('x'), 'x');
});

t('prettyToolName：缺字段 / 假值一律退回 tool', () => {
  for (const value of [undefined, null, '', 0, false, NaN]) {
    assert.equal(prettyToolName(value), 'tool', `入参 ${String(value)} 应退回 tool`);
  }
  assert.equal(prettyToolName(), 'tool');
});

t('prettyToolName：超长重复段是线性的（老写法会灾难性回溯把主线程卡死）', () => {
  // 曾经的写法 /^(.+?)[ _-]\1$/ 遇到这种输入能把单测挂住；现在是线性的
  const repeated = `${'a'.repeat(64)}_${'a'.repeat(64)}`;
  const startedAt = Date.now();
  const name = prettyToolName(repeated);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(name, 'a'.repeat(64), '重复段应合并成一段');
  assert.ok(elapsedMs < 1000, `线性正则不该耗时 ${elapsedMs}ms`);
});

t('prettyToolName：超长名字不截断（省略交给 CSS）', () => {
  const long = 'b'.repeat(300);
  assert.equal(prettyToolName(long).length, 300);
});

/* ------------------------------------------------------------------ */
/* 2. 工具行的收尾三态                                                  */
/* ------------------------------------------------------------------ */

t('toolStateText / toolMark：成功与失败各自的文案成对', () => {
  assert.equal(toolStateText(false), '完成');
  assert.equal(toolMark(false), '✓');
  assert.equal(toolStateText(true), '失败');
  assert.equal(toolMark(true), '✗');
});

t('toolStateText / toolMark：只认明确的失败，缺字段按成功算', () => {
  // 调用方传的是 tool_end 化简后的布尔；undefined 不该被当成失败
  for (const value of [undefined, null, 0, '']) {
    assert.equal(toolStateText(value), '完成', `入参 ${String(value)} 应按成功处理`);
    assert.equal(toolMark(value), '✓');
  }
});

/* ------------------------------------------------------------------ */
/* 3. 计数防御                                                          */
/* ------------------------------------------------------------------ */

t('countOf：正整数原样，其余一律当 0', () => {
  assert.equal(countOf(3), 3);
  assert.equal(countOf(1), 1);
  for (const value of [0, -1, -0.5, 1.5, '3', '0', NaN, Infinity, -Infinity, true, null, undefined, {}, []]) {
    assert.equal(countOf(value), 0, `脏值 ${String(value)} 应算作没有这一项`);
  }
});

t('countOf：-0 与超大整数边界（阈值只看「是不是正整数」，不看量级）', () => {
  assert.equal(countOf(-0), 0, '-0 不是正数');
  assert.equal(countOf(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER, '安全整数原样透传');
  assert.equal(countOf(Number.MAX_SAFE_INTEGER + 1), Number.MAX_SAFE_INTEGER + 1, '超出安全整数也不截');
  assert.equal(countOf(1e21), 1e21, 'Number.isInteger(1e21) 为真，仍原样透传');
});

t('countOf 与 turn-summary 是同一份阈值（合并后只剩一处）', () => {
  // turn-summary 直接 import 这一份：同一批脏值必须同时判成「无此片段」。
  // 谁在 turn-summary 里另抄一份宽松的（比如收下 '3'），这条先红。
  for (const value of [0, -1, -0.5, 1.5, '3', '0', NaN, Infinity, true, null, {}, []]) {
    assert.equal(countOf(value), 0, `宿主模块：${String(value)} 应是 0`);
    assert.equal(sereneSummary({ thinkingCount: value }), '忙了一阵', `摘要侧：${String(value)} 不该成片段`);
  }
  assert.equal(sereneSummary({ thinkingCount: 2 }), '2 次思考', '好值两边都得认');
});

/* ------------------------------------------------------------------ */
/* 4. 思考时长                                                          */
/* ------------------------------------------------------------------ */

t('thinkLabel：不足 1 秒只说「思考」', () => {
  for (const sec of [0, 0.4, 0.99, -3, NaN, undefined, null]) {
    assert.equal(thinkLabel(sec), '思考', `秒数 ${String(sec)} 不该报数字`);
  }
});

t('thinkLabel：1~10 秒带一位小数，10 秒以上报整秒', () => {
  assert.equal(thinkLabel(1), '思考了 1.0 秒', '刚过门槛也保留一位小数，形状不跳变');
  assert.equal(thinkLabel(9.94), '思考了 9.9 秒');
  assert.equal(thinkLabel(12.6), '思考了 13 秒');
  assert.equal(thinkLabel(30), '思考了 30 秒');
  assert.equal(thinkLabel(1e6), '思考了 1000000 秒', '超长时长不许出现科学计数法');
});

/* ------------------------------------------------------------------ */
/* 5. 尾注数字                                                          */
/* ------------------------------------------------------------------ */

t('footStatsText：缺字段 / 全 0 时返回空串（面板上不留一道空白）', () => {
  assert.equal(footStatsText(), '');
  assert.equal(footStatsText({}), '');
  assert.equal(footStatsText({ firstTokenMs: 0, speed: 0 }), '');
  assert.equal(footStatsText({ firstTokenMs: 0, speed: NaN }), '', '未知速度不参与拼装');
});

t('footStatsText：首响不足 10 秒报一位小数，过了就报整秒', () => {
  assert.equal(footStatsText({ firstTokenMs: 1234 }), ' · 首响 1.2 s');
  assert.equal(footStatsText({ firstTokenMs: 12345 }), ' · 首响 12 s');
  assert.equal(footStatsText({ firstTokenMs: 8123456 }), ' · 首响 8123 s');
});

t('footStatsText：速度按 100 字/秒分档', () => {
  assert.equal(footStatsText({ speed: 30.44 }), ' · 30.4 字/s');
  assert.equal(footStatsText({ speed: 123.4 }), ' · 123 字/s');
});

t('footStatsText：两项齐全时顺序是 首响 → 速度，分隔符固定 ` · `', () => {
  const text = footStatsText({ firstTokenMs: 2500, speed: 45 });
  assert.equal(text, ' · 首响 2.5 s · 45.0 字/s');
  assert.deepEqual(text.split(' · '), ['', '首响 2.5 s', '45.0 字/s'], '前导分隔符是形状的一部分');
});

t('footStatsText：返回值永远是字符串', () => {
  for (const stats of [undefined, {}, { firstTokenMs: 1 }, { speed: 1 }, { firstTokenMs: 1, speed: 1 }]) {
    assert.equal(typeof footStatsText(stats), 'string');
  }
});

/* ------------------------------------------------------------------ */
/* 6. 速度门槛                                                          */
/* ------------------------------------------------------------------ */

t('speedOf：缺字段 / 0 字符也算不出速度', () => {
  assert.equal(speedOf(), 0);
  assert.equal(speedOf({}), 0);
  assert.equal(speedOf({ charCount: 0, firstTokenMs: 100, elapsedMs: 9000 }), 0);
  assert.equal(speedOf({ charCount: 500, elapsedMs: 9000 }), 0, '没有首响时间就不报速度');
  assert.equal(speedOf({ charCount: NaN, firstTokenMs: 100, elapsedMs: 9000 }), 0);
});

t('speedOf：整轮不足 40 字不算（正好 40 字也不算）', () => {
  assert.equal(speedOf({ charCount: 40, firstTokenMs: 100, elapsedMs: 9000 }), 0);
  assert.equal(speedOf({ charCount: 39, firstTokenMs: 100, elapsedMs: 9000 }), 0);
  assert.ok(speedOf({ charCount: 41, firstTokenMs: 100, elapsedMs: 9000 }) > 0);
});

t('speedOf：扣掉首响后不足 0.2 秒的样本丢弃（正好 0.2 秒也丢）', () => {
  assert.equal(speedOf({ charCount: 100, firstTokenMs: 100, elapsedMs: 300 }), 0);
  assert.equal(speedOf({ charCount: 100, firstTokenMs: 500, elapsedMs: 700 }), 0);
  assert.ok(speedOf({ charCount: 100, firstTokenMs: 500, elapsedMs: 701 }) > 0);
});

t('speedOf：算法是 字数 ÷（(现在 - 起点 - 首响)/1000）', () => {
  assert.equal(speedOf({ charCount: 41, firstTokenMs: 200, elapsedMs: 9000 }), 41 / 8.8);
  assert.equal(speedOf({ charCount: 1e6, firstTokenMs: 500, elapsedMs: 10000 }), 1e6 / 9.5);
});

/* ------------------------------------------------------------------ */
/* 7. 尾注时钟                                                          */
/* ------------------------------------------------------------------ */

t('clockText：24 小时制、两位补零、按本地时区', () => {
  assert.equal(clockText(new Date(2026, 0, 2, 9, 5).getTime()), '09:05');
  assert.equal(clockText(new Date(2026, 0, 2, 23, 59).getTime()), '23:59');
  assert.equal(clockText(new Date(2026, 0, 2, 0, 7).getTime()), '00:07');
});

t('clockText：不传参就是现在，形状永远是 HH:MM', () => {
  assert.match(clockText(), /^([01]\d|2[0-3]):[0-5]\d$/);
  assert.match(clockText(1.7e12), /^([01]\d|2[0-3]):[0-5]\d$/);
});

t('clockText：0 与 null 落到 epoch，而不是崩或空串', () => {
  const epoch = new Date(0);
  const expected = `${String(epoch.getHours()).padStart(2, '0')}:${String(epoch.getMinutes()).padStart(2, '0')}`;
  assert.equal(clockText(0), expected);
  assert.equal(clockText(null), expected);
});

/* ------------------------------------------------------------------ */
/* 8. 接线：渲染器确实在用这两个模块                                     */
/* ------------------------------------------------------------------ */

function makeRenderer() {
  const h = createHarness({ debug: false });
  const state = {
    session: null,
    agentName: '小鲸鱼',
    replaying: false,
    turn: null,
    turnBody: null,
    turnFootEl: null,
    turnMeta: null,
    textEl: null,
    streamingRaw: '',
    thinkAt: 0,
    moodEl: null,
    moodRaw: '',
    turnStart: 0,
    firstTokenMs: 0,
    charCount: 0,
    speed: 0,
  };
  const renderer = createChatRenderer({
    state,
    getElement: (id) => h.getEl(id),
    getHistoryView: () => null,
    cardController: null,
    fileUrls: () => ({}),
    paintAvatar: () => {},
    agentAvatarUrlById: () => null,
    userAvatarUrl: () => null,
    flash: () => {},
    onBusyChange: () => {},
  });
  return { h, state, renderer };
}

const { createChatRenderer } = await import('../web/chat-renderer.js');

t('渲染器：paintFootStats 写出的就是 footStatsText 的结果', () => {
  const { state, renderer } = makeRenderer();
  renderer.startAssistantTurn();

  state.firstTokenMs = 1234;
  state.speed = 30.44;
  renderer.paintFootStats();
  const box = state.turnFootEl.querySelector('.foot-stats');
  assert.ok(box, '尾注里应当有 .foot-stats');
  assert.equal(box.textContent, footStatsText({ firstTokenMs: 1234, speed: 30.44 }));
  assert.equal(box.textContent, ' · 首响 1.2 s · 30.4 字/s');

  renderer.clearStats();
  renderer.paintFootStats();
  assert.equal(box.textContent, '', '清理之后回到空串，不是残留旧数字');
});

t('渲染器：clockText 对外仍可用，且与模块结果一致', () => {
  const { renderer } = makeRenderer();
  const ts = new Date(2026, 5, 1, 7, 8, 9).getTime();
  assert.equal(typeof renderer.clockText, 'function', '导出签名不许动');
  assert.equal(renderer.clockText(ts), clockText(ts));
  assert.equal(renderer.clockText(ts), '07:08');
});

t('渲染器：finishTool 的「完成/失败」与 ✓/✗ 走的是同一处文案', () => {
  const { state, renderer } = makeRenderer();
  renderer.startAssistantTurn();
  renderer.addTool('read', undefined, '运行中', 'c1');
  renderer.addTool('read', undefined, '运行中', 'c2');

  const rows = state.turn.querySelectorAll('.meta-tool');
  assert.equal(rows.length, 2);

  renderer.finishTool('c1', false);
  assert.equal(rows[0].querySelector('.state').textContent, toolStateText(true));
  assert.equal(rows[0].querySelector('.op-mark').textContent, toolMark(true));

  renderer.finishTool('c2', true);
  assert.equal(rows[1].querySelector('.state').textContent, toolStateText(false));
  assert.equal(rows[1].querySelector('.op-mark').textContent, toolMark(false));
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
