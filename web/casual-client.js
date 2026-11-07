/* web/casual-client.js — Hana 宿主「闲聊」通道的纯 HTTP 客户端
 *
 * 宿主闲聊是独立于主会话的通道，客户端可用的接口全在 HTTP 上：
 *   GET  /api/casual/{agentId}/summary             → { preview: {text, occurredAt, previewKind?} | null, unread }
 *   GET  /api/casual/{agentId}/entries?limit=50    → { entries, hasMore, typing }（可带 &before=<sourceEntryId>）
 *   POST /api/casual/{agentId}/messages            → { entryId, entries, reset? }
 *   POST /api/casual/{agentId}/read                → 回执
 *   GET  /api/casual/{agentId}/style               → { stylePackId, appearance }
 *   GET  /api/casual/stickers                      → { packs }
 * 文本命令 /reset 走 messages 接口，回执里带 { reset: true }。
 *
 * Entry 形状：
 *   { id, sourceEntryId, actor: 'agent'|'user', occurredAt: ISO, clientMessageId?, item }
 * item.kind 共 8 种：text / card / sticker / image / file / approval / reset / voice。
 *
 * 设计纪律：
 *   - 零 import、不读全局（只有默认 newId 会看 globalThis.crypto）、无 DOM、除 agentId 外无状态；
 *   - request(path, { method, body }) 由调用方注入（app.js 传现有 api()）。宿主的 api() 只接受
 *     字符串 body，所以序列化在本模块内完成；
 *   - 每个响应都校验并归一化成稳定形状，缺必需字段就抛带中文说明的 Error，脏数据不往下游传；
 *   - file / voice 这类结构复杂的 item 原样透传，绝不裁剪字段。
 */

const PAGE_LIMIT = 50;
const RESET_COMMAND = '/reset';
const ACTORS = new Set(['agent', 'user']);
const ENTRY_KINDS = new Set(['text', 'card', 'sticker', 'image', 'file', 'approval', 'reset', 'voice']);
const APPROVAL_STATUSES = new Set(['pending', 'approved', 'denied']);

/* ------------------------------------------------------------------ */
/* 默认 clientMessageId                                                */
/* ------------------------------------------------------------------ */

function defaultNewId() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    try {
      return cryptoObj.randomUUID();
    } catch {
      // 非安全上下文下 randomUUID 可能直接抛，退回时间戳+随机数
    }
  }
  return `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ */
/* 校验与归一化工具                                                     */
/* ------------------------------------------------------------------ */

function badShape(detail) {
  return new Error(`闲聊接口返回异常：${detail}`);
}

function inputError(detail) {
  return new Error(`闲聊请求参数不正确：${detail}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asObject(value, label) {
  if (!isPlainObject(value)) throw badShape(`${label}不是对象`);
  return value;
}

function asString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw badShape(`${label}缺失或不是字符串`);
  if (!allowEmpty && value.trim() === '') throw badShape(`${label}为空`);
  return value;
}

function asOptionalString(value, label) {
  if (value == null) return undefined;
  if (typeof value !== 'string') throw badShape(`${label}不是字符串`);
  return value;
}

function asOptionalNumber(value, label) {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw badShape(`${label}不是合法数字`);
  return value;
}

function asIsoTime(value, label) {
  const text = asString(value, label);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw badShape(`${label}不是合法时间：${text}`);
  return new Date(ms).toISOString();
}

/* ------------------------------------------------------------------ */
/* item 归一化                                                         */
/* ------------------------------------------------------------------ */

