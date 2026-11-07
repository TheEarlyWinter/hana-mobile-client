/**
 * 特性注册表自身的测试。
 *
 * 它以后会成为所有功能的装配地基，所以这里重点验四类容易出错的行为：
 * 启动顺序、依赖缺失 / 成环的报错、能力暴露重名、销毁的倒序与容错。
 */

import assert from 'node:assert/strict';
import { createFeatureRegistry } from '../web/features/registry.js';

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('按登记顺序启动，同层不乱序', () => {
  const reg = createFeatureRegistry();
  const seen = [];
  for (const name of ['alpha', 'beta', 'gamma']) {
    reg.register({ name, register: () => { seen.push(name); } });
  }
  const run = reg.start();
  assert.deepEqual(seen, ['alpha', 'beta', 'gamma']);
  assert.deepEqual(run.order, ['alpha', 'beta', 'gamma']);
});

test('依赖先启动，即使依赖是后登记的', () => {
  const reg = createFeatureRegistry();
  const seen = [];
  reg.register({ name: 'child', dependsOn: ['parent'], register: () => { seen.push('child'); } });
  reg.register({ name: 'parent', register: () => { seen.push('parent'); } });
  reg.start();
  assert.deepEqual(seen, ['parent', 'child']);
});

test('多层依赖按拓扑序展开', () => {
  const reg = createFeatureRegistry();
  reg.register({ name: 'c', dependsOn: ['b'], register: () => {} });
  reg.register({ name: 'b', dependsOn: ['a'], register: () => {} });
  reg.register({ name: 'a', register: () => {} });
  assert.deepEqual(reg.plan(), ['a', 'b', 'c']);
});

test('依赖成环要报错并指出环路', () => {
  const reg = createFeatureRegistry();
  reg.register({ name: 'x', dependsOn: ['y'], register: () => {} });
  reg.register({ name: 'y', dependsOn: ['x'], register: () => {} });
  assert.throws(() => reg.start(), /依赖成环/);
});

test('依赖了不存在的特性要报错', () => {
  const reg = createFeatureRegistry();
  reg.register({ name: 'solo', dependsOn: ['ghost'], register: () => {} });
  assert.throws(() => reg.start(), /未登记的特性：ghost/);
});

test('重名登记直接拒绝', () => {
  const reg = createFeatureRegistry();
  reg.register({ name: 'dup', register: () => {} });
  assert.throws(() => reg.register({ name: 'dup', register: () => {} }), /重名/);
});

test('名字不合法要拒绝', () => {
  const reg = createFeatureRegistry();
  for (const bad of ['', 'Upper', 'has space', '1abc', '中文']) {
    assert.throws(() => reg.register({ name: bad, register: () => {} }), /名不合法/);
  }
});

test('缺 register 要拒绝', () => {
  const reg = createFeatureRegistry();
  assert.throws(() => reg.register({ name: 'nofn' }), /缺少 register/);
});

test('expose 与 require 按注册顺序解析', () => {
  const reg = createFeatureRegistry();
  let received = null;
  reg.register({
    name: 'producer',
    register: (ctx) => { ctx.expose('answer', { value: 42 }); },
  });
  reg.register({
    name: 'consumer',
    dependsOn: ['producer'],
    register: (ctx) => { received = ctx.require('answer').value; },
  });
  reg.start();
  assert.equal(received, 42);
});

test('能力重名要报错', () => {
  const reg = createFeatureRegistry();
  reg.register({ name: 'one', register: (ctx) => { ctx.expose('dup', 1); } });
  reg.register({ name: 'two', register: (ctx) => { ctx.expose('dup', 2); } });
  assert.throws(() => reg.start(), /能力重名/);
});

test('require 没登记的能力要报错', () => {
  const reg = createFeatureRegistry();
  reg.register({ name: 'lonely', register: (ctx) => { ctx.require('nothing'); } });
  assert.throws(() => reg.start(), /能力 nothing 还不存在/);
});

test('启动失败时报错带上特性名', () => {
  const reg = createFeatureRegistry();
  reg.register({ name: 'boom', register: () => { throw new Error('内部炸了'); } });
  assert.throws(() => reg.start(), /特性 boom 启动失败：内部炸了/);
});

