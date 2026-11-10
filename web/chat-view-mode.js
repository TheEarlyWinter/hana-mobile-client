/* web/chat-view-mode.js
 *
 * 聊天视图模式（沉静 serene / 经典 classic）的读取与持久化。
 *
 * 管什么：
 * 1. 记住「当前是哪种视图」，给界面一个同步可读的 current()。
 * 2. load()：从宿主 /api/preferences/chat-ui 读 chat_ui.viewMode，失败则回退本地缓存，
 *    都没有就保持默认；结果变化时回调 onChange。
 * 3. set()：本地切换。先乐观改内存与界面，再 PUT 到宿主；失败回滚并再通知一次，
 *    全程不抛错，返回值只表示「最终是否生效」。
 * 4. 本地缓存键 hana.chatViewMode，仅作服务端不可达时的兜底。
 *
 * 不管什么：
 * 1. 不碰 DOM、不查 class、不改样式、不管入场动画——模式怎么呈现由界面层决定。
 * 2. 不 import 任何其它模块，不读 window.S 之类的全局状态。
 * 3. 不校验权限、不判断该不该有这条偏好（那是宿主设置项的事）。
 *
 * 两个容易踩的点：
 *   - 手机浏览器隐私模式下 localStorage 连「读属性」都可能抛，所以所有 access 都 try/catch，
 *     拿不到就当没有，绝不让存储问题炸掉首屏。
 *   - 首屏 load 与用户点击可能撞车：load 回来的是上一次的服务端值，直接写会把用户刚点的
 *     结果盖掉。这里用一个单调递增的代号，过期的响应一律丢弃。
 */

export const VIEW_MODES = Object.freeze(['serene', 'classic']);
export const DEFAULT_VIEW_MODE = 'serene';

const STORAGE_KEY = 'hana.chatViewMode';
const CHAT_UI_ENDPOINT = '/api/preferences/chat-ui';

/**
 * 归一化视图模式：只认精确的小写 classic，其余（含 undefined / null / 大小写写错 /
 * 宿主以后新增的模式）一律落回默认 serene——宁可沉静，也不要一个界面不认识的模式。
 *
 * @param {unknown} value
 * @returns {'serene' | 'classic'}
 */
export function normalizeViewMode(value) {
  return value === 'classic' ? 'classic' : DEFAULT_VIEW_MODE;
}

/** 内存版 storage：localStorage 不可用时的兜底，保证本次会话内行为一致。 */
function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

/** 不传 storage 时用 globalThis.localStorage；取不到（或被沙箱挡住）就退内存。 */
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

/** 读本地缓存：任何异常与非字符串都当「没有」，不向上传。 */
function safeGetItem(storage, key) {
  try {
    const value = storage.getItem(key);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** 写本地缓存：纯尽力而为，写不进去不影响已经生效的模式。 */
function safeSetItem(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    // 配额满 / 隐私模式：本地缓存只是兜底，丢了就丢了
  }
}

/**
 * @param {object} [options]
 * @param {(path: string, init?: object) => Promise<any>} [options.api] 宿主的同源请求函数
 * @param {{ getItem: (k: string) => any, setItem: (k: string, v: string) => void }} [options.storage]
 * @param {(mode: 'serene' | 'classic') => void} [options.onChange] 模式变化回调
 * @returns {{ current: () => 'serene' | 'classic', load: () => Promise<'serene' | 'classic'>, set: (mode: unknown) => Promise<boolean> }}
 */
export function createChatViewMode({ api, storage, onChange = () => {} } = {}) {
  const store = resolveStorage(storage);
  const request = typeof api === 'function' ? api : null;
  const notify = typeof onChange === 'function' ? onChange : () => {};

  // 未加载过时的样子就是默认沉静，界面首屏不用等网络。
  // 注解不能省：DEFAULT_VIEW_MODE 是字面量 'serene'，let 会把初值拓宽成 string，
  // 于是下面两处 notify(mode) 对不上「只收 'serene' | 'classic'」的回调类型。
  /** @type {'serene' | 'classic'} */
  let mode = DEFAULT_VIEW_MODE;
  // 每次 load / set 都 +1；响应回来时代号不是最新就说明有更晚的动作，丢弃这次结果。
  let seq = 0;

  function current() {
    return mode;
  }

  /** 更新模式并通知；回调是调用方的代码，它抛错不能反噬主流程。 */
  function apply(next) {
    if (next === mode) return;
    mode = next;
    try {
      notify(mode);
    } catch {
      // 界面渲染失败不该让偏好读写失败
    }
  }

  /** 本地兜底：拿不到或值不认识都算「没有」，交给调用方决定是否保持默认。 */
  function readStored() {
    const raw = safeGetItem(store, STORAGE_KEY);
    return raw === null ? null : normalizeViewMode(raw);
  }

  async function load() {
    const token = ++seq;
    let next = null;

    if (request) {
      try {
        // GET：不带 method，body 形如 { chatUi: { viewMode, taskChipOverrides } }
        const body = await request(CHAT_UI_ENDPOINT);
        const chatUi = body && typeof body === 'object' ? body.chatUi : null;
        const raw = chatUi && typeof chatUi === 'object' ? chatUi.viewMode : undefined;
        // 只有拿到非空字符串才算读到了；形状不对继续走下面的本地兜底。
        if (typeof raw === 'string' && raw) next = normalizeViewMode(raw);
      } catch {
        // 网络/HTTP 失败都按「这次没拿到」处理，load 永不抛错
      }
    }

    if (next === null) next = readStored();
    // 两条来源都没有：保持当前模式。首次加载时当前就是默认 serene，
    // 已经 set 过的会话也不会因为一次失败的 load 被打回默认。
    if (next === null) return mode;
    // 期间有更晚的 load / set：这次结果已经过期，直接交回当前状态。
    if (token !== seq) return mode;

    apply(next);
    return mode;
  }

  async function set(next) {
    const target = normalizeViewMode(next);
    // 已经在这个模式：不发请求、不回调，直接算成功（幂等）。
    if (target === mode) return true;

    const previous = mode;
    const token = ++seq;

    // 乐观更新：界面先切过去，网络失败再退回来，避免按钮点下去半天没反应。
    mode = target;
    try {
      notify(mode);
    } catch {
      // 同上，界面回调的错误不影响偏好写入
    }

    // 没有 api 的降级场景：本地就是最终状态。
    if (!request) {
      safeSetItem(store, STORAGE_KEY, target);
      return true;
    }

    try {
      await request(CHAT_UI_ENDPOINT, {
        method: 'PUT',
        body: JSON.stringify({ viewMode: target }),
      });
    } catch {
      // 服务端没接受：回滚到调用前。若期间已有更晚的 set，就别拿旧值盖新值。
      if (token === seq) apply(previous);
      return false;
    }

    // 确认落库后再写本地缓存，保证缓存里不会是服务端拒绝过的值。
    // 若期间已有更晚的 set，这次的成功已经过期，不能把本地缓存改回旧模式。
    if (token === seq) safeSetItem(store, STORAGE_KEY, target);
    return true;
  }

  return { current, load, set };
}
