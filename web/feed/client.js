/* 日报 HTTP 客户端：请求宿主 /api/feed 接口，并在入口把外部数据校验一次。
 *
 * 只做请求与形状校验：不依赖 DOM、不碰 iframe、不读全局状态。
 * HTTP 失败沿用 web/http-client.js 的 err.status/err.body，这里只把宿主错误体里的
 * error/code 补到 err.code，消息保持原样给界面展示。网络错误/超时原样抛出。
 *
 * 空列表是合法结果；401/403/404、协议形状错误与卡片版本漂移都必须明确抛出，
 * 不能吞成「今天没有日报」。
 */

const CLIENT_KIND = 'mobile';
const SLATE_SIZE = 12;
const MAX_SIGNALS = 100;
/** 宿主 itemId：fi_ + 26 位 Crockford ULID（不含 I/L/O/U）。 */
const FEED_ITEM_ID_RE = /^fi_[0-9A-HJKMNP-TV-Z]{26}$/;
/** 信号类型：宿主当前用 impression/dwell/less_like_this，留同形状的扩展位。 */
const SIGNAL_TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;
/**
 * ISO 日期时间：日期 + T + 时:分[[:秒[.小数]]] + Z 或 ±hh:mm。
 * 只查形状，日历合法性交给 Date.parse；不接受只有日期、空格分隔或本地时间无时区。
 */
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** 阅读保持的最短时长：宿主同时收到 impression+dwell 且 dwell>=600ms 才记已读。 */
const DWELL_MIN_MS = 600;
const LANE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** 宿主把完整原生文档注册在内存卡片里、不写 documentPath 的模板。 */
const NATIVE_DOCUMENT_TEMPLATE = 'automation-digest';
/** 宿主 mobile-document-chunk 单片最多 32KiB 字符。 */
const DOC_CHUNK_MAX_CHARS = 32 * 1024;
/** 完整文档最多 2MiB 字符：超过就是异常，不把整篇长文塞进手机内存。 */
const DOC_TOTAL_MAX_CHARS = 2 * 1024 * 1024;
/** 与上面的总限配套的请求上限：64 片 32KiB 正好 2MiB，要求多一片就拒绝。 */
const DOC_MAX_CHUNKS = 64;

/**
 * @typedef {{ id:string, kind:string, label:string }} FeedAction
 * @typedef {{ state:string, actions:FeedAction[], dueAt?:string }} FeedTask
 * @typedef {{ sourceId:string, agentId?:string, displayName:string }} FeedSource
 * @typedef {object} FeedItem
 * @property {string} itemId
 * @property {number} revision 正整数
 * @property {string} lane
 * @property {string} laneKind
 * @property {string} template
 * @property {string} title
 * @property {string} ask 必填；没有追问文案时是空串，字段缺失或 null 算协议错误
 * @property {string[]} topics 必填字符串数组；无话题时是空数组
 * @property {FeedSource} source
 * @property {string} createdAt
 * @property {boolean} unread
 * @property {boolean} favorite
 * @property {string} [explain]
 * @property {string} [expiresAt]
 * @property {FeedTask} [task]
 * @property {object} [payloadSummary] 仅 item() 附带
 * @typedef {{ itemId:string, revision:number, title:string }} FeedReference
 */

/* ---- 错误 ---- */

function clientError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function fail(code, message) {
  throw clientError(code, message);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ---- 校验小件 ---- */

function readText(value, label, { allowEmpty = true } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value === '')) {
    fail('feed_protocol_error', `日报接口返回的 ${label} 不是${allowEmpty ? '' : '非空'}字符串`);
  }
  return value;
}

function optionalText(value, label) {
  if (value === undefined || value === null) return undefined;
  return readText(value, label);
}

function readItemId(value, label) {
  if (typeof value !== 'string' || !FEED_ITEM_ID_RE.test(value)) {
    fail('feed_protocol_error', `日报接口返回的 ${label} 不是合法条目 ID`);
  }
  return value;
}

function readRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('feed_protocol_error', `日报接口返回的 ${label} 不是正整数`);
  }
  return value;
}

function readCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('feed_protocol_error', `日报接口返回的 ${label} 不是非负整数`);
  }
  return value;
}

function readBool(value, label) {
  if (typeof value !== 'boolean') fail('feed_protocol_error', `日报接口返回的 ${label} 不是布尔值`);
  return value;
}

function readStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail('feed_protocol_error', `日报接口返回的 ${label} 不是字符串数组`);
  }
  return value.slice();
}

function readFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('feed_protocol_error', `日报接口返回的 ${label} 不是有限数字`);
  }
  return value;
}

function normalizeAction(raw, label) {
  if (!isObject(raw)) fail('feed_protocol_error', `日报接口返回的 ${label} 不是对象`);
  return {
    id: readText(raw.id, `${label}.id`, { allowEmpty: false }),
    kind: readText(raw.kind, `${label}.kind`, { allowEmpty: false }),
    label: readText(raw.label, `${label}.label`),
  };
}

function normalizeTask(raw, label) {
  if (!isObject(raw)) fail('feed_protocol_error', `日报接口返回的 ${label} 不是对象`);
  if (!Array.isArray(raw.actions)) fail('feed_protocol_error', `日报接口返回的 ${label}.actions 不是数组`);
  const task = {
    state: readText(raw.state, `${label}.state`, { allowEmpty: false }),
    actions: raw.actions.map((action, index) => normalizeAction(action, `${label}.actions[${index}]`)),
  };
  const dueAt = optionalText(raw.dueAt, `${label}.dueAt`);
  if (dueAt !== undefined) task.dueAt = dueAt;
  return task;
}

function normalizeSource(raw, label) {
  if (!isObject(raw)) fail('feed_protocol_error', `日报接口返回的 ${label} 不是对象`);
  const source = {
    sourceId: readText(raw.sourceId, `${label}.sourceId`, { allowEmpty: false }),
    displayName: readText(raw.displayName, `${label}.displayName`),
  };
  // agentId 可以缺：缺来源 Agent 时上层要明确报错，不能在这里编一个。
  const agentId = optionalText(raw.agentId, `${label}.agentId`);
  if (agentId) source.agentId = agentId;
  return source;
}

/** 只保留使用到的已验证字段；wire 里的扩展字段不进入内部约定。 */
function normalizeItem(raw, label) {
  if (!isObject(raw)) fail('feed_protocol_error', `日报接口返回的 ${label} 不是对象`);
  const item = {
    itemId: readItemId(raw.itemId, `${label}.itemId`),
    revision: readRevision(raw.revision, `${label}.revision`),
    lane: readText(raw.lane, `${label}.lane`, { allowEmpty: false }),
    laneKind: readText(raw.laneKind, `${label}.laneKind`, { allowEmpty: false }),
    template: readText(raw.template, `${label}.template`, { allowEmpty: false }),
    title: readText(raw.title, `${label}.title`),
    // ask/topics 是宿主 toWire 的固定字段（可为空串/空数组），缺失或 null 属于协议错误。
    ask: readText(raw.ask, `${label}.ask`),
    topics: readStringArray(raw.topics, `${label}.topics`),
    source: normalizeSource(raw.source, `${label}.source`),
    createdAt: readText(raw.createdAt, `${label}.createdAt`, { allowEmpty: false }),
    unread: readBool(raw.unread, `${label}.unread`),
    favorite: readBool(raw.favorite, `${label}.favorite`),
  };
  const explain = optionalText(raw.explain, `${label}.explain`);
  if (explain !== undefined) item.explain = explain;
  const expiresAt = optionalText(raw.expiresAt, `${label}.expiresAt`);
  if (expiresAt !== undefined) item.expiresAt = expiresAt;
  if (raw.task !== undefined && raw.task !== null) item.task = normalizeTask(raw.task, `${label}.task`);
  return item;
}

/* ---- 调用方入参 ---- */

function assertTextArg(value, label) {
  if (typeof value !== 'string' || value === '') fail('feed_invalid_argument', `${label} 必须是非空字符串`);
  return value;
}

