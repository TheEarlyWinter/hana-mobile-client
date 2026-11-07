/* tests/draft_store.test.mjs
 *
 * web/draft-store.js 单元测试（纯模块，不碰 DOM）：
 * 1. 存 / 取 / 清 / 列表的基本闭环；
 * 2. 空文本（含纯空白）视为删除；
 * 3. list() 按 savedAt 倒序，字段固定为 { key, text, savedAt }；
 * 4. 总预算超限：先丢最旧的；只剩一条还放不下时丢弃该条；
 * 5. 单条 32 KiB 上限；超限不写、不抛；
 * 6. 损坏数据（非 JSON / 结构不对 / 单条字段不对）被忽略并清除；
 * 7. storage 读写抛异常（隐私模式、配额满）不炸，功能退化成内存可用；
 * 8. prune() 清超期（默认 7 天）并做超量裁剪。
 *
 * 时钟与 storage 全部注入，不依赖真实时间和真实 localStorage。
 */

import assert from 'node:assert/strict';
import {
  createDraftStore,
  DRAFT_STORAGE_KEY,
  DEFAULT_MAX_DRAFT_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_TTL_MS,
} from '../web/draft-store.js';

let bad = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

/* ---------------------------- 测试夹具 ---------------------------- */

/** 内存版 storage，行为对齐 localStorage（getItem 返回 string | null）。 */
function createMemoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    get length() {
      return map.size;
    },
  };
}

/** 可推进的假时钟，避免依赖真实时间。 */
function createFakeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    set(value) {
      current = value;
    },
  };
}

/** 按 UTF-8 算字节数（和模块内部的计量口径一致）。 */
const encoder = new TextEncoder();
function byteSizeOf(text) {
  return encoder.encode(text).length;
}

/** 当前整包草稿在存储里占的字节数。 */
function storedBytes(storage) {
  const raw = storage.getItem(DRAFT_STORAGE_KEY);
  return raw == null ? 0 : byteSizeOf(raw);
}

console.log('draft-store 测试');

/* ---------------------------- 用例 ---------------------------- */

await t('导出常量符合约定（单条 32 KiB / 总量 256 KiB / 保留 7 天）', () => {
  assert.equal(DEFAULT_MAX_DRAFT_BYTES, 32 * 1024);
  assert.equal(DEFAULT_MAX_TOTAL_BYTES, 256 * 1024);
  assert.equal(DEFAULT_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

await t('save / get / clear 基本闭环', () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const store = createDraftStore({ storage, now: clock.now });

  assert.equal(store.get('s1'), '', '没存过的 key 返回空字符串');

  const result = store.save('s1', '下午三点开会');
  assert.equal(result.ok, true, 'save 应报告成功');
  assert.equal(store.get('s1'), '下午三点开会');

  // 覆盖保存：文本更新，savedAt 跟随注入时钟
  clock.advance(5000);
  store.save('s1', '下午四点开会');
  assert.equal(store.get('s1'), '下午四点开会');

  store.clear('s1');
  assert.equal(store.get('s1'), '', 'clear 后读到空字符串');
  assert.deepEqual(store.list(), [], 'clear 后列表为空');

  // 清理不存在的 key 不算错
  assert.equal(store.clear('never-saved'), false, 'clear 未存在的 key 返回 false');
});

await t('不同会话 key 互不影响', () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const store = createDraftStore({ storage, now: clock.now });

  store.save('a', '草稿 A');
  store.save('b', '草稿 B');
  assert.equal(store.get('a'), '草稿 A');
  assert.equal(store.get('b'), '草稿 B');

  store.clear('a');
  assert.equal(store.get('a'), '');
  assert.equal(store.get('b'), '草稿 B', '清 a 不能动 b');
});

await t('空文本与纯空白都视为删除', () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const store = createDraftStore({ storage, now: clock.now });

  store.save('s1', '有内容');
  store.save('s1', '');
  assert.equal(store.get('s1'), '', '空字符串等于删除');
  assert.deepEqual(store.list(), []);

  store.save('s2', '有内容');
  store.save('s2', '  \n\t ');
  assert.equal(store.get('s2'), '', '纯空白等于删除');
  assert.deepEqual(store.list(), []);
});

await t('list() 按 savedAt 倒序，字段为 { key, text, savedAt }', () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const store = createDraftStore({ storage, now: clock.now });

  store.save('old', '最旧');
  clock.advance(1000);
  store.save('mid', '中间');
  clock.advance(1000);
  store.save('new', '最新');

  const list = store.list();
  assert.deepEqual(
    list.map((item) => item.key),
    ['new', 'mid', 'old'],
    '列表必须按 savedAt 倒序'
  );
  assert.deepEqual(Object.keys(list[0]).sort(), ['key', 'savedAt', 'text']);
  assert.equal(list[0].text, '最新');
  assert.equal(typeof list[0].savedAt, 'number');

  // 返回的是快照：改它不影响内部状态
  list[0].text = '被外部改掉';
  assert.equal(store.get('new'), '最新', 'list() 必须返回快照，不能暴露内部对象');
});

