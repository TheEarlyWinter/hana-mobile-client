/* web/composer-controller.js — 输入区（聊天页 + 首页悬浮岛）
 *
 * 管四件事：发消息（含单飞锁与等待连接）、停止生成（含断线时排队补发）、
 * 附件托盘（两个入口共用一套上限/渲染/并发预留，各自持有一份数组）、
 * 文件上传（发送前把文档传成会话文件，拿到 fileId 再发）。
 *
 * 拆出来的理由：这四件事共用同一批 DOM 与同一份 sendController，边界天然清楚；
 * 而它们和「会话切换」「事件分派」没有关系，留在 app.js 里只是噪音。
 *
 * 两条硬约束写在这里，别在别处再实现一遍：
 *  - 上限必须原子预留：先把本批槽位同步 push 进托盘，再逐个 await 处理；
 *  - 断线时点停止只排队，不发 abort、也不在本地点「已停止」。
 *
 * 另一条（文档）：宿主 prompt 帧没有内联文档通道，文件必须先 POST /api/upload-blob
 * 换 fileId，再用 sessionFileRefs 引用。上传放在发送前做（不是选完就传）：
 * 首页当时还没有会话，上传接口要 sessionPath；而且传完又删掉是白费流量。
 */

import { el } from './dom.js';
import {
  MAX_IMAGES,
  MAX_FILES,
  FILE_READY_FLAG,
  isFileAttachment,
  resolveFileMime,
  fileSizeProblem,
  fileBadge,
  uploadSessionFile,
  prepareImage,
  formatBytes,
} from './attach.js';
import { createApiClient } from './http-client.js';
import { createSendController } from './send-controller.js';

/**
 * @param {object} options
 * @param {object} options.state 共享状态对象
 * @param {(id: string) => Element|null} options.getElement
 * @param {object} options.renderer chat-renderer 实例
 * @param {object} options.sockets websocket-client 实例
 * @param {object} options.streamState 流式游标
 * @param {(msg: string) => void} options.flash
 * @param {(ms?: number) => Promise<boolean>} options.waitForReady 等连接就绪
 * @param {(el: Element) => void} options.autoGrow 输入框自适应高度
 * @param {(pathname: string, init?: object) => Promise<any>} [options.api] 上传用的 JSON 客户端；默认自建一份
 * @param {() => any} [options.captureQuote] 发送发起时取引用版本（与正文快照同一 tick）
 * @param {(token: any) => void} [options.consumeQuote] 发送成功后按版本消费引用
 */
