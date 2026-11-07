/* web/workspace-service.js
 *
 * 工作区服务层契约与通信实现。
 * 负责与后端 /api/mobile/workspace/* 交互，包含真实根发现、文件查询、有界分块读取、
 * 保守顺序上传以及同源下载 URL 构建。
 *
 * 预览限制（宿主实测）：本地 content-chunk 响应没有 version，无法检测同尺寸并发改写；
 * 文件 >20MiB 会被宿主直接 413，文本也只能下载，不能声称能截断所有大文本。
 * 纯预览不是事务快照。
 */

/** 移动端保守上传上限：单文件 <= 10MiB */
export const MOBILE_MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024;
/** 移动端保守上传上限：总大小 <= 20MiB */
export const MOBILE_MAX_TOTAL_UPLOAD_BYTES = 20 * 1024 * 1024;
/** 移动端单次最多上传文件数 */
export const MOBILE_MAX_UPLOAD_FILES_COUNT = 10;

/** 安全预览单文件拉取上限：8MiB */
export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
/** 安全预览分块拉取最大轮数：128 轮 (128 * 64KiB = 8MiB) */
export const PREVIEW_MAX_CHUNKS = 128;
/** 纯文本只读截断上限：64KiB */
export const TEXT_PREVIEW_MAX_BYTES = 64 * 1024;

/**
 * 校验并清洗文件名。
 * 拒绝空、点、双点、路径分隔符、控制字符；保留原合法文件名，不进行二次 URL decode。
 */
export function validateFileName(name) {
  if (typeof name !== 'string') {
    const err = new Error('invalid_file_name: file name must be a string');
    err.code = 'invalid_file_name';
    throw err;
  }
  const s = name;
  if (!s || s === '.' || s === '..') {
    const err = new Error('invalid_file_name: file name cannot be empty, "." or ".."');
    err.code = 'invalid_file_name';
    throw err;
  }
  // 首尾空白会改变磁盘上的真实文件名（Windows 会静默 trim），这里整体拒绝，绝不 trim 后上传
  if (s.trim() !== s) {
    const err = new Error('invalid_file_name: file name cannot have leading or trailing whitespace');
    err.code = 'invalid_file_name';
    throw err;
  }
  if (s.includes('/') || s.includes('\\')) {
    const err = new Error('invalid_file_name: file name cannot contain path separators');
    err.code = 'invalid_file_name';
    throw err;
  }
  // 拦截 ASCII 控制字符 (0-31 及 127)
  if (/[\x00-\x1F\x7F]/.test(s)) {
    const err = new Error('invalid_file_name: file name cannot contain control characters');
    err.code = 'invalid_file_name';
    throw err;
  }
  return s;
}

/**
 * 规范化并清洗子目录路径。
 * 严格拒绝绝对路径（以斜杠开头）、驱动器盘符（如 C:）及 UNC 路径（如 \\server）；
 * 统一替换反斜杠为斜杠，过滤前后空白与斜杠；严格拦截包含 ".." 的路径逃逸。
 */
export function normalizeSubdir(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  const raw = p.trim();

  // 严格拦截 UNC 路径 (e.g. \\server\share 或 //server/share)
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    const err = new Error('unc_path_rejected: UNC paths are not allowed in subdir');
    err.code = 'unc_path_rejected';
    throw err;
  }

  // 严格拦截以斜杠或反斜杠开头的绝对路径（不得静默转成相对路径）
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    const err = new Error('absolute_path_rejected: absolute paths are not allowed in subdir');
    err.code = 'absolute_path_rejected';
    throw err;
  }

  // 严格拦截 Windows 驱动器盘符 (e.g. C:, D:)
  if (/^[a-zA-Z]:/.test(raw)) {
    const err = new Error('drive_path_rejected: drive letters are not allowed in subdir');
    err.code = 'drive_path_rejected';
    throw err;
  }

  const normalized = raw.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  for (const part of parts) {
    if (part === '..') {
      const err = new Error('path_traversal: path cannot contain ".."');
      err.code = 'path_traversal';
      throw err;
    }
  }
  return parts.join('/');
}

/**
 * 根据文件头部的 Magic Bytes 嗅探光栅图片 MIME。
 * 仅允许已验证的安全光栅图片格式，防止利用扩展名欺骗。
 */
