/* quote-bar 的「版本化消费」契约。
 *
 * 纯模块测试（不启动 app）：发送发起时取一个版本号，发送成功后只消费这一版。
 * 等待期间用户改选/清空引用时，旧版本必须失效，不能把新引用一起清掉。
 *
 * 这是 app 层 onDraftCleared 与引用解耦的地基：清草稿和消费引用各有各的判定，
 * 不能再用「输入框有没有被改过」间接决定引用去留。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createQuoteBar } from '../web/quote-bar.js';

const h = createHarness();

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

function makeBar(options = {}) {
  const mount = h.makeNode('div', '');
  return { mount, bar: createQuoteBar({ document: h.doc, mount, ...options }) };
}

t('发起时取的版本能消费当前这一条引用', () => {
  const { bar } = makeBar();
  bar.set({ text: '要被消费的引用', author: 'Hana' });
  const version = bar.getVersion();
  assert.equal(typeof version, 'number', '版本必须是可传递的数字');

  assert.equal(bar.consume(version), true, '版本一致时应真的清掉');
  assert.equal(bar.get(), null);
  assert.equal(bar.element.hidden, true, '消费后引用条收起');
});

t('等待期间改选新引用：旧版本消费不掉新引用', () => {
  const { bar } = makeBar();
  bar.set({ text: '旧引用' });
  const oldVersion = bar.getVersion();

  bar.set({ text: '等待时改选的新引用' });
  assert.equal(bar.consume(oldVersion), false, '旧版本必须失效');
  assert.equal(bar.get().text, '等待时改选的新引用', '新引用必须留着');

  // 对照：新引用自己的版本仍然可消费。
  assert.equal(bar.consume(bar.getVersion()), true);
  assert.equal(bar.get(), null);
});

t('clear 之后旧版本失效，不会误伤之后的新引用', () => {
  const { bar } = makeBar();
  bar.set({ text: '先有一条' });
  const oldVersion = bar.getVersion();

  bar.clear();
  assert.equal(bar.consume(oldVersion), false, '已经清掉的引用没有可消费对象');

  bar.set({ text: '后来的一条' });
  assert.equal(bar.consume(oldVersion), false, 'clear 之前的版本不能消费后来设置的引用');
  assert.equal(bar.get().text, '后来的一条');
});

t('没有引用时 consume 不生效，也不抛错', () => {
  const { bar } = makeBar();
  const version = bar.getVersion();
  assert.equal(bar.consume(version), false);
  assert.equal(bar.consume(null), false);
  assert.equal(bar.consume(undefined), false);

  // 降级实例（没有 document / mount）同样安全。
  const degraded = createQuoteBar();
  assert.equal(degraded.consume(degraded.getVersion()), false);
  assert.equal(degraded.get(), null);
});

t('消费成功会走一次 onChange(null)，与点 × 的清空路径一致', () => {
  const changes = [];
  const { bar } = makeBar({ onChange: (quote) => changes.push(quote) });
  bar.set({ text: '有回调的引用' });
  bar.consume(bar.getVersion());
  assert.deepEqual(changes.at(-1), null, '消费后必须通知宿主引用已清空');
});

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
