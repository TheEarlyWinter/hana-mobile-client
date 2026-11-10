/* web/card-controller.js
 *
 * 卡片生命周期与宿主桥接控制器。
 * 负责解析 show_card receipt、管理 Package 目录与 Fragment 源码卡片的加载、
 * 异步 HEAD 校验同源 redirect 与版本注入、哈希计算、会话身份匹配及清除隔离。
 */

import {
  renderCard,
  renderCardByPath,
  extractCardHtml,
  extractCardTitle,
  cardUrlFor,
  placeholderCard,
} from './card.js';
import { resolvePackageReference } from './card-package-reference.js';

function normalizePath(p) {
  if (typeof p !== 'string') return '';
  return p.trim().replace(/\\/g, '/').toLowerCase();
}

function pathEquals(a, b) {
  if (!a || !b) return true;
  return normalizePath(a) === normalizePath(b);
}

/**
 * 创建卡片控制器。
 *
 * @param {object} [options]
 * @param {Document} [options.document] - 宿主 DOM Document 对象
 * @param {object} [options.bridge] - CardBridge 实例
 * @param {Function} [options.fetchImpl] - fetch 实现（默认读取 globalThis.fetch）
 * @param {Function} [options.getSession] - 获取当前会话上下文函数
 * @param {object} [options.crypto] - Web Crypto 接口实例（默认读取 globalThis.crypto）
 */