export function detectRasterImageMime(bytes) {
  if (!bytes || bytes.length < 4) return null;
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'image/jpeg';
  }
  // GIF: 47 49 46 38
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  // WEBP: 52 49 46 46 (RIFF) ... 57 45 42 50 (WEBP)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // BMP: 42 4D
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
    return 'image/bmp';
  }
  // AVIF: ftypavif / ftypavis
  if (bytes.length >= 12) {
    const box = String.fromCharCode(...bytes.slice(4, 12));
    if (box.includes('ftyp') && (box.includes('avif') || box.includes('avis'))) {
      return 'image/avif';
    }
  }
  return null;
}

/**
 * 判定文件是否属于支持纯文本安全预览的格式。
 * 包含代码、文档、配置及标量数据文件。
 */
export function isTextPreviewable(name) {
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  const textExts = [
    '.txt', '.md', '.markdown', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
    '.css', '.scss', '.less', '.html', '.htm', '.svg', '.xml', '.yaml', '.yml',
    '.log', '.sh', '.ps1', '.py', '.rb', '.rs', '.go', '.java', '.c', '.cpp', '.h',
    '.hpp', '.sql', '.toml', '.ini', '.env', '.gitignore'
  ];
  return textExts.some(ext => lower.endsWith(ext));
}

/**
 * 严格标准 Base64 解码。
 * Node 的 Buffer.from(..., 'base64') 会静默跳过非法字符并接受错误填充，
 * 所以必须先做字符/长度检查，再用重新编码比对，确认是规范编码。
 */
function base64ToUint8Array(b64) {
  if (b64 == null) b64 = '';
  if (typeof b64 !== 'string') {
    const err = new Error('invalid_base64: chunk data must be a string');
    err.code = 'invalid_base64';
    throw err;
  }
  if (b64.length === 0) return new Uint8Array(0);

  const validShape =
    b64.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64);
  if (!validShape) {
    const err = new Error('invalid_base64: chunk data is not standard Base64');
    err.code = 'invalid_base64';
    throw err;
  }

  let bytes;
  let canonical;
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    bytes = new Uint8Array(buf);
    canonical = buf.toString('base64');
  } else {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    canonical = btoa(bin);
  }

  // 拒绝非规范填充位（如 "QR==" 解码成 A 但规范写法是 "QQ=="）
  if (canonical !== b64) {
    const err = new Error('invalid_base64: chunk data is not canonical Base64');
    err.code = 'invalid_base64';
    throw err;
  }
  return bytes;
}

function chunkError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/** 版本值可能是字符串，也可能是对象；按稳定 JSON（对象键排序）比较内容而非引用。 */
function canonicalVersion(version) {
  if (version === undefined || version === null) return null;
  const sortValue = (value) => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
      return out;
    }
    return value;
  };
  try {
    return JSON.stringify(sortValue(version));
  } catch (_) {
    return String(version);
  }
}

function assertNonNegativeSafeInteger(value, code, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw chunkError(code, `${label} must be a non-negative safe integer`);
  }
}

/**
 * 严格校验并解析单块响应。
 * 所有字段都以服务端 body 为准，绝不使用“声明长度”代替真实 decoded 长度。
 */
function parseChunkResponse(chunk, { requestedOffset, maxLength, expectedTotal, expectedVersion, first }) {
  if (!chunk || chunk.ok !== true) {
    throw chunkError('chunk_read_failed', 'failed to read file chunk');
  }

  assertNonNegativeSafeInteger(chunk.offset, 'invalid_offset', 'chunk.offset');
  if (chunk.offset !== requestedOffset) {
    throw chunkError(
      'offset_mismatch',
      `expected chunk offset ${requestedOffset}, but received ${chunk.offset}`
    );
  }

  assertNonNegativeSafeInteger(chunk.length, 'invalid_length', 'chunk.length');
  if (chunk.length > maxLength) {
    throw chunkError(
      'length_exceeds_max',
      `chunk.length ${chunk.length} exceeds this round maxLength ${maxLength}`
    );
  }

  assertNonNegativeSafeInteger(chunk.totalBytes, 'invalid_total_bytes', 'chunk.totalBytes');
  if (!first && chunk.totalBytes !== expectedTotal) {
    throw chunkError(
      'total_bytes_changed',
      `totalBytes changed from ${expectedTotal} to ${chunk.totalBytes} during chunk reading`
    );
  }

  if (typeof chunk.eof !== 'boolean') {
    throw chunkError('invalid_eof', 'chunk.eof must be a boolean');
  }

  const bytes = base64ToUint8Array(chunk.data);
  if (bytes.length !== chunk.length) {
    throw chunkError(
      'length_mismatch',
      `decoded bytes length ${bytes.length} does not match chunk.length ${chunk.length}`
    );
  }

  if (chunk.offset + chunk.length > chunk.totalBytes) {
    throw chunkError('chunk_overrun', 'chunk extends beyond totalBytes');
  }

  const computedEof = chunk.offset + chunk.length >= chunk.totalBytes;
  if (chunk.eof !== computedEof) {
    throw chunkError(
      'eof_mismatch',
      `chunk.eof ${chunk.eof} does not match offset ${chunk.offset} + length ${chunk.length} >= total ${chunk.totalBytes}`
    );
  }

  if (chunk.length === 0 && !chunk.eof) {
    throw chunkError('zero_progress', 'received 0 bytes before EOF');
  }

  const version = canonicalVersion(chunk.version);
  if (!first && version !== expectedVersion) {
    throw chunkError('version_conflict', 'file content changed during chunk reading');
  }

  return {
    bytes,
    length: chunk.length,
    totalBytes: chunk.totalBytes,
    version,
  };
}