await t('总预算超限时先丢最旧的草稿', () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const store = createDraftStore({ storage, now: clock.now, maxBytes: 400 });

  const text = 'a'.repeat(90);
  store.save('s1', text);
  clock.advance(1000);
  store.save('s2', text);
  clock.advance(1000);
  const result = store.save('s3', text);

  assert.equal(result.ok, true, '裁剪之后新草稿仍然要写进去');
  assert.deepEqual(
    store.list().map((item) => item.key),
    ['s3', 's2'],
    '预算不够时必须先淘汰最旧的 s1'
  );
  assert.ok(storedBytes(storage) <= 400, `整包不得超出预算，实际 ${storedBytes(storage)}`);
});

await t('总预算连单条都放不下时丢弃该条，不抛异常', () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const store = createDraftStore({ storage, now: clock.now, maxBytes: 200 });

  const result = store.save('big', 'x'.repeat(160));
  assert.equal(result.ok, false, '放不下时不能报告成功');
  assert.equal(result.reason, 'over-budget');
  assert.equal(store.get('big'), '', '放不下的草稿不能留在内存里冒充已保存');
  assert.deepEqual(store.list(), []);
  assert.ok(storedBytes(storage) <= 200);
});

await t('单条草稿超过 32 KiB 不写入（默认上限）', () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const store = createDraftStore({ storage, now: clock.now });

  const justFits = 'a'.repeat(DEFAULT_MAX_DRAFT_BYTES);
  assert.equal(store.save('fit', justFits).ok, true, '正好 32 KiB 应当存得下');
  assert.equal(store.get('fit').length, DEFAULT_MAX_DRAFT_BYTES);

  const tooBig = 'a'.repeat(DEFAULT_MAX_DRAFT_BYTES + 1);
  const result = store.save('huge', tooBig);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too-large');
  assert.equal(store.get('huge'), '', '超限草稿不写入');
});

await t('超限时不能让上一版草稿冒充当前内容', () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const store = createDraftStore({ storage, now: clock.now });

  store.save('s1', '短的旧草稿');
  store.save('s1', 'a'.repeat(DEFAULT_MAX_DRAFT_BYTES + 10));
  assert.equal(store.get('s1'), '', '写不下时宁可空着，也不要回退到旧版本');
});

await t('非 JSON 的历史数据被忽略并清除', () => {
  const storage = createMemoryStorage({ [DRAFT_STORAGE_KEY]: '{这不是 JSON' });
  const clock = createFakeClock();
  const store = createDraftStore({ storage, now: clock.now });

  assert.deepEqual(store.list(), [], '损坏数据不能让整个草稿功能坏掉');
  assert.equal(store.get('any'), '');
  assert.equal(storage.getItem(DRAFT_STORAGE_KEY), null, '损坏数据必须被清除');

  // 清除之后还能正常用
  store.save('s1', '新的草稿');
  assert.equal(store.get('s1'), '新的草稿');
});

await t('结构不对的历史数据被忽略并清除', () => {
  const clock = createFakeClock();

  const cases = [
    ['顶层是数组', '[{"key":"s1","text":"x"}]'],
    ['drafts 是数组', '{"version":1,"drafts":[]}'],
    ['drafts 不是对象', '{"version":1,"drafts":"nope"}'],
    ['顶层是字符串', '"just a string"'],
    ['顶层是 null', 'null'],
  ];

  for (const [label, raw] of cases) {
    const storage = createMemoryStorage({ [DRAFT_STORAGE_KEY]: raw });
    const store = createDraftStore({ storage, now: clock.now });
    assert.deepEqual(store.list(), [], `${label}：drafts 应为空`);
    assert.equal(storage.getItem(DRAFT_STORAGE_KEY), null, `${label}：损坏数据必须被清除`);
  }
});

await t('单条结构不对只丢这一条，其余仍然可用', () => {
  const raw = JSON.stringify({
    version: 1,
    drafts: {
      brokenText: { text: 42, savedAt: 1 },
      brokenTime: { text: '时间坏了', savedAt: 'yesterday' },
      brokenShape: 'not an object',
      good: { text: '好的草稿', savedAt: 1000 },
    },
  });
  const storage = createMemoryStorage({ [DRAFT_STORAGE_KEY]: raw });
  const clock = createFakeClock(2000);
  const store = createDraftStore({ storage, now: clock.now });

  assert.deepEqual(
    store.list().map((item) => item.key),
    ['good'],
    '坏条目被丢掉，好条目必须保留'
  );
  assert.equal(store.get('good'), '好的草稿');

  // 坏条目应该从存储里被移除
  const rewritten = JSON.parse(storage.getItem(DRAFT_STORAGE_KEY));
  assert.deepEqual(Object.keys(rewritten.drafts), ['good']);
});

