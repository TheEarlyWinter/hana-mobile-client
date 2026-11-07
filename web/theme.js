/* web/theme.js
 *
 * 外观（深色模式）的三档选择：跟随系统 / 浅色 / 深色。
 *
 * 管什么：
 * 1. 值归一化（normalizeTheme）：只认 auto / light / dark，其余一律当 auto。
 * 2. 解析实际生效主题（resolveTheme）：auto 时看系统深浅，显式选择时听用户的。
 * 3. 落地（applyTheme）：只写 root.dataset.theme，不碰 class、不碰 style、不碰别的属性。
 * 4. 装配（createThemeController）：读/写偏好、订系统主题变化、销毁时退订。
 *
 * 不管什么：
 * 1. 不 import 任何业务模块，也不认识 DOM 结构——root 和 media 都是注入的，
 *    所以单测里可以用假根（{ dataset: {} }）和一个假媒体查询对象跑完全部分支。
 * 2. 不读 window/document 的全局状态来「猜」主题；缺省值只作为兜底，且都在 try/catch 里取。
 * 3. 不写 localStorage 之外的持久化，不调宿主接口（外观是本机偏好，换设备不需要同步）。
 *
 * 两个容易踩的点：
 *   - 手机上隐私模式里连「读 localStorage 属性」都可能抛 SecurityError，所以取存储、
 *     读值、写值三层都各自 try/catch：存储坏了只影响「重开还在」这一条，不许炸首屏。
 *   - 系统深浅变化只在 auto 下生效。用户显式选了「浅色」，系统切到深色时界面必须不动，
 *     否则等于把用户的选择抢走了。
 */

/** 三档外观模式，顺序即设置面板的展示顺序 */
export const THEME_MODES = Object.freeze(['auto', 'light', 'dark']);

/** 没存过 / 存了坏值时的默认档：跟随系统 */
export const DEFAULT_THEME_MODE = 'auto';

/** 本地偏好键。与 hana-mobile:chat-font-size 同一命名风格，一眼看出是本机 UI 偏好 */
export const STORAGE_KEY_THEME = 'hana-mobile:theme';

/**
 * 系统深浅查询串。index.html 的 <meta name="theme-color"> 也按这两个色值走，
 * 免得 Android 状态栏和页面底色对不上。
 */
export const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** 与 warm-paper 的 --bg / dark.css 的 --bg 保持一致 */
export const THEME_META_COLORS = Object.freeze({
  light: '#F8F4ED',
  dark: '#171310',
});

/**
 * 归一化外观模式。
 * 只认三个精确的小写字面量：'auto' / 'light' / 'dark'。
 * 其它一切（null、undefined、拼错的大小写、老版本存的 'system'、非字符串）都落回 auto，
 * 宁可跟随系统，也不要一个界面认不出的状态。
 *
 * @param {unknown} value
 * @returns {'auto' | 'light' | 'dark'}
 */
export function normalizeTheme(value) {
  return value === 'light' || value === 'dark' || value === 'auto' ? value : DEFAULT_THEME_MODE;
}

/**
 * 解析「此刻实际该用哪一套色」。
 * 注意第二参只在 auto 下有话语权：显式 light / dark 时不看系统。
 *
 * @param {'auto' | 'light' | 'dark' | unknown} mode
 * @param {boolean} [prefersDark] 系统是否偏好深色（matchMedia 的 matches）
 * @returns {'light' | 'dark'}
 */
export function resolveTheme(mode, prefersDark) {
  const normalized = normalizeTheme(mode);
  if (normalized === 'dark') return 'dark';
  if (normalized === 'light') return 'light';
  return prefersDark === true ? 'dark' : 'light';
}

/**
 * 把生效主题写到根节点的 data-theme 上。
 * CSS 侧只需要 `:root[data-theme='dark']` 一组覆盖，所以这里是唯一写入口。
 *
 * root 可以是真 <html>，也可以是单测里的假根：
 *   1. 有 dataset 就直接写 dataset.theme（真 DOM 与假根都吃这条）；
 *   2. dataset 不可写时退回 setAttribute（保证「只读 dataset」的实现也不崩）；
 *   3. 两样都没有就安静返回——外观没落地也不该抛。
 *
 * @param {{ dataset?: object, setAttribute?: Function } | null | undefined} root
 * @param {'light' | 'dark' | unknown} resolved
 * @returns {'light' | 'dark'} 实际写入的值（非 'dark' 一律按 light）
 */