function assertItemIdArg(value, label) {
  if (typeof value !== 'string' || !FEED_ITEM_ID_RE.test(value)) {
    fail('feed_invalid_argument', `${label} 不是合法条目 ID`);
  }
  return value;
}

function assertRevisionArg(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail('feed_invalid_argument', `${label} 必须是正整数`);
  return value;
}

/**
 * 阅读信号由调用方（read-tracker）生成，这里只保证发出去的是宿主能记账的形状：
 * 1–100 条、at 是 ISO 日期时间、dwell 带 >=600ms 的 value。
 * detail 是可选的宿主扩展字段，原样透传。
 */
function normalizeSignalArgument(raw, label) {
  if (!isObject(raw)) fail('feed_invalid_argument', `${label} 不是对象`);
  const type = assertTextArg(raw.type, `${label}.type`);
  if (!SIGNAL_TYPE_RE.test(type)) fail('feed_invalid_argument', `${label}.type 不是合法信号类型`);
  const at = assertTextArg(raw.at, `${label}.at`);
  if (!ISO_DATE_TIME_RE.test(at) || Number.isNaN(Date.parse(at))) {
    fail('feed_invalid_argument', `${label}.at 不是 ISO 日期时间（需写全日期与时间，并带 Z 或时区偏移）`);
  }
  const signal = {
    eventId: assertTextArg(raw.eventId, `${label}.eventId`),
    itemId: assertItemIdArg(raw.itemId, `${label}.itemId`),
    type,
    at,
  };
  if (raw.slateId !== undefined && raw.slateId !== null) {
    signal.slateId = assertTextArg(raw.slateId, `${label}.slateId`);
  }
  if (raw.position !== undefined && raw.position !== null) {
    if (!Number.isFinite(raw.position)) fail('feed_invalid_argument', `${label}.position 不是数字`);
    signal.position = raw.position;
  }
  if (raw.value !== undefined && raw.value !== null) {
    if (!Number.isFinite(raw.value)) fail('feed_invalid_argument', `${label}.value 不是数字`);
    signal.value = raw.value;
  }
  // 不足 600ms 的 dwell 不会被宿主记成已读，手机不该发这种无效阅读信号。
  if (type === 'dwell' && !(typeof signal.value === 'number' && signal.value >= DWELL_MIN_MS)) {
    fail('feed_invalid_argument', `${label}.value 是 dwell 信号必须带的毫秒数（至少 ${DWELL_MIN_MS}）`);
  }
  if (raw.detail !== undefined && raw.detail !== null) signal.detail = raw.detail;
  return signal;
}

/** HTTP 错误保留宿主 code：只补 err.code，不改消息/status/body。 */
function annotateHttpError(err) {
  if (!err || typeof err.status !== 'number' || !isObject(err.body)) return err;
  const body = err.body;
  const code =
    typeof body.error === 'string' && body.error
      ? body.error
      : typeof body.code === 'string' && body.code
        ? body.code
        : '';
  if (code && !err.code) err.code = code;
  return err;
}

/**
 * @param {object} [options]
 * @param {(pathname: string, init?: object) => Promise<any>} [options.api] 现有 web/http-client.js 客户端
 */
