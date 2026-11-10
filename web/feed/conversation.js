/* Prepared, card-scoped follow-up flow. It owns one retryable attempt, not chat UI state. */

function fail(error, inputId = null) {
  return {
    frameWritten: false,
    committed: false,
    inputId,
    error: error instanceof Error ? error : new Error(String(error || '日报追问失败')),
  };
}

function readCreatedSession(value, wantedAgentId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('新会话响应格式不正确');
  }
  const path = typeof value.path === 'string' ? value.path.trim() : '';
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
  if (!path || !sessionId) throw new Error('新会话响应缺少 path 或 sessionId');
  if (value.agentId != null && value.agentId !== wantedAgentId) {
    throw new Error('新会话没有归属到日报来源助手');
  }
  return {
    path,
    sessionId,
    title: '新对话',
    namespace: 'home',
    agentId: wantedAgentId,
    agentName: typeof value.agentName === 'string' && value.agentName.trim()
      ? value.agentName.trim()
      : wantedAgentId,
  };
}

/**
 * @param {object} [options]
 * @param {(path:string, init?:object)=>Promise<any>} [options.api]
 * @param {ReturnType<typeof import('./client.js').createFeedClient>} [options.client]
 * @param {()=>object|null} [options.getIdentity]
 * @param {()=>number} [options.getNavigationEpoch]
 * @param {()=>object|null} [options.getSession]
 * @param {(session:object)=>Promise<void>} [options.openSession]
 * @param {(input:{text:string,feed:object,isCurrent:()=>boolean})=>Promise<object>} [options.sendPrepared]
 * @param {()=>boolean} [options.isActive]
 */
