/* tests/theme.test.mjs
 *
 * 深色模式的纯逻辑层（web/theme.js）：值归一化、解析、落到根节点、偏好装配。
 *
 * 为什么单独测：
 *   1. 这一层是「设置里点了深色 → 整屏变深 → 重开还在」的唯一通道，
 *      三个档位 × 系统深浅正好是 4 种组合，配错一格就会出现「选了浅色，系统一换也跟着变」。
 *   2. 手机浏览器隐私模式下 localStorage 连「读属性」都可能抛，
 *      外观是最早落地的一批 UI 状态，它一旦在这里炸，首屏就是白屏。
 *   3. matchMedia 在老 WebView 里可能缺失、也可能只有 addListener，
 *      这两种退化都必须安静降级，不能拦住主题切换。
 *
 * 测试风格与仓库其它 *.test.mjs 一致：自带 t() 收集器、假根 / 假 storage / 假 media，
 * 完全不依赖 DOM 与真实浏览器环境。最后一组用共用假 DOM 夹具跑一次设置面板，
 * 确认「设置里真的多了一个外观三档、点了真的发意图」。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  THEME_MODES,
  DEFAULT_THEME_MODE,
  STORAGE_KEY_THEME,
  THEME_META_COLORS,
  DARK_MEDIA_QUERY,
  normalizeTheme,
  resolveTheme,
  applyTheme,
  createThemeController,
} from '../web/theme.js';
// 设置面板装配用的假 DOM（仓库共用夹具，无 jsdom 依赖）
import { createHarness } from './support/app_harness.mjs';
import { createSettingsView } from '../web/settings-view.js';

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

/** 假根：真 <html> 在测试里太重，dataset 就是 data-theme 的唯一写入点。 */
function makeRoot() {
  return { dataset: {} };
}

/** 假 storage：可选择在读/写时抛错，模拟隐私模式与配额溢出。 */
function makeStorage(initial = {}, { throwOnGet = false, throwOnSet = false } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(k) {
      if (throwOnGet) throw new Error('SecurityError: localStorage is not available');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (throwOnSet) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
  };
}

/** 假 matchMedia 结果：现代接口 addEventListener/removeEventListener。 */
function makeMedia(initialDark = false) {
  const listeners = new Set();
  return {
    media: DARK_MEDIA_QUERY,
    matches: initialDark,
    addEventListener(type, fn) {
      if (type === 'change') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'change') listeners.delete(fn);
    },
    /** 模拟系统切换：改 matches 并同步通知订户 */
    dispatch(matches) {
      this.matches = matches;
      for (const fn of [...listeners]) fn({ matches, media: DARK_MEDIA_QUERY });
    },
    listenerCount: () => listeners.size,
  };
}

/** 老 WebView / 老 Safari 只有 addListener/removeListener 的版本。 */
function makeLegacyMedia(initialDark = false) {
  const listeners = new Set();
  return {
    media: DARK_MEDIA_QUERY,
    matches: initialDark,
    addListener(fn) { listeners.add(fn); },
    removeListener(fn) { listeners.delete(fn); },
    dispatch(matches) {
      this.matches = matches;
      for (const fn of [...listeners]) fn({ matches, media: DARK_MEDIA_QUERY });
    },
    listenerCount: () => listeners.size,
  };
}

/** 收集 onChange 调用，方便断言「通知了几次、每次说什么」。 */
function recorder() {
  const calls = [];
  const onChange = (payload) => calls.push(payload);
  onChange.calls = calls;
  return onChange;
}

/* ------------------------------------------------------------------ 常量 */

await t('常量：三档顺序固定，默认跟随系统，偏好键与状态栏配色都对外暴露', () => {
  assert.deepEqual([...THEME_MODES], ['auto', 'light', 'dark']);
  assert.equal(DEFAULT_THEME_MODE, 'auto');
  assert.equal(STORAGE_KEY_THEME, 'hana-mobile:theme');
  assert.equal(DARK_MEDIA_QUERY, '(prefers-color-scheme: dark)');
  assert.deepEqual({ ...THEME_META_COLORS }, { light: '#F8F4ED', dark: '#171310' });
  assert.ok(Object.isFrozen(THEME_MODES), 'THEME_MODES 必须冻结，避免被运行时改写');
  assert.ok(Object.isFrozen(THEME_META_COLORS), 'THEME_META_COLORS 必须冻结');
});

