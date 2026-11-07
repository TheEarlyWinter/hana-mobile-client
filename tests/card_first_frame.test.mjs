/* tests/card_first_frame.test.mjs
 *
 * E8 卡片首帧高度：加载时不再先显示 220px 灰块、然后「啪」一下变成真实高度。
 *
 * 契约：
 * 1. 新建卡片 iframe 带 data-card-ready="0"（隐藏/淡占位由 web/card-height.css 负责），
 *    此时不写 inline height，让 style.css 的 220px 兜底高度生效；
 * 2. 首次 __hanaCardHeight 上报：写入 clamp 后的高度 + 置 data-card-ready="1"，且只置一次；
 *    过渡只挂在就绪之后（内联样式里不许提前写 transition），否则首帧会从 220 动画到真实高度；
 * 3. 2 秒兜底是硬要求：卡片脚本报错、跨源被拦时也必须显示出来（220px，且不超过 80vh），
 *    不能永远隐身；
 * 4. clamp（80–4000）与来源校验（contentWindow === e.source）等既有安全判断一律不削弱。
 */

import assert from 'node:assert/strict';
import { renderCard, renderCardByPath, installCardHeightBridge } from '../web/card.js';

/* ---- 假 DOM / 假定时器夹具 ---- */

function createFakeEnv() {
  const frames = [];
  const listeners = [];
  let frameSeq = 0;

  function createElement(tag) {
    const attrs = new Map();
    const el = {
      tagName: String(tag).toUpperCase(),
      className: '',
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      __setCalls: [],
      setAttribute(k, v) {
        attrs.set(String(k), String(v));
        el.__setCalls.push([String(k), String(v)]);
      },
      getAttribute(k) {
        const v = attrs.get(String(k));
        return v === undefined ? null : v;
      },
      appendChild(child) {
        el.children.push(child);
        child.parentNode = el;
        return child;
      },
    };
    if (el.tagName === 'IFRAME') {
      // 每个 iframe 独立的 contentWindow：父侧靠 contentWindow === e.source 认来源
      el.contentWindow = { __frameId: ++frameSeq };
      el.offsetHeight = 0;
      frames.push(el);
    }
    return el;
  }

  const doc = {
    createElement,
    querySelectorAll(selector) {
      if (String(selector).trim() !== 'iframe.card-frame') return [];
      return frames.filter((f) => String(f.className).split(/\s+/).includes('card-frame'));
    },
  };

  const win = {
    innerHeight: 800,
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
    },
    removeEventListener(type, fn) {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    },
  };

  return {
    frames,
    doc,
    win,
    fire(data, source) {
      for (const fn of [...listeners]) fn({ data, source });
    },
  };
}