await t('storage 读抛异常时不炸（隐私模式）', () => {
  const clock = createFakeClock();
  const storage = {
    getItem() {
      throw new Error('SecurityError: localStorage 被禁用');
    },
    setItem() {
      throw new Error('SecurityError: localStorage 被禁用');
    },
    removeItem() {
      throw new Error('SecurityError: localStorage 被禁用');
    },
  };

  const store = createDraftStore({ storage, now: clock.now });
  assert.deepEqual(store.list(), []);
  const result = store.save('s1', '内存里还是要能用');
  assert.equal(result.ok, false, '写不进存储要如实报告');
  assert.equal(result.reason, 'write-failed');
  assert.equal(store.get('s1'), '内存里还是要能用', '写失败不应连带丢掉内存中的草稿');
});

await t('容量上限：反复写入不抛异常且不突破总预算', () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const store = createDraftStore({ storage, now: clock.now, maxBytes: 256 * 1024 });

  const chunk = 'x'.repeat(8 * 1024);
  for (let i = 0; i < 60; i += 1) {
    clock.advance(10);
    assert.doesNotThrow(() => store.save(`session-${i}`, chunk), `第 ${i} 次写入不得抛异常`);
  }

  assert.ok(
    storedBytes(storage) <= 256 * 1024,
    `总占用必须被压在预算内，实际 ${storedBytes(storage)}`
  );
  assert.ok(store.list().length > 0, '不应该把所有草稿都丢光');
});

await t('prune() 清掉超期条目（默认 7 天）', () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const store = createDraftStore({ storage, now: clock.now });

  store.save('old', '八天前的草稿');
  clock.advance(2000);
  store.save('recent', '今天的草稿');

  // 推到 old 已过 7 天、recent 还差 1000ms 到期的位置
  clock.advance(DEFAULT_TTL_MS - 1000);
  const result = store.prune();

  assert.equal(result.removed, 1, '只清掉超期的那一条');
  assert.equal(store.get('old'), '', '超期草稿必须被清掉');
  assert.equal(store.get('recent'), '今天的草稿', '未超期的必须保留');
  assert.deepEqual(
    store.list().map((item) => item.key),
    ['recent']
  );

  // 再推 1001ms 后 recent 也超期
  clock.advance(1001);
  store.prune();
  assert.deepEqual(store.list(), [], '第二条也应过期');
  assert.equal(storage.getItem(DRAFT_STORAGE_KEY), null, '全空后不留垃圾键值');
});

await t('加载时就把超预算的历史包裁到预算内', () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const text = 'y'.repeat(90);

  const overBudget = JSON.stringify({
    version: 1,
    drafts: {
      a: { text, savedAt: clock.now() - 10 },
      b: { text, savedAt: clock.now() - 5 },
      c: { text, savedAt: clock.now() - 1 },
    },
  });
  storage.setItem(DRAFT_STORAGE_KEY, overBudget);

  const store = createDraftStore({ storage, now: clock.now, maxBytes: 200 });
  assert.ok(storedBytes(storage) <= 200, `加载时就应裁到预算内，实际 ${storedBytes(storage)}`);
  assert.deepEqual(
    store.list().map((item) => item.key),
    ['c'],
    '按 savedAt 从旧到新淘汰，只剩最新那条'
  );
});

await t('加载时丢弃超期历史草稿', () => {
  const clock = createFakeClock();
  const raw = JSON.stringify({
    version: 1,
    drafts: {
      ancient: { text: '八天前的草稿', savedAt: clock.now() - DEFAULT_TTL_MS - 1 },
      recent: { text: '今天的草稿', savedAt: clock.now() - 1000 },
    },
  });
  const storage = createMemoryStorage({ [DRAFT_STORAGE_KEY]: raw });
  const store = createDraftStore({ storage, now: clock.now });

  assert.deepEqual(
    store.list().map((item) => item.key),
    ['recent'],
    '首屏恢复不该把陈年草稿翻出来'
  );
});

await t('非法 key 不写入也不抛异常', () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const store = createDraftStore({ storage, now: clock.now });

  for (const key of ['', '   ', null, undefined, 42, {}]) {
    const result = store.save(key, '内容');
    assert.equal(result.ok, false, `非法 key ${String(key)} 不能报告成功`);
    assert.equal(result.reason, 'bad-key');
  }
  assert.deepEqual(store.list(), []);
  assert.equal(store.get(null), '');
});

await t('随机 key 压测：写入的内容总能原样读回', () => {
  const storage = createMemoryStorage();
  const clock = createFakeClock();
  const store = createDraftStore({ storage, now: clock.now });

  const expected = new Map();
  for (let i = 0; i < 40; i += 1) {
    const key = `session-${i}-${(i * 7919).toString(36)}`;
    const text = `第 ${i} 条草稿 ` + 'z'.repeat(i * 7);
    clock.advance(3);
    store.save(key, text);
    expected.set(key, text);
  }

  // 40 条小文本远低于 256 KiB，必须一条不少
  assert.equal(store.list().length, expected.size);
  for (const [key, text] of expected) {
    assert.equal(store.get(key), text, `key ${key} 的内容不一致`);
  }
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