function normalizeItem(raw, label) {
  const item = asObject(raw, `${label}的 item`);
  const kind = asString(item.kind, `${label}的 item.kind`);
  if (!ENTRY_KINDS.has(kind)) throw badShape(`${label}的 item.kind 不受支持：${kind}`);

  switch (kind) {
    case 'text':
      // 文本允许空串：宿主偶尔会推一条刚被清空/占位的文本条目，条目本身不能丢。
      return { kind, text: asString(item.text, `${label}的文本`, { allowEmpty: true }) };

    case 'card': {
      const out = { kind, cardId: asString(item.cardId, `${label}的卡片 cardId`) };
      const title = asOptionalString(item.title, `${label}的卡片 title`);
      if (title !== undefined) out.title = title;
      // block 的结构由卡片模块定义，这里不解析、不裁剪。
      if (item.block !== undefined && item.block !== null) out.block = item.block;
      return out;
    }

    case 'sticker': {
      const out = {
        kind,
        stickerId: asString(item.stickerId, `${label}的贴纸 stickerId`),
        url: asString(item.url, `${label}的贴纸 url`),
      };
      const note = asOptionalString(item.note, `${label}的贴纸 note`);
      if (note !== undefined) out.note = note;
      return out;
    }

    case 'image': {
      const out = { kind, url: asString(item.url, `${label}的图片 url`) };
      const fileId = asOptionalString(item.fileId, `${label}的图片 fileId`);
      if (fileId !== undefined) out.fileId = fileId;
      const width = asOptionalNumber(item.width, `${label}的图片 width`);
      if (width !== undefined) out.width = width;
      const height = asOptionalNumber(item.height, `${label}的图片 height`);
      if (height !== undefined) out.height = height;
      return out;
    }

    case 'file':
      // 文件条目结构复杂且由其它模块消费：原样透传，绝不丢字段。
      return { ...item };

    case 'approval': {
      const status = item.status;
      if (!APPROVAL_STATUSES.has(status)) {
        throw badShape(`${label}的审批 status 不合法：${String(status)}`);
      }
      const out = {
        kind,
        approvalId: asString(item.approvalId, `${label}的审批 approvalId`),
        title: asString(item.title, `${label}的审批 title`, { allowEmpty: true }),
        status,
      };
      const detail = asOptionalString(item.detail, `${label}的审批 detail`);
      if (detail !== undefined) out.detail = detail;
      if (item.source !== undefined && item.source !== null) out.source = item.source;
      return out;
    }

    case 'reset':
      return { kind };

    case 'voice':
      // 本轮不做语音，但条目必须保留：整对象透传（text / fileId / durationMs 及额外字段）。
      return { ...item };
  }

  throw badShape(`${label}的 item.kind 不受支持：${kind}`);
}

function normalizeEntry(raw, index) {
  const label = `第 ${index + 1} 条闲聊条目`;
  const entry = asObject(raw, label);
  const actor = entry.actor;
  if (!ACTORS.has(actor)) throw badShape(`${label}的 actor 只能是 agent 或 user`);
  const clientMessageId = asOptionalString(entry.clientMessageId, `${label}的 clientMessageId`);

  const out = {
    id: asString(entry.id, `${label}的 id`),
    sourceEntryId: asString(entry.sourceEntryId, `${label}的 sourceEntryId`),
    actor,
    occurredAt: asIsoTime(entry.occurredAt, `${label}的 occurredAt`),
    item: normalizeItem(entry.item, label),
  };
  if (clientMessageId) out.clientMessageId = clientMessageId;
  return out;
}

/* ------------------------------------------------------------------ */
/* 各接口响应归一化                                                     */
/* ------------------------------------------------------------------ */

function normalizeSummary(raw) {
  const summary = asObject(raw, '闲聊摘要');
  if (typeof summary.unread !== 'number' || !Number.isFinite(summary.unread)) {
    throw badShape('闲聊摘要的 unread 缺失或不是数字');
  }
  const unread = Math.max(0, Math.trunc(summary.unread));

  let preview = null;
  if (summary.preview != null) {
    const p = asObject(summary.preview, '闲聊摘要的 preview');
    preview = {
      text: asString(p.text, '闲聊摘要 preview 的 text', { allowEmpty: true }),
      occurredAt: asIsoTime(p.occurredAt, '闲聊摘要 preview 的 occurredAt'),
    };
    const previewKind = asOptionalString(p.previewKind, '闲聊摘要 preview 的 previewKind');
    if (previewKind !== undefined) preview.previewKind = previewKind;
  }

  return { preview, unread };
}

function normalizePage(raw) {
  const page = asObject(raw, '闲聊条目分页');
  if (!Array.isArray(page.entries)) throw badShape('闲聊条目分页的 entries 不是数组');
  return {
    entries: page.entries.map(normalizeEntry),
    hasMore: page.hasMore === true,
    typing: page.typing === true,
  };
}