/** 假定时器：schedule(fn, ms) 返回取消函数，advance(ms) 按到期时间推进。 */
function createFakeTimers() {
  let now = 0;
  let seq = 0;
  const tasks = new Map();

  function schedule(fn, ms) {
    const id = ++seq;
    tasks.set(id, { at: now + Math.max(0, Number(ms) || 0), fn });
    return () => { tasks.delete(id); };
  }

  function advance(ms) {
    const target = now + Math.max(0, Number(ms) || 0);
    for (;;) {
      let nextId = null;
      let nextAt = Infinity;
      for (const [id, task] of tasks) {
        if (task.at <= target && task.at < nextAt) {
          nextAt = task.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const task = tasks.get(nextId);
      tasks.delete(nextId);
      now = task.at;
      task.fn();
    }
    now = target;
  }

  return { schedule, advance, pending: () => tasks.size };
}

function countReadyMarks(iframe) {
  return iframe.__setCalls.filter(([k, v]) => k === 'data-card-ready' && v === '1').length;
}

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

/** 每个用例一套干净的假环境：renderCard 用全局 document，桥用显式注入。 */
function setup() {
  const env = createFakeEnv();
  const timers = createFakeTimers();
  globalThis.document = env.doc;
  globalThis.window = env.win;
  installCardHeightBridge({ window: env.win, document: env.doc });
  return { env, timers };
}

/* ---- 用例 ---- */

await t('1. 首次上报前：卡片标记为未就绪，且不预置 inline 高度', async () => {
  const { env, timers } = setup();

  const { iframe } = renderCard('<p>hello</p>', { title: '待就绪卡片', schedule: timers.schedule });

  assert.equal(iframe.className, 'card-frame');
  assert.equal(iframe.getAttribute('data-card-ready'), '0', '新建卡片必须是未就绪状态');
  assert.equal(iframe.style.height, undefined, '未就绪时不能写 inline 高度，220px 兜底交给 CSS');
  assert.equal(iframe.style.transition, undefined, '过渡不能由内联样式在就绪前写死');
  assert.equal(timers.pending(), 1, '每张卡片必须挂一个首帧兜底定时器');
  assert.ok(env.frames.includes(iframe));
});

await t('2. 首次上报：写高度 + 置就绪且只置一次；之后的变高不再重复置，兜底定时器被清掉', async () => {
  const { env, timers } = setup();

  const { iframe } = renderCard('<p>hi</p>', { title: '卡片', schedule: timers.schedule });

  env.fire({ __hanaCardHeight: 512 }, iframe.contentWindow);

  assert.equal(iframe.style.height, '512px', '首次上报后必须立刻写入真实高度');
  assert.equal(iframe.getAttribute('data-card-ready'), '1', '首次上报后必须置就绪');
  assert.equal(countReadyMarks(iframe), 1, '就绪（过渡开关）只能置一次');
  assert.equal(timers.pending(), 0, '首次上报后兜底定时器必须清掉');

  env.fire({ __hanaCardHeight: 640 }, iframe.contentWindow);
  assert.equal(iframe.style.height, '640px', '之后的高度变化继续跟随上报');
  assert.equal(countReadyMarks(iframe), 1, '就绪标记不许被反复重写');
  assert.equal(iframe.style.transition, undefined, '过渡只能由就绪后的 CSS 提供，不写内联');

  timers.advance(5000);
  assert.equal(iframe.style.height, '640px', '兜底定时器已清掉，不能再把高度改回 220');
});

await t('3. 2 秒兜底：2000ms 内没有任何上报，卡片也必须显示出来（硬要求）', async () => {
  const { env, timers } = setup();

  const { iframe } = renderCard('<p>脚本可能报错</p>', { title: '沉默卡片', schedule: timers.schedule });

  timers.advance(1999);
  assert.equal(iframe.getAttribute('data-card-ready'), '0', '不到 2 秒不许提前显示');

  timers.advance(1);
  assert.equal(iframe.getAttribute('data-card-ready'), '1', '到 2 秒必须显示，不能永远隐身');
  assert.equal(iframe.style.height, '220px', '兜底高度是 220px');
  assert.ok(env.frames.includes(iframe));

  // 视口很矮时兜底高度不超过 80vh
  env.win.innerHeight = 200;
  const short = renderCard('<p>矮视口</p>', { title: '矮视口卡片', schedule: timers.schedule });
  timers.advance(2000);
  assert.equal(short.iframe.getAttribute('data-card-ready'), '1');
  assert.equal(short.iframe.style.height, '160px', '80vh 上限生效：200 * 0.8 = 160');

  // 兜底显示之后，真实上报仍然可以纠正高度
  env.fire({ __hanaCardHeight: 900 }, short.iframe.contentWindow);
  assert.equal(short.iframe.style.height, '900px', '兜底之后真实高度必须还能覆盖');
});

await t('4. 恶意/异常上报：非有限正数一律忽略，超大值 clamp 到 4000，不能借上报改可见性', async () => {
  const { env, timers } = setup();

  const { iframe } = renderCard('<p>x</p>', { title: '异常卡片', schedule: timers.schedule });

  const badValues = [-50, 0, NaN, Infinity, -Infinity, '500', '600', null, undefined, {}, [], true];
  for (const value of badValues) {
    env.fire({ __hanaCardHeight: value }, iframe.contentWindow);
  }
  assert.equal(iframe.style.height, undefined, '异常值不许写高度');
  assert.equal(iframe.getAttribute('data-card-ready'), '0', '异常值不许把卡片点亮');
  assert.equal(countReadyMarks(iframe), 0);

  // 超大值是有限正数：按既有契约 clamp 到 4000，而不是无限撑高
  env.fire({ __hanaCardHeight: 1e9 }, iframe.contentWindow);
  assert.equal(iframe.style.height, '4000px');
  assert.equal(iframe.getAttribute('data-card-ready'), '1');

  // 极小值抬到 80 下限
  const tiny = renderCard('<p>y</p>', { title: '极小值卡片', schedule: timers.schedule });
  env.fire({ __hanaCardHeight: 5 }, tiny.iframe.contentWindow);
  assert.equal(tiny.iframe.style.height, '80px');

  // 消息体本身畸形也不能炸
  env.fire(null, iframe.contentWindow);
  env.fire(undefined, iframe.contentWindow);
  env.fire('not-an-object', iframe.contentWindow);
  env.fire([1, 2, 3], iframe.contentWindow);
  assert.equal(iframe.style.height, '4000px', '畸形消息体不改变既有高度');
});

await t('5. 来源不匹配：非本卡片 iframe 的消息一律忽略，只认 contentWindow === e.source', async () => {
  const { env, timers } = setup();

  const a = renderCard('<p>A</p>', { title: '卡片 A', schedule: timers.schedule });
  const b = renderCard('<p>B</p>', { title: '卡片 B', schedule: timers.schedule });

  env.fire({ __hanaCardHeight: 333 }, { __frameId: 999 });   // 陌生 window
  env.fire({ __hanaCardHeight: 444 }, null);                  // 无 source
  assert.equal(a.iframe.getAttribute('data-card-ready'), '0', '陌生来源不能点亮卡片 A');
  assert.equal(a.iframe.style.height, undefined);
  assert.equal(b.iframe.getAttribute('data-card-ready'), '0', '陌生来源不能点亮卡片 B');
  assert.equal(b.iframe.style.height, undefined);

  // 卡片 B 的上报不能改到卡片 A
  env.fire({ __hanaCardHeight: 700 }, b.iframe.contentWindow);
  assert.equal(b.iframe.style.height, '700px');
  assert.equal(b.iframe.getAttribute('data-card-ready'), '1');
  assert.equal(a.iframe.style.height, undefined, '跨卡片串写必须被拦住');
  assert.equal(a.iframe.getAttribute('data-card-ready'), '0');
});

await t('6. renderCardByPath 同样先标未就绪；dispose 后兜底定时器不再把卡片点亮', async () => {
  const { env, timers } = setup();

  const byPath = renderCardByPath('D:/workspace/cards/demo', { title: '目录卡片', schedule: timers.schedule });
  assert.equal(byPath.iframe.getAttribute('data-card-ready'), '0', 'path 卡片也必须先标未就绪');
  assert.equal(byPath.iframe.style.height, undefined);

  const { iframe, dispose } = renderCard('<p>会被移除</p>', { title: '已销毁卡片', schedule: timers.schedule });
  assert.equal(timers.pending(), 2);
  dispose();
  assert.equal(timers.pending(), 1, 'dispose 必须清掉自己的兜底定时器');

  timers.advance(10000);
  assert.equal(iframe.getAttribute('data-card-ready'), '0', '已销毁的卡片不该再被点亮');
  assert.equal(byPath.iframe.getAttribute('data-card-ready'), '1', '未销毁的卡片照常兜底显示');
  assert.ok(env.frames.length >= 2);
});

if (bad > 0) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
