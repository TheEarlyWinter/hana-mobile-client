/**
 * 网关结构化日志：JSON Lines、按天滚、按大小切段、字段白名单 + 脱敏。
 *
 * 设计约束（出问题时 agent 要靠它自己查清发生了什么）：
 *   - 每条记录一行 JSON，字段固定；未知字段一律丢弃（顺带保证不把请求/响应正文写进来）；
 *   - 文件名 `gateway-YYYY-MM-DD.jsonl`（本地时区），单文件超过 maxBytes（默认 5MB）就
 *     顺延到 `gateway-YYYY-MM-DD.1.jsonl`、`.2` …：序号只增不减，所以「谁更旧」看文件名
 *     就能判，不依赖 mtime；
 *   - 目录里只保留最近 keepFiles 份（默认 5），更旧的删掉 —— 单文件上限 × 保留份数就是
 *     这块日志的硬上限（默认 25MB），跑多久都不会把磁盘写满；
 *   - 清理只碰自己命名规则的文件，绝不碰目录里的其它东西；正在写的那一份永远不删；
 *   - 轮转判断是「已知字节数累加 + 阈值比较」，阈值内不 stat：只有进程启动后第一次写到
 *     某一天（扫一次目录找当天最新段，并顺带按份数清一次）、以及碰到缓存里没有的文件时才 stat；
 *   - 删除失败的旧文件留到下一轮滚动再试，不影响当前这一批写入；
 *   - 写盘失败不影响请求：`log()` 永不抛，失败只在 stderr 留一行；
 *   - 任何字段值写出前都过一遍脱敏：Bearer 令牌、`?token=` 片段、header 形式的
 *     cookie/token/password/secret 值、卡片短时令牌。
 *
 * 同一 tick 内的多次 `log()` 会合并成一次 append（顺序保持不变），避免每个请求
 * 都触发一次写盘。
 */

import defaultFs from 'node:fs/promises';
import path from 'node:path';

const LEVELS = new Set(['info', 'warn', 'error']);
const KINDS = new Set(['http', 'ws', 'lifecycle']);
const WS_EVENTS = new Set(['open', 'close', 'error']);
const LIFECYCLE_EVENTS = new Set(['start', 'stop', 'config']);

/** 单文件上限与保留份数：两者相乘就是日志目录的硬上限（默认 5 × 5MB = 25MB）。 */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP_FILES = 5;
/** 额外的按天保留期：闲置时把很久以前的日志清掉，正常写入时份数上限先生效。 */
const DEFAULT_RETENTION_DAYS = 14;
const TEXT_MAX = 300;
const REDACTED = '[redacted]';