/* ------------------------------------------------------------------ 归一化 */

await t('normalizeTheme：只认三档精确小写字面量', () => {
  // 期望值写死，不拿 THEME_MODES 自己当答案：否则 normalizeTheme 换成恒等函数也能过
  const literal = ['auto', 'light', 'dark'];
  for (const mode of literal) {
    assert.equal(normalizeTheme(mode), mode);
  }
  assert.deepEqual([...THEME_MODES], literal, '导出的三档顺序必须与面板一致');
});

await t('normalizeTheme：坏值一律落回 auto，不猜成浅色或深色', () => {
  const badValues = [
    null,
    undefined,
    0,
    1,
    true,
    false,
    '',
    'Dark',
    'DARK',
    'light ',
    ' dark',
    'system',
    'warm-paper',
    'auto;',
    {},
    [],
    () => 'dark',
  ];
  for (const value of badValues) {
    assert.equal(normalizeTheme(value), 'auto', `坏值 ${String(value)} 应落回 auto`);
  }
});

/* ------------------------------------------------------------------ 解析 */

await t('resolveTheme：auto 下跟随系统，且严格只认 true', () => {
  assert.equal(resolveTheme('auto', true), 'dark');
  assert.equal(resolveTheme('auto', false), 'light');
  assert.equal(resolveTheme('auto', undefined), 'light', '系统偏好未知时按浅色');
  assert.equal(resolveTheme('auto', 'true'), 'light', '字符串不算系统偏好');
  assert.equal(resolveTheme('auto', 1), 'light', '非布尔一律当没有偏好');
});

await t('resolveTheme：显式浅色 / 深色时系统偏好无话语权', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('dark', false), 'dark');
});

await t('resolveTheme：坏模式的解析结果等同 auto', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme(null, true), 'dark');
  assert.equal(resolveTheme(undefined, false), 'light');
  assert.equal(resolveTheme({}, false), 'light');
});

/* ------------------------------------------------------------------ 落地 */

await t('applyTheme：写 root.dataset.theme，非 dark 一律当 light', () => {
  const root = makeRoot();
  assert.equal(applyTheme(root, 'dark'), 'dark');
  assert.equal(root.dataset.theme, 'dark');

  assert.equal(applyTheme(root, 'light'), 'light');
  assert.equal(root.dataset.theme, 'light');

  // 任何没见过的值都不能让 html 挂上一个界面不认识的 data-theme
  assert.equal(applyTheme(root, 'warm-paper'), 'light');
  assert.equal(root.dataset.theme, 'light');
  assert.equal(applyTheme(root, undefined), 'light');
  assert.equal(root.dataset.theme, 'light');
});

await t('applyTheme：根节点缺失 / 假根没有 dataset 都不抛', () => {
  assert.equal(applyTheme(null, 'dark'), 'dark');
  assert.equal(applyTheme(undefined, 'dark'), 'dark');
  assert.equal(applyTheme('html', 'dark'), 'dark', '非对象根节点安静返回');

  // 只有 setAttribute 的根（比如用别的方式伪造的 documentElement）
  const attrs = new Map();
  const legacyRoot = { setAttribute: (k, v) => attrs.set(k, v) };
  assert.equal(applyTheme(legacyRoot, 'dark'), 'dark');
  assert.equal(attrs.get('data-theme'), 'dark');

  // dataset 只读：赋值抛错时退回 setAttribute
  const frozenAttrs = new Map();
  const frozenRoot = Object.freeze({
    dataset: Object.freeze({}),
    setAttribute: (k, v) => frozenAttrs.set(k, v),
  });
  assert.equal(applyTheme(frozenRoot, 'dark'), 'dark');
  assert.equal(frozenAttrs.get('data-theme'), 'dark', '冻结的 dataset 不应吞掉这次落地');

  // 什么都没有的假根：不抛、照旧返回生效值
  assert.equal(applyTheme({}, 'dark'), 'dark');
});

/* ------------------------------------------------------------------ 控制器：load */