export function createCardController({
  document: doc = globalThis.document,
  bridge,
  fetchImpl = globalThis.fetch,
  getSession,
  crypto = globalThis.crypto,
  renderCardByPath: renderCardByPathImpl = renderCardByPath,
  renderCard: renderCardImpl = renderCard,
  headTimeoutMs = 10000,
} = {}) {
  let currentGeneration = 0;
  const pendingAbortControllers = new Set();
  const activeDisposers = new Set();

  /**
   * 同步返回卡片占位容器，并在内部完成异步安全准备与加载。
   *
   * @param {object} ev - 事件对象或 receipt
   * @param {object} sessionSnapshot - 当前不可变会话快照 { sessionId, sessionPath, agentId }
   * @param {object} [options]
   * @param {object[]} [options.sessionFiles=[]] - GET /api/sessions/messages 返回的官方 sessionFiles 目录元数据
   * @returns {HTMLElement} wrapper 容器
   */
  function render(ev, sessionSnapshot, { sessionFiles = [] } = {}) {
    const generation = currentGeneration;
    const wrapper = doc.createElement('div');
    wrapper.className = 'card-controller-wrapper';

    const snapshot = Object.freeze({
      sessionId: sessionSnapshot?.sessionId || null,
      sessionPath: sessionSnapshot?.sessionPath || null,
      agentId: sessionSnapshot?.agentId || null,
    });

    const details = ev?.details || ev?.toolResult?.details || ev || {};
    const receipt = details.receipt || details;
    let sessionFile = receipt.sessionFile || ev?.sessionFile;

    const cardTitle = extractCardTitle(ev) || '卡片';

    const rawCode =
      typeof receipt.code === 'string' && receipt.code.trim()
        ? receipt.code
        : typeof ev?.code === 'string' && ev.code.trim()
        ? ev.code
        : extractCardHtml(ev);

    // 每个事件都交给 resolver 判定：非目标事件由它 ignore；
    // interactive_card 同时带 inline 源与 packageRef 时会被明确拒绝，不能跳过声明核验。
    const packageResolution = resolvePackageReference({
      event: ev,
      receipt,
      snapshot,
      sessionFiles,
      inlineCode: rawCode,
    });

    if (packageResolution.status === 'rejected') {
      wrapper.appendChild(
        placeholderCard(cardTitle, {
          error: packageResolution.message,
          reason: packageResolution.reason,
        })
      );
      return wrapper;
    }
    if (packageResolution.status === 'resolved') {
      sessionFile = packageResolution.sessionFile;
    }

    // 关键契约：只取明确的 cardId，绝不用 tool call id (ev.id) 替代；且 snapshot.sessionId 必须有效
    const cardId =
      typeof receipt.cardId === 'string' && receipt.cardId.trim()
        ? receipt.cardId.trim()
        : typeof ev?.cardId === 'string' && ev.cardId.trim()
        ? ev.cardId.trim()
        : null;

    const cardEntityId = cardId ? `chat-card:${cardId}` : null;

    let canBridge = Boolean(cardId && snapshot.sessionId);

    // 对 receipt 和 sessionFile 的每一个显式声明进行核验：
    // 1) 声明与 snapshot 不匹配（或 snapshot 缺失）直接拒桥
    // 2) 多个声明之间存在冲突直接拒桥，绝不用 truthy 降级掩盖
    const declaredSessionIds = [
      receipt.sessionId,
      receipt.sessionFile?.sessionId,
      sessionFile?.sessionId,
    ].filter(s => typeof s === 'string' && s.trim());

    for (const sid of declaredSessionIds) {
      if (!snapshot.sessionId || sid !== snapshot.sessionId) {
        canBridge = false;
      }
    }
    if (declaredSessionIds.length > 1) {
      const firstId = declaredSessionIds[0];
      for (let i = 1; i < declaredSessionIds.length; i++) {
        if (declaredSessionIds[i] !== firstId) canBridge = false;
      }
    }

    const declaredSessionPaths = [
      receipt.sessionPath,
      receipt.sessionFile?.sessionPath,
      sessionFile?.sessionPath,
    ].filter(p => typeof p === 'string' && p.trim());

    for (const spath of declaredSessionPaths) {
      if (!snapshot.sessionPath || !pathEquals(spath, snapshot.sessionPath)) {
        canBridge = false;
      }
    }
    if (declaredSessionPaths.length > 1) {
      const firstP = declaredSessionPaths[0];
      for (let i = 1; i < declaredSessionPaths.length; i++) {
        if (!pathEquals(declaredSessionPaths[i], firstP)) canBridge = false;
      }
    }

    function isCurrentSessionActive() {
      if (typeof getSession !== 'function') return true;
      const current = getSession();
      if (!current) return false;
      const curId = current.sessionId || null;
      const curPath = current.path || current.sessionPath || null;
      if (curId !== snapshot.sessionId) return false;
      if (Boolean(curPath) !== Boolean(snapshot.sessionPath)) return false;
      if (curPath && !pathEquals(curPath, snapshot.sessionPath)) return false;
      return true;
    }

    // 判断 Package（目录）模式 vs Fragment（源码）模式
    const isExplicitDir = Boolean(
      sessionFile?.isDirectory === true ||
      sessionFile?.kind === 'directory' ||
      receipt.cardDir ||
      ev?.cardDir
    );

    // 严格防御：只有明确为目录时才提取目录路径，绝不把普通 sessionFile.filePath 当目录
    const dirPath = packageResolution.status === 'resolved'
      ? packageResolution.dirPath
      : isExplicitDir
      ? String(receipt.cardDir || ev?.cardDir || sessionFile?.realPath || sessionFile?.filePath || sessionFile?.path || '').trim()
      : null;

    // 1. Package 目录模式处理
    if (dirPath) {
      (async () => {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        if (controller) pendingAbortControllers.add(controller);

        let timer = null;
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
            try { controller?.abort(); } catch {}
            reject(new Error(`HEAD 请求超时 (${headTimeoutMs}ms)`));
          }, headTimeoutMs);
        });

        try {
          const baseUrl = cardUrlFor(dirPath);
          if (!baseUrl) {
            wrapper.appendChild(placeholderCard(cardTitle, { error: '无效的卡片目录' }));
            return;
          }

          const fetchFn = fetchImpl || globalThis.fetch;
          const fetchPromise = (async () => {
            return fetchFn(baseUrl, {
              method: 'HEAD',
              signal: controller?.signal,
            });
          })();

          const res = await Promise.race([fetchPromise, timeoutPromise]);
          if (timer) { clearTimeout(timer); timer = null; }

          if (generation !== currentGeneration) return;
          if (!isCurrentSessionActive()) return;

          if (!res || !res.ok) {
            wrapper.appendChild(placeholderCard(cardTitle, { error: '卡片加载失败：HEAD 请求异常' }));
            return;
          }

          const finalUrl = res.url || baseUrl;
          // 校验最终 URL 必须同源且前缀严格匹配同一 encoded 目录
          const locOrigin = globalThis.location?.origin;
          let baseParsed;
          let finalParsed;
          try {
            baseParsed = new URL(baseUrl, locOrigin);
            finalParsed = new URL(finalUrl, locOrigin);
          } catch (err) {
            wrapper.appendChild(placeholderCard(cardTitle, { error: '卡片 URL 解析失败' }));
            return;
          }

          if (locOrigin && finalParsed.origin !== locOrigin) {
            wrapper.appendChild(placeholderCard(cardTitle, { error: '卡片跨源重定向被拒绝' }));
            return;
          }
          if (!finalParsed.pathname.startsWith(baseParsed.pathname)) {
            wrapper.appendChild(placeholderCard(cardTitle, { error: '卡片重定向目标非法：目录不匹配' }));
            return;
          }

          const rawVersion =
            res.headers?.get('x-hana-card-source-version') ||
            res.headers?.get('X-Hana-Card-Source-Version');
          const isValidVersion = typeof rawVersion === 'string' && /^sha256:[a-f0-9]{64}$/.test(rawVersion);

          const cardContext = Object.freeze({
            cardId,
            cardEntityId,
            sourceVersion: isValidVersion ? rawVersion : null,
            sessionId: snapshot.sessionId,
            sessionPath: snapshot.sessionPath,
            title: cardTitle,
          });

          if (generation !== currentGeneration) return;
          if (!isCurrentSessionActive()) return;

          const { node, iframe, dispose } = renderCardByPathImpl(dirPath, {
            title: cardTitle,
            sourceUrl: finalUrl,
            hostBridge: canBridge ? bridge : null,
            context: cardContext,
          });

          if (typeof dispose === 'function') activeDisposers.add(dispose);

          wrapper.appendChild(node);
        } catch (err) {
          if (generation !== currentGeneration) return;
          wrapper.appendChild(placeholderCard(cardTitle, { error: '卡片加载异常: ' + (err.message || String(err)) }));
        } finally {
          if (timer) clearTimeout(timer);
          if (controller) pendingAbortControllers.delete(controller);
        }
      })();
      return wrapper;
    }

    // 2. Fragment 源码模式处理
    if (rawCode) {
      (async () => {
        let sourceVersion = null;
        if (crypto && crypto.subtle && typeof crypto.subtle.digest === 'function') {
          try {
            const bytes = new TextEncoder().encode(rawCode);
            const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
            const hex = Array.from(new Uint8Array(hashBuf))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('');
            sourceVersion = `sha256:${hex}`;
          } catch {
            sourceVersion = null;
          }
        }

        if (generation !== currentGeneration) return;
        if (!isCurrentSessionActive()) return;

        const cardContext = Object.freeze({
          cardId,
          cardEntityId,
          sourceVersion,
          sessionId: snapshot.sessionId,
          sessionPath: snapshot.sessionPath,
          title: cardTitle,
        });

        const { node, iframe, dispose } = renderCardImpl(rawCode, {
          title: cardTitle,
          hostBridge: canBridge ? bridge : null,
          context: cardContext,
        });

        if (typeof dispose === 'function') activeDisposers.add(dispose);

        wrapper.appendChild(node);
      })();
      return wrapper;
    }

    // 3. 既无有效目录也无源码：占位展示
    wrapper.appendChild(placeholderCard(cardTitle, ev));
    return wrapper;
  }

  /**
   * 清除当前所有已渲染卡片与在途准备任务。
   */
  function clear() {
    currentGeneration += 1;
    for (const controller of pendingAbortControllers) {
      try {
        controller.abort();
      } catch {}
    }
    pendingAbortControllers.clear();

    for (const dispose of activeDisposers) {
      try {
        dispose();
      } catch {}
    }
    activeDisposers.clear();

    if (bridge && typeof bridge.clear === 'function') {
      bridge.clear();
    }
  }

  return {
    render,
    clear,
  };
}