export function applyTheme(root, resolved) {
  const next = resolved === 'dark' ? 'dark' : 'light';
  if (!root || typeof root !== 'object') return next;

  try {
    if (root.dataset && typeof root.dataset === 'object') {
      root.dataset.theme = next;
      return next;
    }
  } catch {
    // 只读/冻结的 dataset：落到下面的 setAttribute
  }

  try {
    if (typeof root.setAttribute === 'function') {
      root.setAttribute('data-theme', next);
    }
  } catch {
    // 假根连 setAttribute 都没有：什么都不做
  }
  return next;
}

/** 内存版 storage：localStorage 不可用时的兜底，保证本次会话内行为一致。 */
function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

/** 没注入 storage 时用 globalThis.localStorage；取不到（或被沙箱挡住）就退内存。 */
function resolveStorage(storage) {
  if (storage && typeof storage.getItem === 'function') return storage;
  try {
    const ls = globalThis.localStorage;
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') return ls;
  } catch {
    // 隐私模式下读 globalThis.localStorage 属性本身就会抛 SecurityError
  }
  return createMemoryStorage();
}

/** 读偏好：任何异常与非字符串都当「没存过」，不向上传。 */
function safeGetItem(storage, key) {
  try {
    const value = storage.getItem(key);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** 写偏好：纯尽力而为，写不进去不影响已经生效的外观。 */
function safeSetItem(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    // 配额满 / 隐私模式：这次选择本次会话内仍然有效，只是重开后会丢
  }
}

/**
 * 外观控制器。一次装配管一个根节点（通常就是 <html>）。
 *
 * @param {object} [options]
 * @param {{ getItem: (k: string) => any, setItem: (k: string, v: string) => void }} [options.storage]
 * @param {{ dataset?: object, setAttribute?: Function } | null} [options.root] 根节点，缺省 documentElement
 * @param {{ matches?: boolean, addEventListener?: Function, removeEventListener?: Function,
 *           addListener?: Function, removeListener?: Function } | null} [options.media]
 *        系统深浅查询对象，缺省 window.matchMedia('(prefers-color-scheme: dark)')
 * @param {(payload: { mode: 'auto'|'light'|'dark', resolved: 'light'|'dark' }) => void} [options.onChange]
 *        生效主题或模式真的变了才回调（重复 set 同一个值不回调）
 */
export function createThemeController({
  storage: customStorage,
  root: customRoot = null,
  media: injectedMedia,
  onChange = () => {},
} = {}) {
  const store = resolveStorage(customStorage);

  // 模式是偏好，落库的那个值；resolved 只是它的派生结果，不单独存。
  let mode = DEFAULT_THEME_MODE;

  // 上一次通知出去的状态：用来判断「这次到底变没变」。
  // null 表示还没落下过，第一次 commit 一定通知一次，让调用方拿到初值。
  let lastMode = null;
  let lastResolved = null;

  // media 只在需要时解析一次：注入优先；没注入才去问 window.matchMedia。
  let mediaQuery = injectedMedia === undefined ? undefined : injectedMedia;
  let mediaProbed = injectedMedia !== undefined;

  // watch 的退订函数。null = 还没订；函数 = 已订（或已判定订不了）。
  let unsubscribe = null;

  function getRoot() {
    if (customRoot) return customRoot;
    try {
      return globalThis.document ? globalThis.document.documentElement : null;
    } catch {
      return null;
    }
  }

  function getMedia() {
    if (!mediaProbed) {
      mediaProbed = true;
      try {
        const matchMedia = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia : null;
        mediaQuery = matchMedia ? matchMedia.call(globalThis, DARK_MEDIA_QUERY) : null;
      } catch {
        // 某些 WebView 在页面早期调 matchMedia 会抛：当作没有系统偏好
        mediaQuery = null;
      }
    }
    return mediaQuery || null;
  }

  function prefersDark() {
    const media = getMedia();
    if (!media) return false;
    try {
      return media.matches === true;
    } catch {
      return false;
    }
  }

  function notify() {
    try {
      onChange({ mode, resolved: lastResolved });
    } catch (err) {
      // 回调是调用方的事，它炸了不能连累主题已经落地的事实
      try {
        console.warn('[theme] onChange 抛错', err);
      } catch {
        // 连 console 都没有：放弃
      }
    }
  }

  /**
   * 解析 → 落地 → 按需通知。
   * notify=false 用于「只是想重算一遍」的场合（例如根节点被换掉后重画）。
   */
  function commit({ notify: shouldNotify = true } = {}) {
    const resolved = resolveTheme(mode, prefersDark());
    applyTheme(getRoot(), resolved);

    const changed = resolved !== lastResolved || mode !== lastMode;
    lastMode = mode;
    lastResolved = resolved;
    if (shouldNotify && changed) notify();
    return resolved;
  }

  /**
   * 读偏好并应用（启动时调一次即可）。
   * 存储读不出来时保持 auto，不写回存储——不替用户「修」他那份偏好。
   */
  function load() {
    mode = normalizeTheme(safeGetItem(store, STORAGE_KEY_THEME));
    return commit({ notify: true });
  }

  /**
   * 用户显式选择。先落库再应用：落库失败也照常应用（本次会话内必须立刻见效），
   * 返回值是「此刻实际生效的那套色」。
   */
  function set(next) {
    mode = normalizeTheme(next);
    safeSetItem(store, STORAGE_KEY_THEME, mode);
    return commit({ notify: true });
  }

  /**
   * 订阅系统深浅变化。只在 auto 下响应；重复调不会重复订阅。
   * 返回退订函数（destroy 会自动调它，调用方也可以提前退订）。
   * 退订后再调 watch() 能重新订上：退订时会把自己从「已订」状态里摘干净。
   *
   * 「没订上」不留状态：media 缺 addEventListener/addListener，或挂监听本身抛错，
   * 都只返回一个空的退订函数，不写进 unsubscribe —— 否则一次失败会被记成「已订」，
   * 之后 media 补齐 API、或换了新 media，就再也没有机会订上。
   */
  function watch() {
    if (unsubscribe) return unsubscribe;

    const media = getMedia();
    // null = 这次真的没订上。只有拿到退订手段才允许写进 unsubscribe。
    let detach = null;

    if (media) {
      // 系统任何一次变化都走这里；是否真的动手由当时的 mode 决定
      const handler = () => {
        if (mode !== 'auto') return;
        commit({ notify: true });
      };

      if (typeof media.addEventListener === 'function') {
        try {
          media.addEventListener('change', handler);
          detach = () => {
            try {
              media.removeEventListener('change', handler);
            } catch {
              // 已经没了就算了
            }
          };
        } catch {
          detach = null;
        }
      } else if (typeof media.addListener === 'function') {
        // 老 WebView / 老 Safari 只有 addListener
        try {
          media.addListener(handler);
          detach = () => {
            try {
              media.removeListener(handler);
            } catch {
              // 同上
            }
          };
        } catch {
          detach = null;
        }
      }
    }

    const off = () => {
      try {
        if (detach) detach();
      } catch {
        // 退订自身抛错也要继续清状态
      }
      detach = null;
      // 只有「当前这一份」才能把自己摘掉：避免退旧订阅时误伤后来重新订的那份
      if (unsubscribe === off) unsubscribe = null;
    };

    // 订上了才记账；没订上就留 null，下次 watch() 会重新尝试
    if (detach) unsubscribe = off;
    return off;
  }

  /**
   * 退订并清掉本轮状态。
   * 故意不把根节点刷回浅色：外观是全局的，销毁一个视图不该顺手改用户的界面。
   * 也清掉「上一次通知出去的状态」：销毁后再 load() / set() 要能从零通知一次，
   * 否则 changed 恒为 false，重建出来的视图永远拿不到当前值。
   */
  function destroy() {
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // 退订本身抛错也要把引用清掉，避免下次 watch 静默复用坏订阅
      }
    }
    unsubscribe = null;
    lastMode = null;
    lastResolved = null;
  }

  return {
    /** 当前模式（偏好，可能是 auto） */
    current: () => mode,
    /** 当前实际生效的色（永远 light 或 dark），不写 DOM */
    resolved: () => resolveTheme(mode, prefersDark()),
    load,
    set,
    watch,
    destroy,
  };
}
