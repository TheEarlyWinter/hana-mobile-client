/* web/session-namespace-tabs.js
 *
 * 历史抽屉顶部的 Chat / Code 会话类型筛选按钮。
 *
 * 职责边界：
 *   - 点击只把 'home' | 'code' 回传给 onChange；
 *   - 当前选中态由父层（app/controller）通过 setNamespace(ns) 回写；
 *   - 模块自身不保存业务 namespace 状态，不拉取会话，不创建会话。
 *
 * aria 约定：容器用 role="group" + aria-label，两个原生 button 用 aria-pressed。
 * 不用 tab/tablist 角色，避免引入键盘协议与 aria-selected 的一致性问题。
 */

/**
 * @param {object} [options]
 * @param {Document} [options.document] - DOM 工厂，杜绝全局隐式读取
 * @param {(namespace: 'home'|'code') => void} [options.onChange] - 点击回传
 * @returns {{ setNamespace: (namespace: string) => void, dispose: () => void }}
 */
export function createSessionNamespaceTabs({ document: doc, onChange = () => {} } = {}) {
  if (!doc) {
    throw new Error('createSessionNamespaceTabs requires { document }');
  }

  // 老测试夹具没有 getElementById，缺节点时整体退化为 no-op。
  const byId = (id) => (typeof doc.getElementById === 'function' ? doc.getElementById(id) : null);
  // 不写注解时元素会被推成「string 与节点的联合」，下面 onChange(namespace) 就对不上
  // 只收 'home' | 'code' 的回调。
  /** @type {Array<['home' | 'code', Element | null]>} */
  const buttons = [
    ['home', byId('btnNamespaceHome')],
    ['code', byId('btnNamespaceCode')],
  ];

  function paint(btn, active) {
    if (!btn) return;
    if (btn.classList) {
      if (active) btn.classList.add('is-active');
      else btn.classList.remove('is-active');
    }
    if (typeof btn.setAttribute === 'function') {
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  // 只认 'code'，其余（含 undefined / 脏值）一律当 home，避免两个按钮都不亮。
  function setNamespace(namespace) {
    const active = namespace === 'code' ? 'code' : 'home';
    for (const [name, btn] of buttons) paint(btn, name === active);
  }

  const handlers = new Map();
  for (const [namespace, btn] of buttons) {
    if (!btn || typeof btn.addEventListener !== 'function') continue;
    const handler = () => onChange(namespace);
    btn.addEventListener('click', handler);
    handlers.set(btn, handler);
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [btn, handler] of handlers) {
      if (typeof btn.removeEventListener === 'function') btn.removeEventListener('click', handler);
    }
    handlers.clear();
  }

  return { setNamespace, dispose };
}