function normalizeSendResult(raw) {
  const result = asObject(raw, '闲聊发送回执');
  if (!Array.isArray(result.entries)) throw badShape('闲聊发送回执的 entries 不是数组');
  return {
    entryId: asString(result.entryId, '闲聊发送回执的 entryId'),
    entries: result.entries.map(normalizeEntry),
    reset: result.reset === true,
  };
}

function normalizeReceipt(raw, label) {
  if (raw == null) return { ok: true, reset: false };
  const receipt = asObject(raw, label);
  return { ok: receipt.ok !== false, reset: receipt.reset === true };
}

function normalizeStyle(raw) {
  const style = asObject(raw, '闲聊风格');
  const stylePackId = asString(style.stylePackId, '闲聊风格的 stylePackId');
  let appearance = null;
  if (style.appearance != null) {
    appearance = { ...asObject(style.appearance, '闲聊风格的 appearance') };
  }
  return { stylePackId, appearance };
}

function normalizeSticker(raw, index) {
  const label = `第 ${index + 1} 张贴纸`;
  const sticker = asObject(raw, label);
  const out = {
    id: asString(sticker.id, `${label}的 id`),
    url: asString(sticker.url, `${label}的 url`),
  };
  const note = asOptionalString(sticker.note, `${label}的 note`);
  if (note !== undefined) out.note = note;
  return out;
}

function normalizePack(raw, index) {
  const label = `第 ${index + 1} 个贴纸包`;
  const pack = asObject(raw, label);
  if (!Array.isArray(pack.stickers)) throw badShape(`${label}的 stickers 不是数组`);
  return {
    id: asString(pack.id, `${label}的 id`),
    name: asString(pack.name, `${label}的 name`, { allowEmpty: true }),
    editable: pack.editable === true,
    stickers: pack.stickers.map(normalizeSticker),
  };
}

function normalizeStickerPacks(raw) {
  const payload = asObject(raw, '贴纸包列表');
  if (!Array.isArray(payload.packs)) throw badShape('贴纸包列表缺少 packs 数组');
  return { packs: payload.packs.map(normalizePack) };
}

/* ------------------------------------------------------------------ */
/* 发送参数归一化                                                       */
/* ------------------------------------------------------------------ */

function normalizeAttachments(raw) {
  if (!Array.isArray(raw)) throw inputError('attachments 必须是数组');
  return raw.map((att, index) => {
    const label = `第 ${index + 1} 个附件`;
    if (!isPlainObject(att)) throw inputError(`${label}不是对象`);
    const fileId = att.fileId;
    if (typeof fileId !== 'string' || fileId.trim() === '') {
      throw inputError(`${label}缺少 fileId`);
    }
    const mime = att.mime;
    if (typeof mime !== 'string' || mime.trim() === '') {
      throw inputError(`${label}缺少 mime`);
    }
    const out = { fileId, mime };
    if (att.name != null) {
      if (typeof att.name !== 'string') throw inputError(`${label}的 name 必须是字符串`);
      out.name = att.name;
    }
    return out;
  });
}

/* ------------------------------------------------------------------ */
/* 工厂                                                                */
/* ------------------------------------------------------------------ */

/**
 * 创建闲聊通道的 HTTP 客户端。
 *
 * @param {object} options
 * @param {(path: string, init?: {method?: string, body?: string}) => Promise<any>} options.request 注入的请求函数
 * @param {string} [options.agentId] 当前闲聊的 agent id；也可稍后用 setAgentId 设置
 * @param {() => string} [options.newId] clientMessageId 生成器，默认 crypto.randomUUID（不可用时时间戳+随机）
 * @returns {{
 *   getAgentId: () => string|null,
 *   setAgentId: (id: string) => string,
 *   loadSummary: () => Promise<{preview: object|null, unread: number}>,
 *   loadPage: (options?: {before?: string}) => Promise<{entries: object[], hasMore: boolean, typing: boolean}>,
 *   send: (message?: object) => Promise<{entryId: string, entries: object[], reset: boolean}>,
 *   markRead: (entryId: string) => Promise<{ok: boolean, reset: boolean}>,
 *   loadStyle: () => Promise<{stylePackId: string, appearance: object|null}>,
 *   loadStickerPacks: () => Promise<{packs: object[]}>,
 *   reset: () => Promise<{entryId: string, entries: object[], reset: boolean}>,
 * }}
 */