export function createFeedConversation({
  api,
  client,
  getIdentity,
  getNavigationEpoch,
  getSession,
  openSession,
  sendPrepared,
  isActive = () => true,
} = {}) {
  if (typeof api !== 'function') throw new TypeError('createFeedConversation 需要 api');
  if (!client || typeof client.prepare !== 'function') throw new TypeError('createFeedConversation 需要 client.prepare');
  if (typeof getIdentity !== 'function' || typeof getNavigationEpoch !== 'function' || typeof getSession !== 'function') {
    throw new TypeError('createFeedConversation 需要身份与导航读取器');
  }
  if (typeof openSession !== 'function' || typeof sendPrepared !== 'function') {
    throw new TypeError('createFeedConversation 需要 openSession 与 sendPrepared');
  }

  let currentAttempt = null;
  let sequence = 0;

  function isBaseCurrent(attempt) {
    return currentAttempt === attempt
      && !attempt.invalid
      && getIdentity() === attempt.identity
      && isActive() !== false;
  }

  function isBeforeOpenCurrent(attempt) {
    return isBaseCurrent(attempt) && getNavigationEpoch() === attempt.startEpoch;
  }

  function isOpenedCurrent(attempt) {
    return isBaseCurrent(attempt)
      && attempt.opened
      && getNavigationEpoch() === attempt.openedEpoch
      && getSession() === attempt.openedSession;
  }

  function isCurrent(attempt) {
    return attempt.opened ? isOpenedCurrent(attempt) : isBeforeOpenCurrent(attempt);
  }

  function invalidate(attempt) {
    if (attempt) attempt.invalid = true;
    if (currentAttempt === attempt) currentAttempt = null;
  }

  function newAttempt(item, text, identity, startEpoch) {
    sequence += 1;
    return {
      sequence,
      item,
      text,
      identity,
      startEpoch,
      created: null,
      feed: null,
      prepared: false,
      opened: false,
      openSucceeded: false,
      openedEpoch: null,
      openedSession: null,
      sent: false,
      lastResult: null,
      promise: null,
      invalid: false,
    };
  }

  function canReuse(attempt, item, identity) {
    if (!attempt || attempt.invalid || attempt.identity !== identity) return false;
    if (attempt.item?.itemId !== item.itemId || attempt.item?.revision !== item.revision) return false;
    return attempt.opened ? isOpenedCurrent(attempt) : isBeforeOpenCurrent(attempt);
  }

  async function run(attempt) {
    try {
      const item = attempt.item;
      const agentId = typeof item?.source?.agentId === 'string' ? item.source.agentId.trim() : '';
      if (!agentId) return fail(new Error('无法确认日报来源助手，不能安全创建追问会话'));
      if (!isCurrent(attempt)) {
        invalidate(attempt);
        return fail(new Error('日报追问已失效，请重新打开日报后再试'));
      }

      if (!attempt.created) {
        const response = await api('/api/sessions/new', {
          method: 'POST',
          body: JSON.stringify({ agentId, namespace: 'home' }),
        });
        if (!isBeforeOpenCurrent(attempt)) {
          invalidate(attempt);
          return fail(new Error('创建会话期间导航已变化，追问已取消'));
        }
        // 创建响应只在这个外部边界验证一次；后续都沿这个冻结对象使用。
        attempt.created = readCreatedSession(response, agentId);
      }

      if (!attempt.prepared) {
        const frozen = await client.prepare(attempt.created.sessionId, item.itemId, item.revision);
        if (!isBeforeOpenCurrent(attempt)) {
          invalidate(attempt);
          return fail(new Error('准备日报上下文期间导航已变化，追问已取消'));
        }
        // client.prepare 已在唯一外部入口验证 itemId/revision；这里仅持有已验证快照。
        attempt.feed = {
          itemId: frozen.itemId,
          revision: frozen.revision,
          title: frozen.title,
        };
        attempt.prepared = true;
      }

      if (!attempt.opened || !attempt.openSucceeded) {
        const ownsBeforeOpen = attempt.opened
          ? isOpenedCurrent(attempt)
          : isBeforeOpenCurrent(attempt);
        if (!ownsBeforeOpen) {
          invalidate(attempt);
          return fail(new Error('打开会话前导航已变化，追问已取消'));
        }
        let opening;
        try {
          opening = openSession(attempt.created);
        } catch (error) {
          // 即使同步阶段抛错，也立刻采样是否已发生了本次自己的导航，供安全手动重试。
          const openedEpoch = getNavigationEpoch();
          const openedSession = getSession();
          if (openedEpoch !== (attempt.opened ? attempt.openedEpoch : attempt.startEpoch) && openedSession) {
            attempt.opened = true;
            attempt.openSucceeded = false;
            attempt.openedEpoch = openedEpoch;
            attempt.openedSession = openedSession;
          }
          throw error;
        }
        // openSession 会同步更新导航epoch与会话对象；必须在 await 前立即捕获二者。
        attempt.openedEpoch = getNavigationEpoch();
        attempt.openedSession = getSession();
        attempt.opened = true;
        attempt.openSucceeded = false;
        await opening;
        if (!isOpenedCurrent(attempt)) {
          invalidate(attempt);
          return fail(new Error('打开追问会话期间导航已变化，追问已取消'));
        }
        attempt.openSucceeded = true;
      } else if (!isOpenedCurrent(attempt)) {
        invalidate(attempt);
        return fail(new Error('追问会话已被切走，不能继续发送'));
      }

      if (attempt.sent) return attempt.lastResult || fail(new Error('这条追问已发送，请回会话查看'));
      // sender 的 SendResult 是内部契约（已在发送器边界归一），这里直接使用。
      const result = await sendPrepared({
        text: attempt.text,
        feed: attempt.feed,
        isCurrent: () => isOpenedCurrent(attempt),
      });

      // 写帧是不可重试边界：在检查任何后续归属/UI之前先记已发。
      if (result.frameWritten) {
        attempt.sent = true;
        attempt.lastResult = result;
        return result;
      }
      if (!isOpenedCurrent(attempt)) invalidate(attempt);
      return result;
    } catch (error) {
      if (!isCurrent(attempt)) invalidate(attempt);
      return fail(error);
    }
  }

  function ask({ item, text } = {}) {
    const question = typeof text === 'string' ? text : '';
    const identity = getIdentity();
    if (!identity || isActive() === false) return Promise.resolve(fail(new Error('登录状态已变化，不能发送日报追问')));

    let attempt = currentAttempt;
    if (!canReuse(attempt, item, identity)) {
      invalidate(attempt);
      attempt = newAttempt(item, question, identity, getNavigationEpoch());
      currentAttempt = attempt;
    } else if (attempt.promise) {
      return attempt.promise;
    } else if (!attempt.sent) {
      // 用户明确再次确认时可更新问题文字，但会话和冻结上下文仍属于同一尝试。
      attempt.text = question;
    }

    if (attempt.sent) return Promise.resolve(attempt.lastResult || fail(new Error('这条追问已发送，请回会话查看')));
    if (attempt.promise) return attempt.promise;

    const promise = run(attempt);
    attempt.promise = promise;
    promise.finally(() => {
      if (attempt.promise === promise) attempt.promise = null;
    });
    return promise;
  }

  function reset() {
    invalidate(currentAttempt);
    currentAttempt = null;
  }

  return { ask, reset };
}