await t('控制器 load：读出存储里的档位并落地，同时通知一次初值', () => {
  const root = makeRoot();
  const storage = makeStorage({ [STORAGE_KEY_THEME]: 'dark' });
  const onChange = recorder();
  const theme = createThemeController({ storage, root, media: makeMedia(false), onChange });

  assert.equal(theme.current(), 'auto', '探测存储之前不假装知道用户选过什么');
  assert.equal(theme.load(), 'dark');
  assert.equal(theme.current(), 'dark');
  assert.equal(root.dataset.theme, 'dark');
  assert.deepEqual(onChange.calls, [{ mode: 'dark', resolved: 'dark' }]);
});

await t('控制器 load：没存过就是 auto；auto + 系统浅色 → 落地 light', () => {
  const root = makeRoot();
  const theme = createThemeController({ storage: makeStorage(), root, media: makeMedia(false) });

  assert.equal(theme.load(), 'light');
  assert.equal(theme.current(), 'auto');
  assert.equal(root.dataset.theme, 'light');
});

await t('控制器 load：auto + 系统深色 → 落地 dark（跟随系统的那一半）', () => {
  const root = makeRoot();
  const theme = createThemeController({ storage: makeStorage(), root, media: makeMedia(true) });

  assert.equal(theme.load(), 'dark');
  assert.equal(root.dataset.theme, 'dark');
});

await t('控制器 load：存储整个坏掉（读就抛）时安静落回 auto，不炸首屏', () => {
  const root = makeRoot();
  const onChange = recorder();
  const theme = createThemeController({
    storage: makeStorage({}, { throwOnGet: true }),
    root,
    media: makeMedia(false),
    onChange,
  });

  assert.doesNotThrow(() => theme.load());
  assert.equal(theme.current(), 'auto');
  assert.equal(root.dataset.theme, 'light');
  assert.deepEqual(onChange.calls, [{ mode: 'auto', resolved: 'light' }]);
});

await t('控制器 load：存储里是非字符串（老版本 / 被别的脚本写坏）也当没存过', () => {
  const root = makeRoot();
  const storage = { getItem: () => 123, setItem: () => {} };
  const theme = createThemeController({ storage, root, media: makeMedia(false) });

  assert.equal(theme.load(), 'light');
  assert.equal(theme.current(), 'auto');
});

/* ------------------------------------------------------------------ 控制器：set */

await t('控制器 set：写存储 + 立刻落地', () => {
  const root = makeRoot();
  const storage = makeStorage();
  const theme = createThemeController({ storage, root, media: makeMedia(false) });

  assert.equal(theme.set('dark'), 'dark');
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(storage.map.get(STORAGE_KEY_THEME), 'dark', '选择必须落库，重开还在靠它');
  assert.equal(theme.current(), 'dark');

  assert.equal(theme.set('light'), 'light');
  assert.equal(root.dataset.theme, 'light');
  assert.equal(storage.map.get(STORAGE_KEY_THEME), 'light');

  // 回到跟随系统：落库写 auto，实际生效值交给系统
  assert.equal(theme.set('auto'), 'light');
  assert.equal(storage.map.get(STORAGE_KEY_THEME), 'auto');
});

await t('控制器 set：坏档位归一成 auto 再落库，不把脏值写进存储', () => {
  const root = makeRoot();
  const storage = makeStorage();
  const theme = createThemeController({ storage, root, media: makeMedia(true) });

  assert.equal(theme.set('Dark'), 'dark', '深色系统下 auto 就是 dark');
  assert.equal(storage.map.get(STORAGE_KEY_THEME), 'auto');
  assert.equal(theme.current(), 'auto');

  assert.equal(theme.set(null), 'dark');
  assert.equal(storage.map.get(STORAGE_KEY_THEME), 'auto');
});

await t('控制器 set：存储写失败（配额满 / 隐私模式）也照常生效，本次会话内立刻变深', () => {
  const root = makeRoot();
  const onChange = recorder();
  const theme = createThemeController({
    storage: makeStorage({}, { throwOnSet: true }),
    root,
    media: makeMedia(false),
    onChange,
  });

  assert.doesNotThrow(() => theme.set('dark'));
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(theme.current(), 'dark');
  assert.deepEqual(onChange.calls, [{ mode: 'dark', resolved: 'dark' }]);
});