export function createComposer({
  state,
  getElement,
  renderer,
  sockets,
  streamState,
  flash,
  waitForReady,
  autoGrow,
  api = null,
  onDraftCleared = () => {},
  // 发送前最后一次改写正文（引用回复就挂在这里）。**只影响发出去的内容**，
  // 输入框里用户看到什么、草稿存的什么，一律不变。
  prepareOutgoingText = null,
  // 引用消费与草稿清空是两条独立规则：草稿看「输入框有没有被改过」，
  // 引用看「发起时是哪一版」。captureQuote 在 readDraft 里取版本，
  // 发送成功（已写帧）后才 consumeQuote；失败路径不碰引用。
  captureQuote = null,
  consumeQuote = null,
} = {}) {
  if (!state) throw new TypeError('createComposer requires { state }');

  // 上传大文件要等得比普通请求久：9MB 的字节走 base64 要 12MB 请求体，
  // 手机流量下 90 秒不一定够（网关到上游是流式转发，只有空闲 60 秒才断）。
  const uploadApi = typeof api === 'function' ? api : createApiClient({ timeoutMs: 180000 });

  /** 文件正在上传：这段时间不允许再次发送（否则同一文件会传两遍）。 */
  let uploading = false;
  /** 本次发送发起时看到的引用版本；发送成功消费一次，失败/取消不消费。 */
  let pendingQuoteToken = null;

  function genId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function hasDraft() {
    return !!getElement('input').value.trim() || state.attach.some((a) => a && a.base64);
  }

  function setBusy(busy) {
    state.busy = busy;
    paintSendButton();
  }

  /**
   * 主按钮一个键、三种含义（与桌面宿主一致）：
   *   不在生成 + 有草稿 → 发送；生成中 + 有草稿 → 插话；生成中 + 没草稿 → 停止。
   * 以前把「停止」拆成旁边一个小键，视觉上多一个按钮，跟宿主对不上。
   */
  function paintSendButton() {
    const btn = getElement('btnSend');
    if (!btn) return;
    const label = btn.querySelector('.send-label');
    if (!state.busy) {
      btn.classList.remove('stop', 'steer');
      if (label) label.textContent = '发送';
      btn.disabled = sendController.isSending() || !hasDraft() || !state.wsReady || uploading;
      return;
    }
    if (canSteer()) {
      btn.classList.remove('stop');
      btn.classList.add('steer');
      if (label) label.textContent = '插话';
      btn.disabled = false;
      return;
    }
    btn.classList.remove('steer');
    btn.classList.add('stop');
    if (label) label.textContent = '停止';
    btn.disabled = false;
  }

  /** 生成中能不能插话：要有字、连接就绪、没在发；带附件的插话先不支持。 */
  function canSteer() {
    return (
      !!getElement('input').value.trim()
      && state.wsReady
      && !uploading
      && !sendController.isSending()
      && !(state.attach || []).length
    );
  }

  function syncSendButton() {
    paintSendButton();
  }

  function abortTurn() {
    if (!state.session) return;
    // 已经在等重连补发：不要重复排队、也不要重复提示。
    if (state.pendingAbort && state.pendingAbort.sessionPath === state.session.path) return;
    const { streamId } = streamState.snapshot();
    const sent = sockets.send({
      type: 'abort',
      ...(state.session.sessionId ? { sessionId: state.session.sessionId } : {}),
      sessionPath: state.session.path,
      ...(streamId ? { streamId } : {}),
    });
    if (!sent) {
      // 连接没打开时 send 返回 false。以前照样 finishTurn()：用户看到「已停止」，
      // 服务端其实还在跑。这里只把 abort 排进待发队列，本地保持生成态，等连接恢复补发。
      sockets.setPendingAbort({
        sessionPath: state.session.path,
        sessionId: state.session.sessionId || null,
        streamId: streamId || null,
      });
      renderer.appendSystem('连接已断开，正在恢复连接后停止生成…', true);
      sockets.scheduleReconnect(0);   // 立刻重连，不要等 8 秒的重连退避
      return;
    }
    state.pendingAbort = null;
    renderer.finishTurn();
  }

  // 发送协调器：单飞锁、草稿/预览快照、等待/取消都在 controller 里；app 只提供读写与渲染。
  const sendController = createSendController({
    readDraft() {
      const rawText = getElement('input').value;
      let outgoingText = rawText;
      // 正文没改写成功（prepareOutgoingText 抛错/返回非字符串）就不把引用算作已应用，
      // 否则发送成功后会把一条其实没发出去的引用消费掉。
      let textPrepared = typeof prepareOutgoingText !== 'function';
      if (typeof prepareOutgoingText === 'function') {
        try {
          const prepared = prepareOutgoingText(rawText);
          if (typeof prepared === 'string') {
            outgoingText = prepared;
            textPrepared = true;
          }
        } catch (err) {
          // 改写失败不能把发送搞没：退回原文，只留一行日志。
          console.error('[composer] prepareOutgoingText error:', err);
        }
      }
      pendingQuoteToken = null;
      if (textPrepared && typeof captureQuote === 'function') {
        try {
          const token = captureQuote();
          if (typeof token === 'number' && Number.isFinite(token)) pendingQuoteToken = token;
        } catch (err) {
          console.error('[composer] captureQuote error:', err);
        }
      }
      return { rawText, outgoingText, attachments: state.attach };
    },
    readSession: () => state.session,
    waitForReady,
    sendFrame: (frame) => sockets.send(frame),
    makeInputId: genId,
    report(payload) {
      switch (payload?.code) {
        case 'images-pending':
          renderer.appendSystem('附件还在处理，稍等一下再发');
          return;
        case 'invalid-images':
          renderer.appendSystem(payload.message, true);
          return;
        case 'not-ready':
          renderer.appendSystem('（连接还没就绪，消息没发出去，请再点一次发送）', true);
          return;
        case 'disconnected':
          renderer.appendSystem('（发送失败：连接已断开）', true);
          return;
        default:
          return;
      }
    },
    onSendingChange() {
      syncSendButton();
    },
    commitSent({ rawText, text, attachments, inputId, shown, delivery, prepared = false }) {
      const input = getElement('input');
      if (!prepared) {
        // 引用按发起时的版本消费：帧已经写出去了，这一次引用就完成了任务；
        // 与「输入框有没有被改过」无关，也不会误伤等待期间改选的新引用。
        const quoteToken = pendingQuoteToken;
        pendingQuoteToken = null;
        if (quoteToken !== null && typeof consumeQuote === 'function') {
          try {
            consumeQuote(quoteToken);
          } catch (err) {
            // 引用条收起失败不能把已经完成的发送搞成失败。
            console.error('[composer] consumeQuote error:', err);
          }
        }
        // 普通发送仅清空未被修改的文本草稿，保留等待期间输入的新草稿。
        if (input.value === rawText) {
          input.value = '';
          input.style.height = 'auto';
          // 已经发出去的文字不该再从磁盘草稿里复活（B2 的草稿落盘由装配层管）。
          onDraftCleared();
        }
        // 仅移除本次已发出的附件，保留等待期间新增的附件。
        if (attachments.length) {
          state.attach = state.attach.filter((a) => !attachments.includes(a));
          renderAttachBar();
        }
      }

      state.sentInputs.add(inputId);
      if (state.sentInputs.size > 32) {
        const oldest = state.sentInputs.values().next().value;
        if (oldest) state.sentInputs.delete(oldest);
      }
      state.lastLocalUser = { text, at: Date.now() };

      if (delivery === 'steer') {
        // 插话当场画进正文：用户看得见自己那句落在哪，而不是只闪一条提示。
        if (typeof renderer.appendInterjection === 'function') renderer.appendInterjection(text);
        return;
      }

      // 文件项没有预览图，不能当图片交给 mediaGrid；文件走 fileChips（名称条）。
      const imageShown = (Array.isArray(shown) ? shown : []).filter((s) => s && s.src);
      const files = (Array.isArray(attachments) ? attachments : [])
        .filter(isFileAttachment)
        .map((a) => ({ fileId: a.fileId, label: a.name }));
      renderer.appendUser(text, imageShown, files);
      renderer.clearStats();
      state.turnStart = performance.now();

      setBusy(true);
    },
  });

  /** 托盘里还有没传的？有才需要走异步上传分支（见 sendMessage 的注释）。 */
  function hasPendingFileDocs() {
    return (state.attach || []).some((a) => isFileAttachment(a) && !a.fileId && a.file);
  }

  function sendMessage() {
    if (uploading) return Promise.resolve();
    // 没有文件要走同步发起：send-controller 的会话身份快照必须在点下发送的同一个
    // tick 里捕获，否则「等 WS 就绪期间用户切了会话」会变成往新会话发旧草稿。
    if (!hasPendingFileDocs()) return sendController.send();
    return (async () => {
      // 文件必须先变成会话文件才能进帧；传不上去就不发（不能让用户以为发出去了）
      if (!(await flushFileDocs())) return;
      return sendController.send();
    })();
  }

  /** 日报追问走同一单飞、WS wait 与 commit 管线，但不读取或结算普通聊天编辑状态。 */
  function sendPrepared({ text, feed, isCurrent } = {}) {
    const question = typeof text === 'string' ? text : '';
    return sendController.send({
      preparedDraft: {
        rawText: question,
        outgoingText: question,
        attachments: [],
        feed,
      },
      isCurrent,
    });
  }

  getElement('btnSend').addEventListener('click', () => {
    if (sendController.isSending()) return;
    if (state.busy) {
      // 同一个键：有字就插话，没字就是停止。
      if (canSteer()) sendController.send({ delivery: 'steer' });
      else abortTurn();
      return;
    }
    sendMessage();
  });

  const inputEl = getElement('input');
  inputEl.addEventListener('input', () => {
    autoGrow(inputEl);
    syncSendButton();
  });

  /**
   * 回车发送的唯一判定（聊天页 / 首页 / 登录页共用一套口径）。
   * Shift+Enter 换行；输入法组合态（isComposing 或 keyCode 229）期间的 Enter 是在确认候选词，
   * 不能当发送。只判 isComposing 不够：部分 Android WebView / IME 只给 229。
   */
  function isSendEnter(e) {
    if (!e || e.key !== 'Enter' || e.shiftKey) return false;
    if (e.isComposing || e.keyCode === 229) return false;
    return true;
  }

  inputEl.addEventListener('keydown', (e) => {
    if (!isSendEnter(e)) return;
    e.preventDefault();
    if (state.busy) {
      if (canSteer()) sendController.send({ delivery: 'steer' });
      return;
    }
    if (!getElement('btnSend').disabled && !sendController.isSending()) sendMessage();
  });


  /* ------------------------------------------------------------------ */

  /*
   * 附件托盘：聊天页与首页各一份，上限、渲染、并发预留完全共用，只有容器和按钮不同。
   * 两处都在 S 上持有自己的数组，不共用——“首页选好的图”不应该出现在聊天页的托盘里，
   * 除非首页发送流程真的把它交接过去。
   */
  const ATTACH_TRAYS = {
    chat: {
      container: () => getElement('attachBar'),
      button: () => getElement('btnAttach'),
      items: () => state.attach,
      replace: (list) => { state.attach = list; },
    },
    home: {
      container: () => getElement('homeAttachBar'),
      button: () => getElement('btnHomeAttach'),
      items: () => state.homeAttach,
      replace: (list) => { state.homeAttach = list; },
    },
  };

  function attachTray(name) {
    return name === 'home' ? ATTACH_TRAYS.home : ATTACH_TRAYS.chat;
  }

  /** 附件相关的提示：聊天页写进对话，首页浮一条。 */
  function reportAttach(text, trayName) {
    if (trayName === 'home') flash(text);
    else renderer.appendSystem(text, true);
  }

  function clearAttach(trayName = 'chat') {
    const tray = attachTray(trayName);
    tray.replace([]);
    renderAttachBar(trayName);
    syncSendButton();
  }

  function renderAttachBar(trayName = 'chat') {
    const tray = attachTray(trayName);
    const bar = tray.container();
    if (!bar) return;
    const items = tray.items() || [];
    bar.innerHTML = '';
    if (!items.length) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;

    for (const a of items) {
      if (isFileAttachment(a)) {
        bar.appendChild(fileChip(a, tray));
        continue;
      }

      const chip = el('div', 'attach-chip');

      if (a.previewUrl) {
        const img = document.createElement('img');
        img.src = a.previewUrl;
        img.alt = a.name || '图片';
        chip.appendChild(img);
      }

      if (!a.base64) {
        chip.appendChild(el('div', 'attach-pending', '处理中'));
      } else {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'attach-x';
        x.textContent = '×';
        x.setAttribute('aria-label', `移除 ${a.name || '图片'}`);
        x.addEventListener('click', () => {
          tray.replace((tray.items() || []).filter((item) => item !== a));
          renderAttachBar(trayName);
          syncSendButton();
        });
        chip.appendChild(x);
        chip.title = `${a.name || '图片'}${a.bytes ? ' · ' + formatBytes(a.bytes) : ''}`;
      }

      bar.appendChild(chip);
    }
  }

  /**
   * 文件项的托盘卡片：没预览图，靠扩展名角标 + 文件名 + 大小认人。
   * 状态只有两种：待上传（还没传，发送时才传）、上传中。传完就发了，不会停在“已就绪”。
   */
  function fileChip(a, tray) {
    const chip = el('div', 'attach-chip attach-chip-file');
    chip.title = `${a.name || '文件'}${a.bytes ? ' · ' + formatBytes(a.bytes) : ''}`;
    chip.appendChild(el('div', 'attach-file-badge', fileBadge(a.name)));

    const meta = el('div', 'attach-file-meta');
    meta.appendChild(el('div', 'attach-file-name', a.name || '文件'));
    const line = [];
    if (a.bytes) line.push(formatBytes(a.bytes));
    line.push(a.uploading ? '上传中…' : '待发送');
    meta.appendChild(el('div', 'attach-file-size', line.join(' · ')));
    chip.appendChild(meta);

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'attach-x';
    x.textContent = '×';
    x.setAttribute('aria-label', `移除 ${a.name || '文件'}`);
    x.addEventListener('click', () => {
      tray.replace((tray.items() || []).filter((item) => item !== a));
      renderAttachBar(tray === ATTACH_TRAYS.home ? 'home' : 'chat');
      syncSendButton();
    });
    chip.appendChild(x);
    return chip;
  }

  /* ---------------- 文件：选进来只占位，发送前才上传 ---------------- */

  /** 图片扩展名：Android 上 `file.type` 经常是空串，得靠扩展名认。 */
  const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif']);

  function looksLikeImage(file) {
    const type = String(file?.type || '').toLowerCase();
    if (type) return type.startsWith('image/');
    const ext = String(file?.name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
    return IMAGE_EXT.has(ext);
  }

  function trayItems(trayName) {
    return attachTray(trayName).items() || [];
  }

  function countFiles(trayName) {
    return trayItems(trayName).filter(isFileAttachment).length;
  }

  function countImages(trayName) {
    return trayItems(trayName).filter((a) => !isFileAttachment(a)).length;
  }

  /**
   * 文档/音频：不进图片压缩管线，也不在这里传。
   * 只做三件事：查类型、查体积、同步占位（占位必须在任何 await 前完成，
   * 否则两次并发选择会各自按旧数量通过检查）。
   */
  function addFileDocuments(files, trayName = 'chat') {
    const tray = attachTray(trayName);
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;

    const room = Math.max(0, MAX_FILES - countFiles(trayName));
    if (room <= 0) {
      reportAttach(`一次最多发 ${MAX_FILES} 个文件`, trayName);
      return;
    }
    const take = list.slice(0, room);
    if (list.length > room) reportAttach(`只取了前 ${room} 个文件，一次最多 ${MAX_FILES} 个`, trayName);

    const added = [];
    for (const file of take) {
      const rawName = String(file.name || '').trim() || '未命名文件';
      const resolved = resolveFileMime(file);
      if (!resolved.ok) {
        reportAttach(`「${rawName}」加不了：${resolved.reason}`, trayName);
        continue;
      }
      const tooBig = fileSizeProblem(file.size);
      if (tooBig) {
        reportAttach(`「${rawName}」加不了：${tooBig}`, trayName);
        continue;
      }
      state.attachSeq = (state.attachSeq || 0) + 1;
      added.push({
        id: `file-${state.attachSeq}`,
        kind: 'file',
        name: rawName,
        mimeType: resolved.mimeType,
        bytes: Number(file.size) || 0,
        // 原始 File 留着，发送时才读字节（见 FILE_READY_FLAG 的注释）
        file,
        base64: FILE_READY_FLAG,
      });
    }

    if (!added.length) return;
    tray.replace([...(tray.items() || []), ...added]);
    renderAttachBar(trayName);
    syncSendButton();
  }

  /**
   * 发送前把托盘里的文件传成会话文件。
   * 返回 true = 全都拿到 fileId（或者本来就没有文件）；false = 不要发。
   * 失败的那个文件从托盘里拿掉并说明原因：用户可以重试，不会卡着一个永远传不上的项。
   */
  async function flushFileDocs() {
    const pending = (state.attach || []).filter((a) => isFileAttachment(a) && !a.fileId && a.file);
    if (!pending.length) return true;
    if (uploading) return false;

    const session = state.session;
    const sessionPath = session?.path;
    if (!sessionPath) {
      renderer.appendSystem('还没有会话，文件得先开个会话再发', true);
      return false;
    }

    uploading = true;
    syncSendButton();
    try {
      for (const a of pending) {
        a.uploading = true;
        renderAttachBar('chat');
        try {
          const saved = await uploadSessionFile(a.file, {
            api: uploadApi,
            sessionPath,
            mimeType: a.mimeType,
            name: a.name,
          });
          a.fileId = saved.fileId;
          a.sessionPath = sessionPath;
          if (saved.bytes) a.bytes = saved.bytes;
          if (saved.mimeType) a.mimeType = saved.mimeType;
          delete a.file;
        } catch (err) {
          state.attach = (state.attach || []).filter((item) => item !== a);
          renderAttachBar('chat');
          renderer.appendSystem(`「${a.name || '文件'}」没传上去：${err?.message || err}`, true);
          return false;
        } finally {
          a.uploading = false;
        }
        // 上传期间用户切了会话：这批文件属于旧会话，不能发给新会话
        if (state.session !== session) {
          renderer.appendSystem('会话已经切走了，文件没发出去，请重新发一次', true);
          return false;
        }
        renderAttachBar('chat');
        syncSendButton();
      }
      return true;
    } finally {
      uploading = false;
      syncSendButton();
    }
  }

  async function addFiles(files, trayName = 'chat') {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    // 文件同步占位（不 await），图片接着走原来的压缩管线（那里的原子预留不能动）
    addFileDocuments(list.filter((f) => !looksLikeImage(f)), trayName);
    await addImageFiles(list.filter(looksLikeImage), trayName);
  }

  async function addImageFiles(files, trayName = 'chat') {
    const tray = attachTray(trayName);
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;

    // 容量必须原子预留：先把本批要占的槽位同步 push 进托盘，再逐个 await 处理。
    // 以前 room 只在函数开头算一次，两次并发调用会各自按旧数量通过检查，合起来突破
    // MAX_IMAGES，之后 validateForSend 把整批拒掉，用户一张也发不出去。
    // 额度只算图片：托盘里躺着的文件不占图片名额。
    const room = Math.max(0, MAX_IMAGES - countImages(trayName));
    if (room <= 0) {
      reportAttach(`一次最多发 ${MAX_IMAGES} 张图片`, trayName);
      return;
    }
    const take = list.slice(0, room);
    if (list.length > room) reportAttach(`只取了前 ${room} 张，一次最多 ${MAX_IMAGES} 张`, trayName);

    const slots = [];
    for (const file of take) {
      state.attachSeq += 1;
      const slot = { id: `slot-${state.attachSeq}`, name: file.name || '', pending: true, file };
      tray.replace([...(tray.items() || []), slot]);
      slots.push(slot);
    }
    renderAttachBar(trayName);
    syncSendButton();

    const button = tray.button();
    if (button) button.classList.add('busy');
    try {
      for (const slot of slots) {
        try {
          const att = await prepareImage(slot.file);
          const items = tray.items() || [];
          const idx = items.indexOf(slot);
          if (idx === -1) continue;   // 处理期间用户把这张移除了
          const next = items.slice();
          next[idx] = att;
          tray.replace(next);
        } catch (err) {
          tray.replace((tray.items() || []).filter((item) => item !== slot));
          reportAttach(`「${slot.name || '图片'}」加不了：${err.message}`, trayName);
        }
        renderAttachBar(trayName);
        syncSendButton();
      }
    } finally {
      if (button) button.classList.remove('busy');
    }

    if (trayName === 'chat') renderer.scrollToBottom();
  }

  // 同一个图片来源选择面板服务两个入口；点谁就记下这一批图该进哪个托盘。
  let attachTarget = 'chat';

  function openAttachSheet(show, target) {
    if (show && target) attachTarget = target === 'home' ? 'home' : 'chat';
    const sheet = getElement('attachSheet');
    if (sheet) sheet.hidden = !show;
  }

  /**
   * 消费一次返回键：仅在图片来源 sheet 展开时收起它并返回 true。
   * 已经关闭时返回 false，把返回权交还外层返回链。
   */
  function back() {
    const sheet = getElement('attachSheet');
    if (sheet && !sheet.hidden) {
      openAttachSheet(false);
      return true;
    }
    return false;
  }

  getElement('btnAttach').addEventListener('click', () => openAttachSheet(true, 'chat'));
  getElement('btnHomeAttach')?.addEventListener('click', () => openAttachSheet(true, 'home'));

  getElement('attachSheet').addEventListener('click', (e) => {
    const act = e.target?.closest?.('.sheet-item')?.dataset?.act;
    if (!act) {
      if (e.target === getElement('attachSheet')) openAttachSheet(false);
      return;
    }
    openAttachSheet(false);
    if (act === 'camera') getElement('pickCamera').click();
    else if (act === 'gallery') getElement('pickGallery').click();
    else if (act === 'document') getElement('pickDocument').click();
  });

  for (const id of ['pickCamera', 'pickGallery', 'pickDocument']) {
    getElement(id).addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (files.length) addFiles(files, attachTarget);
    });
  }

  // 粘贴/拖入也走同一套分发：图片进压缩管线，其余看能不能传成会话文件
  inputEl.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items.filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  getElement('view-chat').addEventListener('dragover', (e) => {
    if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
  });

  getElement('view-chat').addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });

  return {
    hasDraft,
    setBusy,
    syncSendButton,
    abortTurn,
    sendMessage,
    sendPrepared,
    isSendEnter,
    sendController,
    // 附件托盘
    renderAttachBar,
    clearAttach,
    addFiles,
    openAttachSheet,
    attachTray,
    back,
  };
}
