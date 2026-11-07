/* tests/turn_summary.test.mjs
 *
 * 沉静视图的文案规则（纯函数，不碰 DOM）。
 *
 * 片段顺序固定，非正数片段不出现，用 ` · ` 连接；没有过程内容时退成人话
 * 「正在进行 / 忙了一阵」。计数脏数据（负数 / 小数 / 字符串 / NaN）
 * 一律当「无此片段」——半个屏幕上冒出 `NaN 次思考` 比少一行更糟。
 */

import assert from 'node:assert/strict';
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

const FOUR = '忙了一阵';
const LIVE = '正在进行';

t('什么都不传：没有过程也不在流式里 → 忙了一阵', () => {
  assert.equal(sereneSummary(), FOUR);
  assert.equal(sereneSummary({}), FOUR);
});

t('全零计数等价于没有过程', () => {
  assert.equal(sereneSummary({ thinkingCount: 0, opCount: 0, failedCount: 0 }), FOUR);
});

t('无片段 + streaming → 正在进行', () => {
  assert.equal(sereneSummary({ streaming: true }), LIVE);
});

t('只有思考：单项不加分隔符', () => {
  assert.equal(sereneSummary({ thinkingCount: 3 }), '3 次思考');
});

t('三项齐全：顺序固定 思考 → 操作 → 未成功', () => {
  assert.equal(
    sereneSummary({ thinkingCount: 2, opCount: 5, failedCount: 1 }),
    '2 次思考 · 5 项操作 · 1 项未成功',
  );
});

t('缺中间项不影响顺序', () => {
  assert.equal(
    sereneSummary({ thinkingCount: 1, failedCount: 2 }),
    '1 次思考 · 2 项未成功',
  );
  assert.equal(sereneSummary({ opCount: 4, failedCount: 4 }), '4 项操作 · 4 项未成功');
});

t('有片段 + streaming → 尾部追加正在进行', () => {
  assert.equal(sereneSummary({ thinkingCount: 1, opCount: 1, streaming: true }), '1 次思考 · 1 项操作 · 正在进行');
  assert.equal(sereneSummary({ opCount: 2, streaming: true }), '2 项操作 · 正在进行');
});

t('有片段 + 非 streaming → 不带正在进行', () => {
  assert.equal(sereneSummary({ thinkingCount: 1, opCount: 1, streaming: false }), '1 次思考 · 1 项操作');
});

t('负数当无此片段', () => {
  assert.equal(sereneSummary({ thinkingCount: -1, opCount: -2, failedCount: -3 }), FOUR);
  assert.equal(sereneSummary({ thinkingCount: -1, opCount: 2 }), '2 项操作');
  assert.equal(sereneSummary({ thinkingCount: -1, streaming: true }), LIVE);
});

t('小数当无此片段', () => {
  assert.equal(sereneSummary({ thinkingCount: 1.5, opCount: 2.9 }), FOUR);
  assert.equal(sereneSummary({ thinkingCount: 1.5, opCount: 3 }), '3 项操作');
});

t('字符串计数当无此片段（哪怕能转成数字）', () => {
  assert.equal(sereneSummary({ thinkingCount: '3', opCount: '2', failedCount: '1' }), FOUR);
  assert.equal(sereneSummary({ thinkingCount: '3', opCount: 1 }), '1 项操作');
});

t('NaN / Infinity 当无此片段，且绝不出现 NaN 字样', () => {
  for (const value of [NaN, Infinity, -Infinity, undefined, null, true, {}, []]) {
    const text = sereneSummary({ thinkingCount: value, opCount: value, failedCount: value });
    assert.equal(text, FOUR, `脏值 ${String(value)} 应退成忙了一阵，实际：${text}`);
    assert.ok(!text.includes('NaN'), `绝不能出现 NaN，实际：${text}`);
  }
});

t('脏值与好值混着来：只保留好值那几段', () => {
  assert.equal(
    sereneSummary({ thinkingCount: 2, opCount: '9', failedCount: NaN }),
    '2 次思考',
  );
  assert.equal(
    sereneSummary({ thinkingCount: NaN, opCount: 3, failedCount: 1, streaming: true }),
    '3 项操作 · 1 项未成功 · 正在进行',
  );
});

t('分隔符固定是 ·（中间点带空格）', () => {
  const text = sereneSummary({ thinkingCount: 1, opCount: 1, failedCount: 1 });
  assert.deepEqual(text.split(' · '), ['1 次思考', '1 项操作', '1 项未成功']);
});

t('返回值永远是字符串', () => {
  for (const stats of [undefined, {}, { thinkingCount: 1 }, { streaming: true }, { failedCount: 2 }]) {
    assert.equal(typeof sereneSummary(stats), 'string');
  }
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