await t('控制器 set：同一档位重复点不重复通知（面板重渲不会打出一串回调）', () => {
  const root = makeRoot();
  const onChange = recorder();
  // 系统本身就是深色：这样才能分开验证「生效色没变、但模式变了」的那一格
  const theme = createThemeController({ storage: makeStorage(), root, media: makeMedia(true), onChange });

  theme.load(); // 1 次：auto>dark
  theme.set('dark'); // +1：dark>dark
  theme.set('dark'); // 不涨
  theme.set('dark'); // 不涨
  assert.equal(onChange.calls.length, 2);
  assert.deepEqual(onChange.calls, [{ mode: 'auto', resolved: 'dark' }, { mode: 'dark', resolved: 'dark' }]);

  // 模式变了但生效色没变（dark → auto，系统本来就是深色）也要通知：
  // 面板要靠这一次把「跟随系统」的选中态画对。
  theme.set('auto');
  assert.equal(onChange.calls.length, 3);
  assert.deepEqual(onChange.calls[2], { mode: 'auto', resolved: 'dark' });
});

await t('控制器：onChange 抛错不会吞掉落地，也不会挡住下一次通知', () => {
  const root = makeRoot();
  let calls = 0;
  const theme = createThemeController({
    storage: makeStorage(),
    root,
    media: makeMedia(false),
    onChange: () => {
      calls += 1;
      throw new Error('调用方回调炸了');
    },
  });

  assert.doesNotThrow(() => theme.set('dark'));
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(calls, 1);

  assert.doesNotThrow(() => theme.set('light'));
  assert.equal(root.dataset.theme, 'light');
  assert.equal(calls, 2);
});

/* ------------------------------------------------------------------ 控制器：watch */

await t('控制器 watch：auto 下系统深浅变化实时跟随', () => {
  const root = makeRoot();
  const media = makeMedia(false);
  const onChange = recorder();
  const theme = createThemeController({ storage: makeStorage(), root, media, onChange });

  theme.load();
  const off = theme.watch();
  assert.equal(media.listenerCount(), 1);

  media.dispatch(true);
  assert.equal(root.dataset.theme, 'dark', '系统切深色，界面必须跟着变深');
  assert.equal(onChange.calls.at(-1).resolved, 'dark');

  media.dispatch(false);
  assert.equal(root.dataset.theme, 'light');

  off();
  assert.equal(media.listenerCount(), 0, '返回的退订函数必须真的退订');
});

await t('控制器 watch：显式选了浅色后，系统切深色不抢用户的设置', () => {
  const root = makeRoot();
  const media = makeMedia(false);
  const onChange = recorder();
  const theme = createThemeController({ storage: makeStorage(), root, media, onChange });

  theme.load();
  theme.watch();
  theme.set('light');
  const before = onChange.calls.length;

  media.dispatch(true);
  assert.equal(root.dataset.theme, 'light', '显式浅色时系统变化不得生效');
  assert.equal(onChange.calls.length, before, '也不该发通知');

  media.dispatch(false);
  assert.equal(root.dataset.theme, 'light');
});

await t('控制器 watch：显式选了深色后，系统切浅色也不生效', () => {
  const root = makeRoot();
  const media = makeMedia(false);
  const theme = createThemeController({ storage: makeStorage(), root, media });

  theme.load();
  theme.watch();
  theme.set('dark');

  media.dispatch(false);
  assert.equal(root.dataset.theme, 'dark');

  // 切回 auto 就该重新听系统了
  theme.set('auto');
  assert.equal(root.dataset.theme, 'light');
  media.dispatch(true);
  assert.equal(root.dataset.theme, 'dark');
});

await t('控制器 watch：没有系统偏好对象（media 显式为 null）时安静降级', () => {
  const root = makeRoot();
  const theme = createThemeController({ storage: makeStorage(), root, media: null });

  assert.equal(theme.load(), 'light');
  const off = theme.watch();
  assert.equal(typeof off, 'function');
  assert.doesNotThrow(() => off());

  // 不能因为读不到系统偏好就拒绝显式选择
  assert.equal(theme.set('dark'), 'dark');
  assert.equal(root.dataset.theme, 'dark');
});

await t('控制器 watch：环境里根本没有 matchMedia 时照样能切档位', () => {
  const root = makeRoot();
  const original = globalThis.matchMedia;
  const hadOwn = Object.prototype.hasOwnProperty.call(globalThis, 'matchMedia');
  try {
    delete globalThis.matchMedia;
    const theme = createThemeController({ storage: makeStorage(), root });

    assert.equal(theme.load(), 'light');
    const off = theme.watch();
    assert.equal(typeof off, 'function');
    off();

    assert.equal(theme.set('dark'), 'dark');
    assert.equal(root.dataset.theme, 'dark');
    assert.equal(theme.resolved(), 'dark');
  } finally {
    if (hadOwn) {
      globalThis.matchMedia = original;
    } else if (original !== undefined) {
      globalThis.matchMedia = original;
    } else {
      delete globalThis.matchMedia;
    }
  }
});