export function createFeedClient({ api } = {}) {
  if (typeof api !== 'function') throw new TypeError('createFeedClient 需要 api 函数');

  async function call(pathname, init) {
    try {
      return await api(pathname, init);
    } catch (err) {
      throw annotateHttpError(err);
    }
  }

  /** 首屏/翻页：固定 clientKind=mobile、size=12；空 cursor 表示末页。 */
  async function slate({ cursor = null, lanes = [] } = {}) {
    const params = [`clientKind=${CLIENT_KIND}`, `size=${SLATE_SIZE}`];
    if (cursor !== null && cursor !== undefined && cursor !== '') {
      params.push(`cursor=${encodeURIComponent(assertTextArg(cursor, 'cursor'))}`);
    }
    if (lanes !== undefined && lanes !== null) {
      if (!Array.isArray(lanes)) fail('feed_invalid_argument', 'lanes 必须是数组');
      if (lanes.length) {
        const encoded = lanes.map((lane) => {
          const value = assertTextArg(lane, 'lane');
          if (!LANE_RE.test(value)) fail('feed_invalid_argument', `lane 不合法：${value}`);
          return encodeURIComponent(value);
        });
        params.push(`lanes=${encoded.join(',')}`);
      }
    }

    const body = await call(`/api/feed/slate?${params.join('&')}`, {});
    if (!isObject(body)) fail('feed_protocol_error', '日报列表响应不是对象');
    if (!Array.isArray(body.items)) fail('feed_protocol_error', '日报列表响应缺少 items 数组');
    return {
      slateId: readText(body.slateId, 'slateId', { allowEmpty: false }),
      items: body.items.map((raw, index) => normalizeItem(raw, `items[${index}]`)),
      unreadTaskCount: readCount(body.unreadTaskCount, 'unreadTaskCount'),
      cursor: optionalText(body.cursor, 'cursor') ?? null,
      nextPatrolAt: optionalText(body.nextPatrolAt, 'nextPatrolAt') ?? null,
    };
  }

  /** 单条详情：wire 字段 + 可选 payloadSummary（正文预览不含卡片 HTML）。 */
  async function item(itemId) {
    const id = assertItemIdArg(itemId, 'itemId');
    const body = await call(`/api/feed/items/${encodeURIComponent(id)}?clientKind=${CLIENT_KIND}`, {});
    const normalized = normalizeItem(body, 'item');
    if (body.payloadSummary !== undefined && body.payloadSummary !== null) {
      if (!isObject(body.payloadSummary)) {
        fail('feed_protocol_error', '日报接口返回的 payloadSummary 不是对象');
      }
      normalized.payloadSummary = body.payloadSummary;
    }
    return normalized;
  }

  /**
   * 按宿主 mobile-document-chunk 逐片取完整原生文档并拼成一个 HTML 串。
   *
   * 边界全部按宿主返回值复核：ok、精确 offset、length 与 data.length、稳定 totalChars、
   * eof 与「偏移+本片是否到达总长」一致、非空片必须前进。任何一片不合规就整体失败，
   * 界面不会拿到半截文档。总量与请求数都有硬上限；isCurrent 在下一片前变假就停。
   */
  async function readNativeDocument(cardId, { isCurrent } = {}) {
    const stale = () => {
      fail('feed_card_document_cancelled', '日报正文已失效，停止读取');
    };

    const parts = [];
    let offset = 0;
    let total = null;
    let chunks = 0;
    for (;;) {
      if (typeof isCurrent === 'function' && !isCurrent()) stale();
      const body = await call(
        `/api/cards/${encodeURIComponent(cardId)}/mobile-document-chunk?offset=${offset}`,
        {},
      );
      if (!isObject(body)) fail('feed_card_document_protocol_error', '日报正文分片响应不是对象');
      if (body.ok !== true) {
        fail('feed_card_document_unavailable', '这个条目的完整正文暂时读不到，请稍后重试');
      }
      if (!Number.isSafeInteger(body.offset) || body.offset !== offset) {
        fail(
          'feed_card_document_offset_mismatch',
          `日报正文分片偏移不连续（请求 ${offset}，返回 ${String(body.offset)}）`,
        );
      }
      if (!Number.isSafeInteger(body.length) || body.length < 0) {
        fail('feed_card_document_bad_length', '日报正文分片长度不是非负整数');
      }
      if (body.length > DOC_CHUNK_MAX_CHARS) {
        fail('feed_card_document_chunk_too_large', '日报正文分片超过宿主单片上限');
      }
      if (typeof body.data !== 'string' || body.data.length !== body.length) {
        fail('feed_card_document_length_mismatch', '日报正文分片长度与内容不一致');
      }
      if (!Number.isSafeInteger(body.totalChars) || body.totalChars < 0) {
        fail('feed_card_document_bad_length', '日报正文总长不是非负整数');
      }
      if (body.totalChars > DOC_TOTAL_MAX_CHARS) {
        fail('feed_card_document_too_large', '日报正文超过手机阅读上限');
      }
      if (total === null) total = body.totalChars;
      else if (body.totalChars !== total) {
        fail(
          'feed_card_document_total_changed',
          `日报正文在读取过程中变长/变短（${total} → ${body.totalChars}），请重试`,
        );
      }
      if (offset + body.length > total) {
        fail('feed_card_document_bad_length', '日报正文分片越过总长');
      }
      if (typeof body.eof !== 'boolean' || body.eof !== (offset + body.length >= total)) {
        fail('feed_card_document_eof_mismatch', '日报正文分片的结束标记与偏移不一致');
      }
      parts.push(body.data);
      offset += body.length;
      if (body.eof) break;
      if (body.length === 0) {
        fail('feed_card_document_no_progress', '日报正文分片没有前进，已停止读取');
      }
      chunks += 1;
      if (chunks >= DOC_MAX_CHUNKS) {
        fail('feed_card_document_too_many_chunks', '日报正文分片数量超过上限，已停止读取');
      }
    }
    if (typeof isCurrent === 'function' && !isCurrent()) stale();
    return parts.join('');
  }

  /**
   * 铸造卡片：宿主按当前 revision 铸造，不接收 revision/clientKind 参数。
   * URL 只用可信的 itemId 与返回的 revision 拼；documentPath 缺失（非 folio 模板）
   * 时 url=null，界面不能自己猜本机路径。
   *
   * options.template 为宿主原生文档模板（automation-digest）且没有 documentPath 时，
   * 只有 cardId 恰好是宿主规范 feed-<itemId>-r<revision> 才继续读完整正文分片，
   * 返回额外带上 html；options.isCurrent 用于在失效后停止后续分片。
   */
  async function card(itemId, revision, options = {}) {
    const id = assertItemIdArg(itemId, 'itemId');
    const requested = assertRevisionArg(revision, 'revision');
    const settings = isObject(options) ? options : {};
    const template = settings.template;
    const isCurrent = settings.isCurrent;
    if (template !== undefined && template !== null && (typeof template !== 'string' || template === '')) {
      fail('feed_invalid_argument', 'options.template 必须是非空字符串');
    }
    if (isCurrent !== undefined && isCurrent !== null && typeof isCurrent !== 'function') {
      fail('feed_invalid_argument', 'options.isCurrent 必须是函数');
    }

    const body = await call(`/api/feed/items/${encodeURIComponent(id)}/card`, { method: 'POST' });
    if (!isObject(body)) fail('feed_protocol_error', '卡片响应不是对象');
    const cardId = readText(body.cardId, 'cardId', { allowEmpty: false });
    const minted = readRevision(body.revision, 'revision');
    const hasDocument = body.documentPath !== undefined && body.documentPath !== null;
    if (hasDocument) readText(body.documentPath, 'documentPath', { allowEmpty: false });
    if (minted !== requested) {
      fail(
        'feed_card_revision_mismatch',
        `卡片版本已变化（请求 r${requested}，宿主返回 r${minted}），应刷新条目后重试`,
      );
    }
    if (hasDocument) return { cardId, revision: minted, url: `/gw/feed/${id}/r${minted}/` };
    if (template === NATIVE_DOCUMENT_TEMPLATE) {
      // cardId 是分片请求路径的一段：必须与 feed-<itemId>-r<revision> 严格相等，
      // 否则宿主可能把别的条目的正文交给我们。
      const canonical = `feed-${id}-r${minted}`;
      if (cardId !== canonical) {
        fail(
          'feed_card_binding_mismatch',
          `宿主返回的卡片 ID 与条目/版本不对应（期望 ${canonical}）`,
        );
      }
      const html = await readNativeDocument(cardId, { isCurrent });
      return { cardId, revision: minted, url: null, html };
    }
    return { cardId, revision: minted, url: null };
  }

  /** 阅读信号：一次 1–100 条，宿主按信号对判断已读。 */
  async function signals(signals) {
    if (!Array.isArray(signals) || signals.length < 1 || signals.length > MAX_SIGNALS) {
      fail('feed_invalid_argument', `阅读信号必须一次发送 1–${MAX_SIGNALS} 条`);
    }
    const normalized = signals.map((signal, index) => normalizeSignalArgument(signal, `signals[${index}]`));
    const body = await call('/api/feed/signals', {
      method: 'POST',
      body: JSON.stringify({ clientKind: CLIENT_KIND, signals: normalized }),
    });
    if (!isObject(body)) fail('feed_protocol_error', '信号响应不是对象');
    return {
      accepted: readCount(body.accepted, 'accepted'),
      unreadTaskCount: readCount(body.unreadTaskCount, 'unreadTaskCount'),
    };
  }

  /** 收藏/取消收藏：PUT 与 DELETE 都带 clientKind body（宿主按 body 判身份）。 */
  async function favorite(itemId, value) {
    const id = assertItemIdArg(itemId, 'itemId');
    if (typeof value !== 'boolean') fail('feed_invalid_argument', 'favorite 需要 true/false');
    const body = await call(`/api/feed/items/${encodeURIComponent(id)}/favorite`, {
      method: value ? 'PUT' : 'DELETE',
      body: JSON.stringify({ clientKind: CLIENT_KIND }),
    });
    if (!isObject(body)) fail('feed_protocol_error', '收藏响应不是对象');
    return { favorite: readBool(body.favorite, 'favorite') };
  }

  /** 隐藏条目：宿主返回 hiddenAt，成功即从列表移除。 */
  async function hide(itemId) {
    const id = assertItemIdArg(itemId, 'itemId');
    const body = await call(`/api/feed/items/${encodeURIComponent(id)}/hide`, {
      method: 'POST',
      body: JSON.stringify({ clientKind: CLIENT_KIND }),
    });
    if (!isObject(body)) fail('feed_protocol_error', '隐藏响应不是对象');
    return { hiddenAt: readText(body.hiddenAt, 'hiddenAt', { allowEmpty: false }) };
  }

  /** 处理待办：发送宿主给出的 action.id，绝不硬编码 done/dismiss。 */
  async function task(itemId, actionId) {
    const id = assertItemIdArg(itemId, 'itemId');
    const action = assertTextArg(actionId, 'actionId');
    const body = await call(`/api/feed/items/${encodeURIComponent(id)}/task`, {
      method: 'POST',
      body: JSON.stringify({ clientKind: CLIENT_KIND, actionId: action }),
    });
    if (!isObject(body)) fail('feed_protocol_error', '任务响应不是对象');
    return { task: normalizeTask(body.task, 'task') };
  }

  /** 追问前冻结卡片：返回的 id/revision 必须就是请求的那一条，否则不能拿去发 WS。 */
  async function prepare(sessionId, itemId, revision) {
    const session = assertTextArg(sessionId, 'sessionId');
    const id = assertItemIdArg(itemId, 'itemId');
    const wanted = assertRevisionArg(revision, 'revision');
    const body = await call('/api/feed/send/prepare', {
      method: 'POST',
      body: JSON.stringify({ sessionId: session, feedItemId: id, revision: wanted }),
    });
    if (!isObject(body)) fail('feed_protocol_error', 'prepare 响应不是对象');
    if (body.ok !== true) {
      const code = typeof body.error === 'string' && body.error ? body.error : 'feed_protocol_error';
      const message = typeof body.message === 'string' && body.message ? body.message : '宿主没有冻结卡片引用';
      fail(code, message);
    }
    if (!isObject(body.feedCard)) fail('feed_protocol_error', 'prepare 响应缺少 feedCard');
    const frozen = body.feedCard;
    const frozenItemId = readItemId(frozen.itemId, 'prepare.feedCard.itemId');
    const frozenRevision = readRevision(frozen.revision, 'prepare.feedCard.revision');
    const title = readText(frozen.title, 'prepare.feedCard.title');
    if (frozenItemId !== id || frozenRevision !== wanted) {
      fail(
        'feed_prepare_mismatch',
        `prepare 返回的卡片与请求不一致（请求 ${id}/r${wanted}，返回 ${frozenItemId}/r${frozenRevision}）`,
      );
    }
    return { itemId: frozenItemId, revision: frozenRevision, title };
  }

  return { slate, item, card, signals, favorite, hide, task, prepare };
}
