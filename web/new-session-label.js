/* web/new-session-label.js
 *
 * 「新建对话」按钮的文案跟着当前命名空间走。
 *
 * 为什么单独成一个模块：
 *   宿主有 Chat 与 Code 两种会话模式，新建按钮是同一个。新建动作本身跟随命名空间
 *   （见 conversation-controller.newSession），文案如果写死在 index.html 里，就会出现
 *   「在 Code 标签下显示『新建 Chat 对话』」——真机上已经被反馈过一次。
 *
 * 不管什么：
 *   - 不判断该不该新建、也不发请求，只改文案；
 *   - 不 import 任何其它模块，不缓存元素引用（首屏可能还没挂载）。
 */

/**
 * @param {object} [options]
 * @param {Document} [options.document]
 * @param {string[]} [options.buttonIds] 需要同步文案的按钮 id
 * @param {Record<string, string>} [options.labels] 命名空间 → 显示词
 * @returns {{ setNamespace: (namespace: string) => void }}
 */
export function createNewSessionLabel({
  document: doc,
  buttonIds = ['btnNew', 'btnNewChat'],
  labels = { home: 'Chat', code: 'Code' },
} = {}) {
  if (!doc) throw new TypeError('createNewSessionLabel requires { document }');

  // 未知命名空间（含 undefined）一律按 home 处理：宁可显示 Chat，也不能出现「新建 undefined 对话」。
  function wordFor(namespace) {
    if (namespace && Object.prototype.hasOwnProperty.call(labels, namespace)) return labels[namespace];
    return labels.home;
  }

  function setNamespace(namespace) {
    const text = `新建 ${wordFor(namespace)} 对话`;
    for (const id of buttonIds) {
      const btn = typeof doc.getElementById === 'function' ? doc.getElementById(id) : null;
      if (!btn) continue;

      // 图标按钮只看 title / aria-label，带文字的那个还要改内部的 span。
      if (typeof btn.setAttribute === 'function') {
        btn.setAttribute('title', text);
        btn.setAttribute('aria-label', text);
      }
      const probe = typeof btn.querySelector === 'function' ? btn.querySelector('span') : null;
      if (probe) probe.textContent = text;
    }
  }

  return { setNamespace };
}
