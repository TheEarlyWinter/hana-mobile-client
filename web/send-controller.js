/* 独立发送协调：只持有单飞锁，不依赖 DOM 或 app 的整体状态对象。 */

import { buildPromptFrame, validateForSend } from './attach.js';

export function createSendController({
  readDraft,
  readSession,
  waitForReady,
  sendFrame,
  commitSent,
  report,
  onSendingChange,
  makeInputId,
}) {
  let sending = false;

  function isSending() {
    return sending;
  }

  async function send({ delivery = 'prompt', preparedDraft = null, isCurrent = null } = {}) {
    const prepared = preparedDraft !== null && preparedDraft !== undefined;
    const result = prepared ? { frameWritten: false, committed: false, inputId: null } : null;
    const failPrepared = (error) => {
      if (result && error instanceof Error) result.error = error;
      return result;
    };
    if (sending) {
      return prepared ? failPrepared(new Error('已有消息正在发送，请稍后重试')) : undefined;
    }

    const asError = (error) => (error instanceof Error ? error : new Error(String(error)));
    let draft;
    let rawText;
    let text;
    let attachments;
    let ready;
    let shown;
    let stillWorking;
    let session;
    let problem;
    try {
      draft = prepared ? preparedDraft || {} : (readDraft() || {});
      rawText = typeof draft.rawText === 'string' ? draft.rawText : '';
      // outgoingText 是「实际要发出去的内容」（比如带引用块）；rawText 是输入框里的原文。
      // 两者必须分开：清空输入框的判断要用 rawText，不能拿拼过引用的文本来比。
      const outgoingText = typeof draft.outgoingText === 'string' ? draft.outgoingText : rawText;
      text = outgoingText.trim();
      attachments = Array.isArray(draft.attachments) ? [...draft.attachments] : [];
      ready = attachments.filter((attachment) => attachment && attachment.base64);
      shown = ready.map((attachment) => ({
        src: attachment.previewUrl,
        name: attachment.name,
        mimeType: attachment.mimeType,
      }));
      stillWorking = attachments.some((attachment) => !attachment || !attachment.base64);
      session = readSession();
      const images = ready.map((attachment) => ({
        mimeType: attachment.mimeType,
        data: attachment.base64,
      }));
      problem = validateForSend(images);
    } catch (error) {
      if (prepared) return failPrepared(asError(error));
      throw error;
    }

    if (!session || (!text && ready.length === 0)) {
      return prepared ? failPrepared(new Error(!session ? '追问会话不可用' : '追问内容不能为空')) : undefined;
    }
    if (stillWorking) {
      try {
        report({ code: 'images-pending' });
      } catch (error) {
        if (prepared) return failPrepared(asError(error));
        throw error;
      }
      return prepared ? failPrepared(new Error('附件还在处理')) : undefined;
    }
    if (problem) {
      try {
        report({ code: 'invalid-images', message: problem });
      } catch (error) {
        if (prepared) return failPrepared(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      return prepared ? failPrepared(new Error(problem)) : undefined;
    }

    // Capture identity and scalar keys before any await. The same object can be mutated in place.
    let sessionPath;
    let sessionId;
    try {
      sessionPath = session.path;
      sessionId = session.sessionId;
    } catch (error) {
      if (prepared) return failPrepared(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }

    sending = true;
    let failed = false;
    try {
      onSendingChange(true);

      // 等的不是「连上」，是「连上之后还是这个会话」。切走要能立刻结束等待：
      // 单飞锁在下面的 finally 里，多等一轮就多锁 60ms，最坏锁满整个超时。
      // 同一个 session 对象也可能被原地改写 path/sessionId，所以三个身份项都要看。
      const sessionChanged = () => {
        const live = readSession();
        return live !== session || live?.path !== sessionPath || live?.sessionId !== sessionId;
      };
      // 第一个参数留空 = 用等待方默认的超时；第二个才是取消条件。
      // 不能用 ready / connected 这类名字：上面的 ready 是「已就绪的附件」。
      const becameReady = await waitForReady(undefined, sessionChanged);
      // 切会话 / 退出：这次发送已经不属于当前界面，静默收摊——不报 not-ready，
      // 那不是连接故障。取消等待也不能退化成继续发帧。
      if (sessionChanged()) return prepared ? result : undefined;
      if (!becameReady) {
        report({ code: 'not-ready' });
        return prepared ? failPrepared(new Error('连接还没就绪，消息没发出去')) : undefined;
      }

      // prepared 的归属闭包必须覆盖 WS 等待期内的切会话和“切走再回来”。
      // 检查紧贴写帧路径，不能因同一个 session 对象又回到当前而放行。
      if (prepared && typeof isCurrent === 'function' && !isCurrent()) return result;

      const inputId = makeInputId();
      if (result) result.inputId = inputId;
      const frame = buildPromptFrame({
        session: { path: sessionPath, sessionId },
        text,
        attachments: ready,
        inputId,
        // steer：本轮还在跑的时候把这段话“插”进去，而不是开新的一轮。
        type: delivery,
        ...(prepared && draft.feed ? {
          feedItemId: draft.feed.itemId,
          feedRevision: draft.feed.revision,
        } : {}),
      });
      if (!sendFrame(frame)) {
        report({ code: 'disconnected' });
        return prepared ? failPrepared(new Error('发送失败：连接已断开')) : undefined;
      }

      // sendFrame 成功就是对外不可逆边界；必须先记账，再进入任何本地结算。
      if (result) result.frameWritten = true;
      await commitSent({ rawText, text, attachments: ready, inputId, shown, delivery, prepared });
      if (result) result.committed = true;
    } catch (error) {
      if (prepared) {
        result.error = error instanceof Error ? error : new Error(String(error));
      } else {
        failed = true;
        throw error;
      }
    } finally {
      sending = false;
      try {
        onSendingChange(false);
      } catch (releaseError) {
        if (prepared) {
          if (!result.error) result.error = releaseError instanceof Error ? releaseError : new Error(String(releaseError));
        } else if (!failed) {
          throw releaseError;
        }
      }
    }
    return prepared ? result : undefined;
  }

  return { isSending, send };
}