await t('控制器 watch：环境里的 matchMedia 自身抛错也不炸', () => {
  const root = makeRoot();
  const original = globalThis.matchMedia;
  try {
    globalThis.matchMedia = () => {
      throw new Error('NotSupportedError');
    };
    const theme = createThemeController({ storage: makeStorage(), root });
    assert.equal(theme.load(), 'light');
    assert.equal(typeof theme.watch(), 'function');
    assert.equal(theme.set('dark'), 'dark');
  } finally {
    if (original === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = original;
  }
});

await t('控制器 watch：只支持 addListener/removeListener 的老 WebView 也能订上并退订', () => {
  const root = makeRoot();
  const media = makeLegacyMedia(false);
  const theme = createThemeController({ storage: makeStorage(), root, media });

  theme.load();
  theme.watch();
  assert.equal(media.listenerCount(), 1);

  media.dispatch(true);
  assert.equal(root.dataset.theme, 'dark');

  theme.destroy();
  assert.equal(media.listenerCount(), 0);
});

await t('控制器 watch：重复调用不会重复订阅（面板反复开关也不漏监听）', () => {
  const root = makeRoot();
  const media = makeMedia(false);
  const theme = createThemeController({ storage: makeStorage(), root, media });

  theme.load();
  const off1 = theme.watch();
  const off2 = theme.watch();
  const off3 = theme.watch();

  assert.equal(media.listenerCount(), 1, '三次 watch 只能有一个监听');
  assert.equal(off1, off2, '重复调用应拿回同一个退订函数');
  assert.equal(off2, off3);

  // 退订后可以重新 watch（例如销毁重建）
  off1();
  assert.equal(media.listenerCount(), 0);
  theme.watch();
  assert.equal(media.listenerCount(), 1);
});

/* ------------------------------------------------------------------ 控制器：destroy */

await t('控制器 destroy：退订后系统变化不再改 DOM，且可重复调用', () => {
  const root = makeRoot();
  const media = makeMedia(false);
  const theme = createThemeController({ storage: makeStorage(), root, media });

  theme.load();
  theme.set('auto');
  theme.watch();
  assert.equal(media.listenerCount(), 1);

  theme.destroy();
  assert.equal(media.listenerCount(), 0, 'destroy 必须把监听摘干净');

  const before = root.dataset.theme;
  media.dispatch(true);
  assert.equal(root.dataset.theme, before, 'destroy 之后系统怎么变都不该再动界面');

  // 重复 destroy 不抛；destroy 之后重新 watch 仍然可用
  assert.doesNotThrow(() => theme.destroy());
  assert.equal(typeof theme.watch(), 'function');
  assert.equal(media.listenerCount(), 1);
});

await t('控制器 destroy：不把根节点刷回浅色（外观是全局的，不是这个组件的私有状态）', () => {
  const root = makeRoot();
  const media = makeMedia(false);
  const theme = createThemeController({ storage: makeStorage(), root, media });

  theme.load();
  theme.set('dark');
  theme.watch();

  theme.destroy();
  assert.equal(root.dataset.theme, 'dark', 'destroy 后应保持用户选的外观');
});

/* ------------------------------------------------------------------ 控制器：根节点缺省 */

await t('控制器：不注入 root 时用 document.documentElement，注入优先', () => {
  const fakeHtml = makeRoot();
  const originalDoc = globalThis.document;
  try {
    globalThis.document = { documentElement: fakeHtml };
    const theme = createThemeController({ storage: makeStorage(), media: makeMedia(false) });
    theme.load();
    assert.equal(fakeHtml.dataset.theme, 'light');
    theme.set('dark');
    assert.equal(fakeHtml.dataset.theme, 'dark');
  } finally {
    if (originalDoc === undefined) delete globalThis.document;
    else globalThis.document = originalDoc;
  }

  // 注入的 root 优先级最高：环境里有 document 也写注入的那个
  const injected = makeRoot();
  const theme2 = createThemeController({ storage: makeStorage(), root: injected, media: makeMedia(false) });
  theme2.set('dark');
  assert.equal(injected.dataset.theme, 'dark');
  if (globalThis.document && globalThis.document.documentElement !== injected) {
    assert.notEqual(globalThis.document.documentElement.dataset.theme, 'dark');
  }
});

/* ------------------------------------------------------------------ 端到端回放 */

await t('端到端：auto → 系统深 → 选浅色 → 选深色 → 回到 auto，每一步都落在 DOM 上', () => {
  const root = makeRoot();
  const media = makeMedia(false);
  const storage = makeStorage();
  const seen = [];
  const theme = createThemeController({
    storage,
    root,
    media,
    onChange: ({ mode, resolved }) => seen.push(`${mode}>${resolved}`),
  });

  theme.load(); // 没存过 → auto + 浅色
  theme.watch();
  assert.equal(root.dataset.theme, 'light');

  media.dispatch(true); // 系统切深色 → 跟随
  assert.equal(root.dataset.theme, 'dark');

  theme.set('light'); // 用户显式选浅色
  assert.equal(root.dataset.theme, 'light');
  media.dispatch(false);
  media.dispatch(true); // 系统来回切都不动
  assert.equal(root.dataset.theme, 'light');

  theme.set('dark');
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(storage.map.get(STORAGE_KEY_THEME), 'dark');

  theme.set('auto'); // 回到跟随系统，此刻系统是深色
  assert.equal(root.dataset.theme, 'dark');

  theme.destroy();
  assert.deepEqual(seen, ['auto>light', 'auto>dark', 'light>light', 'dark>dark', 'auto>dark']);
});

/* ------------------------------------------------------------------ 设置面板里的外观分区
 * 外观三档要真的能被点到，回调要真的发出来；这里用仓库共用的假 DOM 夹具（tests/support/app_harness.mjs）
 * 直接跑 createSettingsView，不碰真浏览器。
 */

function makeSettingsView(overrides = {}) {
  const h = createHarness();
  const container = h.doc.createElement('div');
  h.doc.body.appendChild(container);
  const seen = [];
  const view = createSettingsView({
    container,
    document: h.doc,
    onSelectTheme: (mode) => seen.push(mode),
    ...overrides,
  });
  // 外观分区是「始终渲染」的，但它只在 render() 之后才建出来（与其它分区一致）。
  // 默认先画一帧空列表的 loaded 态，用例再想换状态就自己重渲。
  view.render({ status: 'loaded', models: [], fontSize: '15px' });
  return { h, container, view, seen };
}

/** 面板每次重渲都会重建 DOM，所以要重新查一遍按钮。 */
function themeButtons(container) {
  return Array.from(container.querySelectorAll('.settings-theme-btn'));
}

await t('设置面板：外观分区有三个档，默认高亮「跟随系统」', () => {
  const { container } = makeSettingsView();
  const btns = themeButtons(container);

  assert.equal(btns.length, 3, '必须刚好三档');
  assert.deepEqual(btns.map((b) => b.textContent), ['跟随系统', '浅色', '深色']);
  assert.deepEqual(btns.map((b) => b.getAttribute('data-theme-mode')), ['auto', 'light', 'dark']);
  assert.equal(btns[0].classList.contains('active'), true, '默认档位是跟随系统');
  assert.equal(btns[0].getAttribute('aria-pressed'), 'true');
  assert.equal(btns[1].classList.contains('active'), false);
  assert.equal(btns[2].classList.contains('active'), false);
});

await t('设置面板：themeMode 指向深色时选中态落在深色；未知值落回跟随系统', () => {
  const dark = makeSettingsView({ themeMode: 'dark' });
  let btns = themeButtons(dark.container);
  assert.equal(btns[2].classList.contains('active'), true);
  assert.equal(btns[0].classList.contains('active'), false);

  // 'system' 是界面不认识的档位（旧版/拼错）——不能假装它是任何一项，只能落 auto
  const unknown = makeSettingsView({ themeMode: 'system' });
  btns = themeButtons(unknown.container);
  assert.equal(btns[0].classList.contains('active'), true);
  assert.equal(btns[1].classList.contains('active'), false);
  assert.equal(btns[2].classList.contains('active'), false);
});

await t('设置面板：点深色 → 回调收到 dark，选中态立刻迁移（不重渲整个面板）', () => {
  const { container, seen } = makeSettingsView();
  const before = themeButtons(container);

  before[2].click();

  assert.deepEqual(seen, ['dark']);
  const after = themeButtons(container);
  // 「不重渲整个面板」：三个按钮必须是原来那三个节点——重渲会换掉它们并丢掉滚动位置，
  // 只断言 active 类的话，实现改成整块重建也照样过。
  assert.equal(after.length, before.length, '外观按钮数量不该变');
  for (let i = 0; i < before.length; i += 1) {
    assert.equal(after[i], before[i], `第 ${i} 个外观按钮被重建了：选中态迁移不该重渲面板`);
  }
  assert.equal(after[2].classList.contains('active'), true);
  assert.equal(after[0].classList.contains('active'), false);
  assert.equal(after[2].getAttribute('aria-pressed'), 'true');
  assert.equal(after[0].getAttribute('aria-pressed'), 'false');

  // 再点浅色：回调继续往外来，选中态再迁一次
  after[1].click();
  assert.deepEqual(seen, ['dark', 'light']);
  assert.equal(themeButtons(container)[1].classList.contains('active'), true);

  // 重复点同一档不再发意图（避免无意义的写存储 + 通知）
  themeButtons(container)[1].click();
  assert.deepEqual(seen, ['dark', 'light']);
});

await t('设置面板：加载态与失败态照样有外观三档，模型拉失败也能改配色', () => {
  const loading = makeSettingsView();
  loading.view.render({ status: 'loading', models: [], fontSize: '15px' });
  let btns = themeButtons(loading.container);
  assert.equal(btns.length, 3, '加载中时外观分区必须已经在');
  btns[2].click();
  assert.deepEqual(loading.seen, ['dark']);

  const errored = makeSettingsView();
  errored.view.render({ status: 'error', error: '拉取模型失败', models: [], fontSize: '15px' });
  btns = themeButtons(errored.container);
  assert.equal(btns.length, 3, '失败态更不该把配色开关一起藏走');
  btns[1].click();
  assert.deepEqual(errored.seen, ['light']);
});

await t('设置面板：render state 带来 themeMode 时以它为准', () => {
  const { container, view } = makeSettingsView();
  view.render({ status: 'loaded', models: [], themeMode: 'dark', fontSize: '15px' });
  assert.equal(themeButtons(container)[2].classList.contains('active'), true);

  // 再渲一次换回 auto：选中态跟着走，不会停在旧值上
  view.render({ status: 'loaded', models: [], themeMode: 'auto', fontSize: '15px' });
  assert.equal(themeButtons(container)[0].classList.contains('active'), true);

  // 不带 themeMode 的重渲不能把刚才的结果抹掉
  view.render({ status: 'loaded', models: [], fontSize: '15px' });
  assert.equal(themeButtons(container)[0].classList.contains('active'), true);
});

/* ------------------------------------------------------------------ 首帧与状态栏
 * 下面两条盯的是装配层：web/index.html 的头部内联脚本、web/app.js 的 theme.onChange。
 * 它们是「theme.js 本身全对、用户开屏还是闪一下浅色 / 状态栏不跟」的唯一关口，
 * 但都不在 theme.js 里，所以只能从源码与假 document 两侧钉。
 */

await t('首帧定色：index.html 的内联脚本在第一个样式表之前写死 data-theme', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

  const firstStyleAt = html.search(/<link[^>]+rel=["']stylesheet["']/i);
  assert.ok(firstStyleAt > 0, 'index.html 至少要有一个 <link rel="stylesheet">');
  // app.js 是 type="module"（defer），等它读偏好已经画过一帧了，救不了首帧
  const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(inline.length, 1, '首帧定色只能有一段内联脚本（两段会互相覆盖）');

  const boot = inline[0];
  assert.ok(boot.index < firstStyleAt,
    `内联脚本必须排在第一个样式表之前（脚本 ${boot.index} / 样式表 ${firstStyleAt}）`);
  assert.ok(boot.index < html.indexOf('</head>'), '内联脚本要留在 <head> 里，别拖到 body 末尾');

  const body = boot[1];
  assert.ok(body.includes(STORAGE_KEY_THEME), `首帧脚本必须读同一个偏好键 ${STORAGE_KEY_THEME}`);
  assert.match(body, /documentElement\.dataset\.theme/, '首帧脚本要自己把 data-theme 写上，否则第一帧还是默认浅色');
  assert.ok(body.includes(DARK_MEDIA_QUERY),
    'auto 档要按系统深浅定首帧色，查询串必须与 theme.js 的 DARK_MEDIA_QUERY 一致');
  assert.ok(body.includes(`'${THEME_META_COLORS.dark}'`) && body.includes(`'${THEME_META_COLORS.light}'`),
    '两个状态栏色值不能和 THEME_META_COLORS 走偏');
  assert.match(body, /try\s*\{/, '隐私模式下连读 localStorage 属性都可能抛，必须裹在 try 里');
});

await t('meta theme-color：resolved 映射到状态栏色值，且 app.js 的接线没走偏', () => {
  // 行为层：映射表只认 light / dark，未知 resolved（脏值）必须落浅色，不能写个 undefined 进去
  assert.deepEqual({ ...THEME_META_COLORS }, { light: '#F8F4ED', dark: '#171310' });

  // 装配层：唯一写 meta 的那句在 web/app.js 的 theme onChange 里。测试不 import app.js
  // （它会建 API / WS / 整页 DOM），所以这里分两层：
  //   1) 静态读源码，确认那句没被改写、也没有人把色值写死进去（真正的风险由这层兜住）；
  //   2) 用同一句在假 document 上跑一遍，钉住取色与兜底（第二层是 1) 的镜像，
  //      它不是 app.js 的端到端覆盖）。
  const appJs = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(appJs, /document\.getElementById\('metaThemeColor'\)/,
    'app.js 必须按 id 找到 index.html 里的那个 meta');
  assert.match(appJs, /meta\.setAttribute\('content', THEME_META_COLORS\[resolved\] \|\| THEME_META_COLORS\.light\)/,
    'meta 的内容必须来自 THEME_META_COLORS，且未知 resolved 落浅色');

  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(
    html,
    /<meta[^>]+name=["']theme-color["'][^>]*id=["']metaThemeColor["']|<meta[^>]+id=["']metaThemeColor["'][^>]*name=["']theme-color["']/,
    'index.html 的 meta 必须同时有 name=theme-color 与 id=metaThemeColor，否则上面那句取不到节点',
  );

  const applyMetaColor = (doc, resolved) => {   // 与 app.js 同一句，逐字对齐
    const meta = doc.getElementById('metaThemeColor');
    if (meta) meta.setAttribute('content', THEME_META_COLORS[resolved] || THEME_META_COLORS.light);
  };
  const meta = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const fakeDoc = { getElementById: (id) => (id === 'metaThemeColor' ? meta : null) };

  applyMetaColor(fakeDoc, 'dark');
  assert.equal(meta.attrs.content, '#171310', '深色时状态栏要压深');
  applyMetaColor(fakeDoc, 'light');
  assert.equal(meta.attrs.content, '#F8F4ED', '浅色时状态栏回到暖白');
  applyMetaColor(fakeDoc, 'warm-paper');
  assert.equal(meta.attrs.content, '#F8F4ED', '界面认不出的 resolved 落浅色，不写 undefined');
  assert.doesNotThrow(() => applyMetaColor({ getElementById: () => null }, 'dark'),
    '页面里没有那个 meta 时不能抛');
});

await t('控制器：没有注入 storage、连 localStorage 都抛时退内存，行为不变', () => {
  const root = makeRoot();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    // 隐私模式 / 沙箱：读 globalThis.localStorage 属性本身就会抛（不是返回值，是取属性）
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError: localStorage is not available'); },
    });
    const theme = createThemeController({ root, media: makeMedia(false) });
    assert.equal(theme.load(), 'light', '存储整个不可用也要能按默认档落地，不清首屏');
    assert.equal(theme.set('dark'), 'dark');
    assert.equal(root.dataset.theme, 'dark');
    assert.equal(theme.current(), 'dark', '内存兜底也要记住本次会话的选择');
    assert.equal(theme.resolved(), 'dark');
    assert.equal(theme.set('auto'), 'light', '退内存后档位归一/解析与正常路径一致');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  }
});

/* ------------------------------------------------------------------ 汇总 */

if (bad > 0) {
  console.log(`\n${bad} 个用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