/** 只认自己写出来的文件名；`prune()` 也只按这个规则删。 */
const LOG_FILE_RE = /^gateway-(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?\.jsonl$/;

/**
 * 脱敏规则按顺序执行；替换完再跑一遍，覆盖 `cookie=token=...` 这类嵌套写法。
 * 目标不是完美解析，而是保证常见泄露形态（URL、header 转储、错误消息）不落盘。
 */
const REDACT_RULES = [
  [/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`],
  [
    /("(?:authorization|set-cookie|cookie|token|password|secret)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    `$1"${REDACTED}"`,
  ],
  [
    /([?&](?:access_token|refresh_token|api[-_]?key|token|password|passwd|secret|auth|key|code)=)[^&#\s]*/gi,
    `$1${REDACTED}`,
  ],
  // header/键值形式：值取到行尾（cookie 可能有多段、authorization 可能带 Basic 等 scheme）。
  [
    /(\b(?:authorization|set-cookie|cookie|access[-_]?token|refresh[-_]?token|api[-_]?key|token|password|passwd|secret|auth)\s*[=:]\s*)[^\r\n]*/gi,
    `$1${REDACTED}`,
  ],
  // 卡片短时令牌（card-host 的 t_<43 位 base64url>）也不该出现在日志里。
  [/\bt_[A-Za-z0-9_-]{43}\b/g, `t_${REDACTED}`],
];

function redactText(value) {
  let text = String(value);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [pattern, replacement] of REDACT_RULES) {
      text = text.replace(pattern, replacement);
    }
  }
  return text;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** ISO 8601，带本地时区偏移（例如 2026-11-05T17:14:00.000+08:00）。 */
function formatTimestamp(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `.${String(date.getMilliseconds()).padStart(3, '0')}${offset}`
  );
}

/** 本地日期键 `YYYY-MM-DD`，同时用于文件名和保留期比较。 */
function dateKeyOf(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function toDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/** HTTP 日志只留 pathname：query 里经常有令牌，且对定位问题没有额外价值。 */
function stripQuery(rawPath) {
  const value = String(rawPath);
  if (!value) return value;
  const looksAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
  if (!looksAbsolute && !value.startsWith('/')) {
    return value.split('?')[0].split('#')[0];
  }
  try {
    return new URL(value, 'http://gateway.local').pathname || '/';
  } catch {
    return value.split('?')[0].split('#')[0];
  }
}

function oneLineText(value) {
  return String(value)
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function segmentName(dateKey, index) {
  return index === 0
    ? `gateway-${dateKey}.jsonl`
    : `gateway-${dateKey}.${index}.jsonl`;
}

/**
 * @param {{
 *   dir?: string,
 *   now?: () => Date,
 *   retentionDays?: number,
 *   maxBytes?: number,
 *   keepFiles?: number,
 *   fs?: typeof import('node:fs/promises'),
 * }} options
 */
export function createLogger(options = {}) {
  const fs = options.fs || defaultFs;
  const dir = path.resolve(String(options.dir || path.join('gateway', 'logs')));
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const retentionDays =
    Number.isFinite(options.retentionDays) && options.retentionDays >= 0
      ? Math.floor(options.retentionDays)
      : DEFAULT_RETENTION_DAYS;
  const maxBytes =
    Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : DEFAULT_MAX_BYTES;
  const keepFiles =
    Number.isFinite(options.keepFiles) && options.keepFiles > 0
      ? Math.floor(options.keepFiles)
      : DEFAULT_KEEP_FILES;

  /** @type {{ dateKey: string, line: string }[]} */
  let pending = [];
  let flushScheduled = false;
  let writing = Promise.resolve();
  let dirReady = false;

  /** 已写文件的字节数（累加记账）：阈内判断只看它，不做 stat。 */
  const sizes = new Map();
  /** 当天当前使用的段 (dateKey -> { index, file })：序号只增，避免重启后回到写满的 base。 */
  const active = new Map();
  /** 有段滚动过就置位，落盘后按份数清一次；扫目录不会发生在每个请求上。 */
  let needPrune = false;

  function reportFailure(err) {
    // 只有这一行；不把失败批次的内容再打一遍（里面可能本来就有敏感信息）。
    // stderr 本身出问题也不能反过来影响请求，所以这里再兜一层。
    try {
      const message = err && err.message ? err.message : String(err);
      console.error(`[gateway-log] write failed: ${message}`);
    } catch {
      // ignore
    }
  }

  async function ensureDir() {
    if (dirReady) return;
    await fs.mkdir(dir, { recursive: true });
    dirReady = true;
  }

  async function sizeOf(file) {
    if (sizes.has(file)) return sizes.get(file);
    let size = 0;
    try {
      const stat = await fs.stat(file);
      size = Number(stat && stat.size) || 0;
    } catch {
      size = 0;
    }
    sizes.set(file, size);
    return size;
  }

  /** 目录里符合自己命名规则的文件；顺序未定，调用方自己排。 */
  async function readLogFiles() {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      // 目录还没建出来是正常状态（第一次启动）；其它错误留一行提示。
      if (err && err.code !== 'ENOENT') reportFailure(err);
      return [];
    }
    const files = [];
    for (const name of names) {
      const match = LOG_FILE_RE.exec(String(name));
      if (!match) continue;
      files.push({
        name: String(name),
        file: path.join(dir, String(name)),
        dateKey: `${match[1]}-${match[2]}-${match[3]}`,
        index: match[4] === undefined ? 0 : Number(match[4]),
      });
    }
    return files;
  }

  /**
   * 进程内第一次写某一天：找当天已存在的最新段。
   *   - 它还有空间就接着写（重启不会另起一段白占一份保留额度）；
   *   - 已经写满就从它的下一个序号开始（绝不回头写更旧的序号：那会让文件名顺序变歧义）。
   * 只有这里会扫一次目录，之后全靠内存里的 active。
   *
   * 跨天第一次写也顺手置 needPrune：低流量时一天只有一份小的、永远碰不到 5MB 滚动，
   * 不在这里清就会一天攒一份，份数上限变成空文。
   */
  async function ensureActiveFile(dateKey, bytes) {
    const known = active.get(dateKey);
    if (known) return known;

    let index = 0;
    const sameDay = (await readLogFiles()).filter((item) => item.dateKey === dateKey);
    if (sameDay.length > 0) {
      sameDay.sort((a, b) => a.index - b.index);
      const last = sameDay[sameDay.length - 1];
      const size = await sizeOf(last.file);
      index = size === 0 || size + bytes <= maxBytes ? last.index : last.index + 1;
    }

    const state = { index, file: path.join(dir, segmentName(dateKey, index)) };
    active.set(dateKey, state);
    needPrune = true;
    return state;
  }

  /**
   * 选当天的写入段：
   *   - 空段/不存在直接用（即使这一批比 maxBytes 还大，也不能丢）；
   *   - 放不下就顺延到下一段，并把 needPrune 置位（落盘后按份数清一次）。
   */
  async function pickFile(dateKey, bytes, reserved) {
    const state = await ensureActiveFile(dateKey, bytes);
    for (;;) {
      const used = (await sizeOf(state.file)) + (reserved.get(state.file) || 0);
      if (used === 0 || used + bytes <= maxBytes) return state.file;
      state.index += 1;
      state.file = path.join(dir, segmentName(dateKey, state.index));
      needPrune = true;
    }
  }

  async function appendChunk(file, data, bytes) {
    await fs.appendFile(file, data, 'utf8');
    sizes.set(file, (sizes.get(file) || 0) + bytes);
  }

  async function writeBatch(items) {
    await ensureDir();
    // 同一批里也要按 maxBytes 切段：先记账再落盘，避免把整批都塞进同一个文件。
    const reserved = new Map();
    let cursor = 0;
    while (cursor < items.length) {
      const { dateKey } = items[cursor];
      let file = null;
      let lines = [];
      let bytes = 0;
      while (cursor < items.length && items[cursor].dateKey === dateKey) {
        const { line } = items[cursor];
        const lineBytes = Buffer.byteLength(line, 'utf8');
        const target = await pickFile(dateKey, lineBytes, reserved);
        if (file && target !== file) {
          await appendChunk(file, lines.join(''), bytes);
          reserved.delete(file);
          lines = [];
          bytes = 0;
        }
        file = target;
        lines.push(line);
        bytes += lineBytes;
        reserved.set(file, (reserved.get(file) || 0) + lineBytes);
        cursor += 1;
      }
      if (file) await appendChunk(file, lines.join(''), bytes);
    }
    // 滚动才清，不是每批都扫目录：5MB 一次，代价可以忽略。
    if (needPrune) {
      needPrune = false;
      await pruneByCount();
    }
  }

  function enqueuePending() {
    if (pending.length === 0) return writing;
    const batch = pending;
    pending = [];
    writing = writing.then(() => writeBatch(batch)).catch(reportFailure);
    return writing;
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      enqueuePending();
    });
  }

  function putText(record, key, raw, { oneLine = false, max = 0 } = {}) {
    if (raw === undefined || raw === null) return;
    let text = typeof raw === 'string' ? raw : String(raw);
    if (oneLine) text = oneLineText(text);
    text = redactText(text);
    if (max > 0) text = Array.from(text).slice(0, max).join('');
    if (text === '') return;
    record[key] = text;
  }

  function putNumber(record, key, raw) {
    if (raw === undefined || raw === null || raw === '') return;
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value)) return;
    record[key] = Math.round(value);
  }

  function buildRecord(entry, date) {
    const level = LEVELS.has(entry.level) ? entry.level : 'info';
    const kind = KINDS.has(entry.kind) ? entry.kind : 'lifecycle';
    const record = { ts: formatTimestamp(date), level, kind };

    if (kind === 'http') {
      putText(record, 'method', entry.method);
      if (entry.path !== undefined && entry.path !== null && entry.path !== '') {
        putText(record, 'path', stripQuery(entry.path));
      }
      putNumber(record, 'status', entry.status);
      putNumber(record, 'ms', entry.ms);
      putText(record, 'requestId', entry.requestId);
      // 客户端地址：手机与记录本机请求混在一起时，靠它分清这条是谁打的（原来只在 console 里）。
      putText(record, 'ip', entry.ip);
    } else if (kind === 'ws') {
      if (WS_EVENTS.has(entry.event)) record.event = entry.event;
      putNumber(record, 'ms', entry.ms);
      putNumber(record, 'code', entry.code);
    } else {
      if (LIFECYCLE_EVENTS.has(entry.event)) record.event = entry.event;
      // port/pid 用来分辨某行是哪个网关实例写的（真网关与测试网关日志一旦混在一起，没有这两个字段很难认）。
      putNumber(record, 'port', entry.port);
      putNumber(record, 'pid', entry.pid);
      putText(record, 'detail', entry.detail, { oneLine: true, max: TEXT_MAX });
    }

    // 错误字段不分 kind：HTTP 5xx 和 WS error 都要能按 errorCode 查。
    putText(record, 'errorCode', entry.errorCode);
    putText(record, 'error', entry.error, { oneLine: true, max: TEXT_MAX });
    return record;
  }

  /** 永不抛：解析/脱敏/排队任何一步出错都只回落到 stderr 一行。 */
  function log(entry) {
    try {
      const date = toDate(now());
      const record = buildRecord(entry && typeof entry === 'object' ? entry : {}, date);
      pending.push({ dateKey: dateKeyOf(date), line: `${JSON.stringify(record)}\n` });
      scheduleFlush();
    } catch (err) {
      reportFailure(err);
    }
  }

  /** 把当前缓冲写掉；返回的 Promise 不会 reject，失败已经回落到 stderr。 */
  async function flush() {
    await enqueuePending();
  }

  /** 删除超过 retentionDays 的日志；只动 gateway-YYYY-MM-DD[.n].jsonl。 */
  async function pruneByAge() {
    let removed = 0;
    const files = await readLogFiles();

    const cutoff = new Date(toDate(now()).getTime());
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffKey = dateKeyOf(cutoff);

    for (const item of files) {
      if (item.dateKey >= cutoffKey) continue;
      try {
        await fs.unlink(item.file);
        sizes.delete(item.file);
        removed += 1;
      } catch {
        // 单个文件删不掉（被占用等）不影响其它文件，也不影响网关运行。
      }
    }
    return removed;
  }

  /**
   * 只留最近 keepFiles 份：这是磁盘占用的硬上限（单文件上限 × 份数）。
   * 「最近」按文件名里的 (日期, 序号) 判，不看 mtime —— 序号只增不减，重启/并发写得乱也不会误删最新的。
   * 正在写的那一份永远跳过。
   */
  async function pruneByCount() {
    const files = await readLogFiles();
    if (files.length <= keepFiles) return 0;

    const writing = new Set([...active.values()].map((state) => path.resolve(state.file)));
    files.sort((a, b) => {
      if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? -1 : 1;
      return a.index - b.index;
    });

    let excess = files.length - keepFiles;
    let removed = 0;
    for (const item of files) {
      if (excess <= 0) break;
      if (writing.has(path.resolve(item.file))) continue;
      try {
        await fs.unlink(item.file);
        sizes.delete(item.file);
        excess -= 1;
        removed += 1;
      } catch {
        // 删不掉的留到下一轮滚动再试，不影响当前写入。
      }
    }
    return removed;
  }

  /** 启动时清一次：先按天，再按份数（份数上限保证磁盘不会被写满）。永不 reject。 */
  async function prune() {
    const byAge = await pruneByAge();
    const byCount = await pruneByCount();
    return byAge + byCount;
  }

  return { log, flush, prune };
}