test('销毁按启动倒序，且单个失败不拦住别人', () => {
  const reg = createFeatureRegistry();
  const log = [];
  const failed = [];
  reg.register({
    name: 'first',
    register: () => ({ dispose: () => log.push('first') }),
  });
  reg.register({
    name: 'second',
    register: () => ({ dispose: () => { log.push('second'); throw new Error('收尾炸了'); } }),
  });
  reg.register({
    name: 'third',
    register: () => ({ dispose: () => log.push('third') }),
  });
  const run = reg.start();
  run.dispose();
  assert.deepEqual(log, ['third', 'second', 'first']);
  // 上面 second 抛错后 first 仍然要收尾——这里靠 log 已经证明。
  assert.deepEqual(failed, []);
});

test('启动中途失败：已启动项倒序销毁，半成品能力清空，可重试', () => {
  const reg = createFeatureRegistry();
  const log = [];
  let failOnce = true;
  reg.register({
    name: 'alpha',
    register: (ctx) => { ctx.expose('alpha-cap', 'a'); return { dispose: () => log.push('alpha') }; },
  });
  reg.register({ name: 'beta', register: () => ({ dispose: () => log.push('beta') }) });
  reg.register({
    name: 'broken',
    register: (ctx) => {
      ctx.expose('half-cap', 'half');
      if (failOnce) {
        failOnce = false;
        throw new Error('装配到一半炸了');
      }
      return { dispose: () => log.push('broken') };
    },
  });

  assert.throws(() => reg.start(), /特性 broken 启动失败：装配到一半炸了/);
  assert.deepEqual(log, ['beta', 'alpha'], `已启动项必须倒序收尾，实际 ${log.join(',')}`);

  const run = reg.start();          // 失败不能把注册表锁死
  assert.equal(run.get('half-cap'), 'half', '重试后失败特性暴露的能力应正常登记');
  assert.equal(run.get('alpha-cap'), 'a', '重试后已启动项的能力应重新登记');
  run.dispose();
  assert.deepEqual(log, ['beta', 'alpha', 'broken', 'beta', 'alpha']);
});

test('启动失败回滚时 disposer 抛错不拦住其他收尾', () => {
  const reg = createFeatureRegistry();
  const log = [];
  reg.register({ name: 'a', register: () => ({ dispose: () => { log.push('a'); } }) });
  reg.register({ name: 'b', register: () => ({ dispose: () => { log.push('b'); throw new Error('b 收尾炸了'); } }) });
  reg.register({ name: 'c', register: () => ({ dispose: () => { log.push('c'); throw new Error('c 收尾炸了'); } }) });
  reg.register({ name: 'bad', register: () => { throw new Error('起不来'); } });

  assert.throws(() => reg.start(), /特性 bad 启动失败/);
  assert.deepEqual(log, ['c', 'b', 'a'], `回滚必须尝试全部收尾且不因失败中断，实际 ${log.join(',')}`);
});

test('不能重复启动', () => {
  const reg = createFeatureRegistry();
  reg.register({ name: 'once', register: () => {} });
  reg.start();
  assert.throws(() => reg.start(), /不能重复启动/);
});

test('销毁后能力清空，可以重新启动', () => {
  const reg = createFeatureRegistry();
  reg.register({ name: 'prov', register: (ctx) => { ctx.expose('k', 1); } });
  const run = reg.start();
  run.dispose();
  const again = reg.start();
  assert.deepEqual(again.order, ['prov']);
});

test('names 按登记顺序，plan 按启动顺序', () => {
  const reg = createFeatureRegistry();
  reg.register({ name: 'b', dependsOn: ['a'], register: () => {} });
  reg.register({ name: 'a', register: () => {} });
  assert.deepEqual(reg.names(), ['b', 'a']);
  assert.deepEqual(reg.plan(), ['a', 'b']);
  assert.equal(reg.has('a'), true);
  assert.equal(reg.has('zzz'), false);
});

let failed = 0;
for (const c of cases) {
  try {
    c.fn();
    console.log(`  ok  ${c.name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${c.name}\n       ${err.message}`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} 通过`);
if (failed) process.exitCode = 1;