/**
 * 创建工作区服务客户端实例。
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - fetch 实现（默认读取 globalThis.fetch）
 * @param {number} [options.timeoutMs=15000] - 网络请求超时时间
 */
export function createWorkspaceService({ fetchImpl, timeoutMs = 15000 } = {}) {
  const getFetch = () => fetchImpl || globalThis.fetch;

  async function request(url, init = {}) {
    const fn = getFetch();
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const mergedSignal = init.signal || controller?.signal;
    let timer = null;
    const timeoutValue = Number(timeoutMs);
    const effectiveTimeout = Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : 0;

    // 实际网络工作。超时不能只靠 AbortController：mock/宿主可能忽略 signal，
    // 或者响应头已到、res.json() 永远不解析，此时必须由外层的有限 race 结束 Promise。
    const work = (async () => {
      const res = await fn(url, { ...init, signal: mergedSignal });
      if (!res.ok) {
        let bodyData;
        try {
          bodyData = await res.json();
        } catch (_) {
          try {
            bodyData = await res.text();
          } catch (_) {
            bodyData = '';
          }
        }
        const err = new Error(
          `HTTP ${res.status} ${res.statusText}${
            bodyData ? ': ' + (typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData)) : ''
          }`
        );
        err.status = res.status;
        err.data = bodyData;
        throw err;
      }
      return await res.json();
    })();

    let timeoutPromise = null;
    if (effectiveTimeout > 0) {
      timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const timeoutErr = new Error(
            `request_timeout: request to ${url} timed out after ${effectiveTimeout}ms`
          );
          timeoutErr.name = 'AbortError';
          timeoutErr.code = 'request_timeout';
          try {
            controller?.abort(timeoutErr);
          } catch (_) {
            // abort 失败不影响下面的 reject，race 仍然有界
          }
          reject(timeoutErr);
        }, effectiveTimeout);
      });
    }

    try {
      return timeoutPromise ? await Promise.race([work, timeoutPromise]) : await work;
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'request_timeout') {
        const timeoutErr = new Error(`request_timeout: request to ${url} timed out`);
        timeoutErr.code = 'request_timeout';
        throw timeoutErr;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function validateContext(context) {
    const mountId = context?.mountId || 'default';
    const agentId = context?.agentId || '';
    if (mountId === 'default' && !agentId) {
      const err = new Error('agent_id_required: default root requires an explicit agentId');
      err.code = 'agent_id_required';
      throw err;
    }
    return { mountId, agentId };
  }

  /**
   * 读取工作室真实工作区根列表。
   * 数据源是 GET /api/studio/workspaces（files.read），不是 bootstrap 推断。
   * 响应里的 mountId 才是工作区根身份；这里不构造任何文件系统路径。
   */
  async function listRoots() {
    const data = await request('/api/studio/workspaces');

    if (data && (data.ok === false || (typeof data.error === 'string' && data.error))) {
      const err = new Error(data.error || 'list_roots_failed');
      err.code = data.error || 'list_roots_failed';
      throw err;
    }
    if (!data || !Array.isArray(data.workspaces)) {
      const err = new Error('invalid_roots_response: workspaces must be an array');
      err.code = 'invalid_roots_response';
      throw err;
    }

    const workspaces = [];
    for (const item of data.workspaces) {
      if (!item || typeof item !== 'object') continue;
      const mountId = typeof item.mountId === 'string' ? item.mountId : '';
      if (!mountId.trim()) continue; // 没有 mountId 的条目不可选，绝不猜路径
      workspaces.push({
        ...item,
        workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId : '',
        mountId,
        label: typeof item.label === 'string' && item.label ? item.label : mountId,
      });
    }

    return {
      ok: true,
      studioId: data.studioId ?? null,
      localDeviceName: typeof data.localDeviceName === 'string' ? data.localDeviceName : '',
      workspaces,
    };
  }

  /**
   * 拉取指定工作区子目录的文件列表。
   *
   * @param {object} context - { mountId, agentId }
   * @param {string} [subdir=''] - 目标子目录
   */
  async function list(context, subdir = '') {
    const { mountId, agentId } = validateContext(context);
    const cleanSubdir = normalizeSubdir(subdir);

    const q = new URLSearchParams();
    q.set('mountId', mountId);
    if (agentId) q.set('agentId', agentId);
    if (cleanSubdir) q.set('subdir', cleanSubdir);

    const queryString = q.toString().replace(/\+/g, '%20');
    const data = await request(`/api/mobile/workspace/files?${queryString}`);

    // HTTP 200 ok: false 或包含 error 时抛出异常，绝不伪造 ok: true
    if (data && data.ok === false) {
      const err = new Error(data.error || 'list_files_failed');
      err.code = data.error || 'list_files_failed';
      throw err;
    }

    return {
      ok: true,
      rootId: data.rootId || mountId,
      mountId: data.mountId || mountId,
      subdir: data.subdir || cleanSubdir,
      files: Array.isArray(data.files) ? data.files : [],
      agentId: data.agentId || agentId,
    };
  }

  /**
   * 单块拉取文件内容片段。
   *
   * @param {object} context - { mountId, agentId }
   * @param {object} params - { subdir, name, offset, maxLength }
   */
  async function previewChunk(context, { subdir = '', name, offset = 0, maxLength = 64 * 1024 } = {}) {
    const { mountId, agentId } = validateContext(context);
    const cleanName = validateFileName(name);
    const cleanSubdir = normalizeSubdir(subdir);
    assertNonNegativeSafeInteger(offset, 'invalid_offset', 'offset');
    assertNonNegativeSafeInteger(maxLength, 'invalid_max_length', 'maxLength');

    // 宿主 dct handler（bundle index.js:163812-163838）只读 offset/maxLength，
    // 不识别 versioned，也没有 metadataOnly；不要发送不存在的字段。
    const q = new URLSearchParams();
    q.set('mountId', mountId);
    if (agentId) q.set('agentId', agentId);
    if (cleanSubdir) q.set('subdir', cleanSubdir);
    q.set('name', cleanName);
    q.set('offset', String(offset));
    q.set('maxLength', String(maxLength));

    const queryString = q.toString().replace(/\+/g, '%20');
    return request(`/api/mobile/workspace/content-chunk?${queryString}`);
  }

  /**
   * 纯文本专用有界分块读取（最多拉取 maxBytes <= 64KiB），绝不为了读文本拉取 8MiB 全量。
   *
   * 宿主限制（已亲读 dct/b5）：content-chunk 对 >20MiB 文件直接 413 file_too_large，
   * 文本也无法分块截断，只能走下载；64KiB 上限只适用于宿主允许读取的文件。
   * 响应没有 version 时，即使每块 totalBytes 相同，也无法检测同尺寸并发改写；
   * 这里是有界预览，不是事务快照。
   *
   * @param {object} context - { mountId, agentId }
   * @param {object} params - { subdir, name, maxBytes }
   */
  async function readTextPreview(context, { subdir = '', name, maxBytes = TEXT_PREVIEW_MAX_BYTES } = {}) {
    const requestedCap =
      Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? maxBytes : TEXT_PREVIEW_MAX_BYTES;
    const capBytes = Math.min(requestedCap, TEXT_PREVIEW_MAX_BYTES);
    let offset = 0;
    let expectedVersion = null;
    let totalBytes = null;
    const byteChunks = [];
    let accumulatedLength = 0;
    let complete = false;

    if (capBytes === 0) {
      return {
        ok: true,
        filename: name,
        text: '',
        truncated: true,
        totalBytes: null,
      };
    }

    // 文本拉取最多 8 轮；每轮仍受 64KiB 硬上限约束，服务端返回多大都不信声明值。
    const maxRounds = 8;
    for (let round = 0; round < maxRounds; round += 1) {
      if (accumulatedLength >= capBytes) {
        complete = true;
        break;
      }

      const needed = capBytes - accumulatedLength;
      const maxLength = Math.min(64 * 1024, needed);
      const chunk = await previewChunk(context, { subdir, name, offset, maxLength });
      const parsed = parseChunkResponse(chunk, {
        requestedOffset: offset,
        maxLength,
        expectedTotal: totalBytes,
        expectedVersion,
        first: totalBytes === null,
      });

      if (totalBytes === null) {
        totalBytes = parsed.totalBytes;
        expectedVersion = parsed.version;
      }

      byteChunks.push(parsed.bytes);
      accumulatedLength += parsed.length;
      offset += parsed.length;

      if (accumulatedLength >= totalBytes) {
        complete = true;
        break;
      }
      if (accumulatedLength >= capBytes) {
        complete = true;
        break;
      }
    }

    if (!complete && accumulatedLength < (totalBytes ?? Infinity)) {
      throw chunkError('max_chunks_exceeded', 'text preview exceeded bounded chunk rounds');
    }

    const fullBytes = new Uint8Array(accumulatedLength);
    let curPos = 0;
    for (const piece of byteChunks) {
      fullBytes.set(piece, curPos);
      curPos += piece.length;
    }

    const text = new TextDecoder('utf-8', { fatal: false }).decode(fullBytes);
    const isTruncated = totalBytes === null || totalBytes > accumulatedLength;

    return {
      ok: true,
      filename: name,
      text,
      truncated: isTruncated,
      totalBytes: totalBytes ?? accumulatedLength,
    };
  }

  /**
   * 有界循环分块拉取完整文件字节（专用于安全光栅图片预览）。
   * 包含首块尺寸核对、严格 offset / decoded 长度 / 安全整数 totalBytes 与版本一致性校验。
   *
   * 宿主本地 content-chunk 的 b5 响应没有 version 字段；只有响应实际提供 version 时
   * 才按稳定 JSON 值比较。没有 version 时，总长相同无法检测同尺寸并发改写。
   * 纯预览不是交易快照，不能据此声称文件内容在读取期间稳定。
   *
   * @param {object} context - { mountId, agentId }
   * @param {object} params - { subdir, name, maxBytes, maxChunks }
   */
  async function readFullBytes(
    context,
    {
      subdir = '',
      name,
      maxBytes = PREVIEW_MAX_BYTES,
      maxChunks = PREVIEW_MAX_CHUNKS,
    } = {}
  ) {
    assertNonNegativeSafeInteger(maxBytes, 'invalid_max_bytes', 'maxBytes');
    if (!Number.isSafeInteger(maxChunks) || maxChunks <= 0) {
      throw chunkError('invalid_max_chunks', 'maxChunks must be a positive safe integer');
    }
    // 预览上限是硬上限：调用方传更大值也不能越过 8MiB / 128 轮
    const effectiveMaxBytes = Math.min(maxBytes, PREVIEW_MAX_BYTES);
    const effectiveMaxChunks = Math.min(maxChunks, PREVIEW_MAX_CHUNKS);

    let offset = 0;
    let expectedVersion = null;
    let totalBytes = null;
    const byteChunks = [];
    let accumulatedLength = 0;
    let complete = false;

    for (let round = 0; round < effectiveMaxChunks; round += 1) {
      if (totalBytes !== null && offset >= totalBytes) {
        complete = true;
        break;
      }

      const remaining =
        totalBytes === null ? effectiveMaxBytes - accumulatedLength : totalBytes - offset;
      // 0 字节文件也允许发一次 maxLength=1，让服务端返回 totalBytes=0 的合法空块。
      const maxLength = Math.min(64 * 1024, Math.max(1, remaining));
      const chunk = await previewChunk(context, { subdir, name, offset, maxLength });
      const parsed = parseChunkResponse(chunk, {
        requestedOffset: offset,
        maxLength,
        expectedTotal: totalBytes,
        expectedVersion,
        first: totalBytes === null,
      });

      if (totalBytes === null) {
        totalBytes = parsed.totalBytes;
        expectedVersion = parsed.version;
        if (totalBytes > effectiveMaxBytes) {
          return {
            ok: false,
            oversized: true,
            totalBytes,
            filename: chunk.filename || name,
          };
        }
      }

      byteChunks.push(parsed.bytes);
      accumulatedLength += parsed.length;
      offset += parsed.length;

      if (accumulatedLength === totalBytes) {
        complete = true;
        break;
      }
    }

    if (!complete || totalBytes === null || accumulatedLength !== totalBytes) {
      throw chunkError('max_chunks_exceeded', 'file exceeded chunk retrieval limit');
    }

    // 拼装所有字节片段
    const fullBytes = new Uint8Array(accumulatedLength);
    let curPos = 0;
    for (const piece of byteChunks) {
      fullBytes.set(piece, curPos);
      curPos += piece.length;
    }

    return {
      ok: true,
      oversized: false,
      filename: name,
      totalBytes: accumulatedLength,
      bytes: fullBytes,
    };
  }

  /**
   * 上传文件列表（保守移动端限制：单文件 <= 10MiB，总 <= 20MiB，<= 10件，禁止空文件）。
   *
   * @param {object} context - { mountId, agentId }
   * @param {object} params - { subdir, files: [ { name, contentBase64 } ] }
   */
  async function upload(context, { subdir = '', files = [] } = {}) {
    const { mountId, agentId } = validateContext(context);
    const cleanSubdir = normalizeSubdir(subdir);

    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('files_required: files array must not be empty');
    }
    if (files.length > MOBILE_MAX_UPLOAD_FILES_COUNT) {
      const err = new Error(`too_many_files: maximum ${MOBILE_MAX_UPLOAD_FILES_COUNT} files allowed`);
      err.code = 'too_many_files';
      throw err;
    }

    let totalBytes = 0;
    const validatedFiles = [];
    for (const f of files) {
      const cleanName = validateFileName(f?.name);
      const b64 = typeof f?.contentBase64 === 'string'
        ? f.contentBase64
        : String(f?.contentBase64 ?? '');
      if (!b64.trim()) {
        const err = new Error(`empty_file_not_supported: file "${cleanName}" has empty content`);
        err.code = 'empty_file_not_supported';
        throw err;
      }

      let bytes;
      try {
        bytes = base64ToUint8Array(b64);
      } catch (cause) {
        const err = new Error(
          `invalid_base64: file "${cleanName}" is not standard Base64 (${cause.message})`
        );
        err.code = 'invalid_base64';
        throw err;
      }
      const fileBytes = bytes.length;
      if (fileBytes === 0) {
        const err = new Error(`empty_file_not_supported: file "${cleanName}" has empty content`);
        err.code = 'empty_file_not_supported';
        throw err;
      }

      if (fileBytes > MOBILE_MAX_SINGLE_FILE_BYTES) {
        const err = new Error(
          `file_too_large: file "${cleanName}" (${fileBytes} bytes) exceeds 10MiB limit`
        );
        err.code = 'file_too_large';
        throw err;
      }
      totalBytes += fileBytes;
      validatedFiles.push({ name: cleanName, contentBase64: b64 });
    }

    if (totalBytes > MOBILE_MAX_TOTAL_UPLOAD_BYTES) {
      const err = new Error(
        `total_size_too_large: total upload size (${totalBytes} bytes) exceeds 20MiB limit`
      );
      err.code = 'total_size_too_large';
      throw err;
    }

    const payload = {
      mountId,
      ...(agentId ? { agentId } : {}),
      subdir: cleanSubdir,
      files: validatedFiles,
    };

    const res = await request('/api/mobile/workspace/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    return res;
  }

  /**
   * 生成规范的同源下载 URL。
   *
   * @param {object} context - { mountId, agentId }
   * @param {object} params - { subdir, name }
   */
  function downloadUrl(context, { subdir = '', name } = {}) {
    const { mountId, agentId } = validateContext(context);
    const cleanName = validateFileName(name);
    const cleanSubdir = normalizeSubdir(subdir);

    const q = new URLSearchParams();
    q.set('mountId', mountId);
    if (agentId) q.set('agentId', agentId);
    if (cleanSubdir) q.set('subdir', cleanSubdir);
    q.set('name', cleanName);

    const queryString = q.toString().replace(/\+/g, '%20');
    return `/api/mobile/workspace/content?${queryString}`;
  }

  return {
    listRoots,
    list,
    previewChunk,
    readTextPreview,
    readFullBytes,
    upload,
    downloadUrl,
  };
}