export function createCasualClient({ request, agentId, newId = defaultNewId } = {}) {
  if (typeof request !== 'function') {
    throw new TypeError('createCasualClient 需要注入 request(path, init) 函数');
  }
  if (typeof newId !== 'function') {
    throw new TypeError('createCasualClient 的 newId 必须是生成 clientMessageId 的函数');
  }

  let currentAgentId = normalizeInitialAgentId(agentId);

  function normalizeInitialAgentId(value) {
    if (value == null) return null;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError('createCasualClient 的 agentId 必须是非空字符串');
    }
    return value;
  }

  /** 所有按 agent 分组的接口共用的前缀。没有 agentId 时直接报错，不发半截请求。 */
  function agentBase() {
    if (!currentAgentId) throw new Error('闲聊客户端尚未设置 agentId，无法请求该接口');
    return `/api/casual/${encodeURIComponent(currentAgentId)}`;
  }

  function getAgentId() {
    return currentAgentId;
  }

  function setAgentId(id) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('setAgentId 需要非空的 agentId 字符串');
    }
    currentAgentId = id;
    return currentAgentId;
  }

  async function loadSummary() {
    const raw = await request(`${agentBase()}/summary`, { method: 'GET' });
    return normalizeSummary(raw);
  }

  async function loadPage({ before } = {}) {
    const query = new URLSearchParams();
    query.set('limit', String(PAGE_LIMIT));
    if (before != null) {
      if (typeof before !== 'string' || before.trim() === '') {
        throw new Error('loadPage 的 before 必须是非空的 sourceEntryId 字符串');
      }
      query.set('before', before);
    }
    const raw = await request(`${agentBase()}/entries?${query.toString()}`, { method: 'GET' });
    return normalizePage(raw);
  }

  async function send({ text, stickerId, attachments, clientMessageId } = {}) {
    const payload = {};
    let hasContent = false;

    if (text != null) {
      if (typeof text !== 'string') throw inputError('text 必须是字符串');
      if (text.trim() !== '') {
        payload.text = text;
        hasContent = true;
      }
    }

    if (stickerId != null) {
      if (typeof stickerId !== 'string' || stickerId.trim() === '') {
        throw inputError('stickerId 必须是非空字符串');
      }
      payload.stickerId = stickerId;
      hasContent = true;
    }

    if (attachments != null) {
      const normalized = normalizeAttachments(attachments);
      if (normalized.length > 0) {
        payload.attachments = normalized;
        hasContent = true;
      }
    }

    if (!hasContent) throw inputError('发送内容为空：文本、贴纸与附件至少要有一项');

    let messageId;
    if (clientMessageId != null) {
      if (typeof clientMessageId !== 'string' || clientMessageId.trim() === '') {
        throw inputError('clientMessageId 必须是非空字符串');
      }
      messageId = clientMessageId;
    } else {
      messageId = newId();
      if (typeof messageId !== 'string' || messageId.trim() === '') {
        throw new Error('newId() 必须返回非空字符串作为 clientMessageId');
      }
    }

    const body = JSON.stringify({ ...payload, clientMessageId: messageId });
    const raw = await request(`${agentBase()}/messages`, { method: 'POST', body });
    return normalizeSendResult(raw);
  }

  async function markRead(entryId) {
    if (typeof entryId !== 'string' || entryId.trim() === '') {
      throw new Error('markRead 需要非空的 entryId');
    }
    const raw = await request(`${agentBase()}/read`, {
      method: 'POST',
      body: JSON.stringify({ entryId }),
    });
    return normalizeReceipt(raw, '闲聊已读回执');
  }

  async function loadStyle() {
    const raw = await request(`${agentBase()}/style`, { method: 'GET' });
    return normalizeStyle(raw);
  }

  async function loadStickerPacks() {
    const raw = await request('/api/casual/stickers', { method: 'GET' });
    return normalizeStickerPacks(raw);
  }

  /** /reset 是文本命令，不是独立接口；回执里的 reset:true 表示宿主已重置闲聊。 */
  async function reset() {
    return send({ text: RESET_COMMAND });
  }

  return {
    getAgentId,
    setAgentId,
    loadSummary,
    loadPage,
    send,
    markRead,
    loadStyle,
    loadStickerPacks,
    reset,
  };
}
