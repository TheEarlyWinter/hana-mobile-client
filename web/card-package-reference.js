/* web/card-package-reference.js
 *
 * 历史投影卡片的 packageRef 适配（纯数据，不碰网络 / DOM / 全局状态）。
 *
 * 宿主 GET /api/sessions/messages 的 interactive_card 块只带
 *   packageRef: { fileId, sessionId, sessionPath?, entryName: 'index.html' }
 * 没有 inline code；同一响应的 sessionFiles 才带正式目录记录
 *   { id/fileId, sessionId/sessionPath, realPath/filePath, kind:'directory', isDirectory, status }
 *
 * 本模块把两者核准成 card-controller 既有的“显式目录 sessionFile”形状；
 * 只按 ref.fileId 精确匹配，身份/路径/目录属性/入口任一不符就拒绝，
 * 绝不猜路径、绝不任选一条歧义记录、绝不把 metadata.version 当 sourceVersion。
 */

const ENTRY_NAME = 'index.html';

const MESSAGES = Object.freeze({
  'missing-snapshot': '卡片引用不可用：当前会话缺少可核对的 sessionId/sessionPath',
  'invalid-reference': '卡片引用不可用：引用或身份字段格式不合法',
  'entry-not-index': '卡片引用不可用：入口必须是 index.html',
  'source-conflict': '卡片来源冲突：同一事件同时声明 inline code 与 packageRef',
  'no-session-files': '卡片引用不可用：缺少官方 sessionFiles 目录元数据',
  'no-match': '卡片引用不可用：未找到匹配的目录记录',
  'ambiguous-match': '卡片引用不可用：目录记录匹配不唯一',
  'record-id-conflict': '卡片引用不可用：目录记录的 id/fileId 冲突',
  'session-mismatch': '卡片引用不可用：会话身份不一致',
  'path-mismatch': '卡片引用不可用：会话路径不一致',
  'card-id-conflict': '卡片引用不可用：cardId 声明冲突',
  'dir-path-conflict': '卡片引用不可用：目录路径声明冲突',
  'not-directory': '卡片引用不可用：记录不是目录',
  'unavailable': '卡片引用不可用：目录不可用',
  'missing-path': '卡片引用不可用：目录缺少真实路径',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePath(value) {
  return text(value).replace(/\\/g, '/').toLowerCase();
}

function pathEquals(a, b) {
  return normalizePath(a) === normalizePath(b);
}

function normalizeDir(value) {
  return normalizePath(value).replace(/\/+$/, '');
}

function dirEquals(a, b) {
  return normalizeDir(a) === normalizeDir(b);
}

function reject(reason) {
  return {
    status: 'rejected',
    reason,
    message: MESSAGES[reason] || '卡片引用不可用',
  };
}

/** 收集各层显式字符串；非字符串非空值视为格式非法。 */
function explicitTexts(pairs) {
  const values = [];
  for (const [, value] of pairs) {
    if (value == null) continue;
    if (typeof value !== 'string') return { invalid: true, values };
    const trimmed = value.trim();
    if (trimmed) values.push(trimmed);
  }
  return { invalid: false, values };
}

function declaresInlineSource(event, receipt, extractedCode) {
  if (typeof extractedCode === 'string') {
    if (extractedCode.trim()) return true;
  } else if (extractedCode != null) {
    return true;
  }

  // explicit code 字段：空串/null 不算声明，非字符串视为畸形声明，绝不静默放过。
  const candidates = [
    event?.code,
    event?.details?.code,
    event?.details?.receipt?.code,
    receipt?.code,
  ];
  for (const value of candidates) {
    if (value == null) continue;
    if (typeof value !== 'string') return true;
    if (value.trim()) return true;
  }
  return false;
}

/**
 * 解析 projected interactive_card 的 packageRef。
 *
 * @param {object} options
 * @param {object} options.event - 历史投影块（type: 'interactive_card'）
 * @param {object} [options.receipt] - controller 解析出的 receipt（缺省由 event 自身承担）
 * @param {object} options.snapshot - 当前活动会话 { sessionId, sessionPath }
 * @param {object[]} options.sessionFiles - 官方 sessionFiles 目录元数据数组
 * @param {string|null} [options.inlineCode=null] - controller 已提取的 inline 源（html/srcdoc 等）
 * @returns {{status:'ignore'} | {status:'resolved', dirPath:string, sessionFile:object} | {status:'rejected', reason:string, message:string}}
 */
export function resolvePackageReference({ event, receipt, snapshot, sessionFiles, inlineCode = null } = {}) {
  if (!isPlainObject(event) || event.type !== 'interactive_card') return { status: 'ignore' };
  if (!isPlainObject(event.packageRef)) return { status: 'ignore' };
  // 同一事件同时带 inline 源和 packageRef：host EFt 本应互斥，出现即拒绝，绝不任选一路。
  if (declaresInlineSource(event, receipt, inlineCode)) return reject('source-conflict');

  const ref = event.packageRef;
  const snapshotId = text(snapshot?.sessionId);
  const snapshotPath = text(snapshot?.sessionPath);
  if (!snapshotId || !snapshotPath) return reject('missing-snapshot');

  const refFileId = text(ref.fileId);
  const refSessionId = text(ref.sessionId);
  if (!refFileId || !refSessionId) return reject('invalid-reference');
  if (ref.entryName !== ENTRY_NAME) return reject('entry-not-index');

  // sessionId：event / details / receipt / sessionFile / ref 每层显式值都必须等于 snapshot。
  const ids = explicitTexts([
    ['event.sessionId', event.sessionId],
    ['event.details.sessionId', event.details?.sessionId],
    ['event.details.receipt.sessionId', event.details?.receipt?.sessionId],
    ['receipt.sessionId', receipt?.sessionId],
    ['event.sessionFile.sessionId', event.sessionFile?.sessionId],
    ['event.details.sessionFile.sessionId', event.details?.sessionFile?.sessionId],
    ['receipt.sessionFile.sessionId', receipt?.sessionFile?.sessionId],
    ['packageRef.sessionId', ref.sessionId],
  ]);
  if (ids.invalid) return reject('invalid-reference');
  for (const sessionId of ids.values) {
    if (sessionId !== snapshotId) return reject('session-mismatch');
  }

  // sessionPath：同样逐层比对；空值不算声明，非字符串算非法。
  const paths = explicitTexts([
    ['event.sessionPath', event.sessionPath],
    ['event.details.sessionPath', event.details?.sessionPath],
    ['event.details.receipt.sessionPath', event.details?.receipt?.sessionPath],
    ['receipt.sessionPath', receipt?.sessionPath],
    ['event.sessionFile.sessionPath', event.sessionFile?.sessionPath],
    ['event.details.sessionFile.sessionPath', event.details?.sessionFile?.sessionPath],
    ['receipt.sessionFile.sessionPath', receipt?.sessionFile?.sessionPath],
    ['packageRef.sessionPath', ref.sessionPath],
  ]);
  if (paths.invalid) return reject('invalid-reference');
  for (const sessionPath of paths.values) {
    if (!pathEquals(sessionPath, snapshotPath)) return reject('path-mismatch');
  }

  // cardId：不要求存在，但所有显式声明必须一致。
  const cardIds = explicitTexts([
    ['event.cardId', event.cardId],
    ['event.details.cardId', event.details?.cardId],
    ['receipt.cardId', receipt?.cardId],
    ['event.sessionFile.cardId', event.sessionFile?.cardId],
    ['receipt.sessionFile.cardId', receipt?.sessionFile?.cardId],
    ['packageRef.cardId', ref.cardId],
  ]);
  if (cardIds.invalid) return reject('invalid-reference');
  const uniqueCardIds = new Set(cardIds.values);
  if (uniqueCardIds.size > 1) return reject('card-id-conflict');

  // 显式目录提示（cardDir / 已有 directory sessionFile）只能与最终记录一致。
  const dirHints = [];
  const hintCandidates = [event.cardDir, event.details?.cardDir, receipt?.cardDir];
  for (const hint of hintCandidates) {
    if (hint == null) continue;
    if (typeof hint !== 'string') return reject('invalid-reference');
    if (hint.trim()) dirHints.push(hint.trim());
  }
  for (const file of [event.sessionFile, receipt?.sessionFile]) {
    if (!isPlainObject(file)) continue;
    if (!(file.isDirectory === true || file.kind === 'directory')) continue;
    for (const key of ['realPath', 'filePath', 'path']) {
      const value = file[key];
      if (value == null) continue;
      if (typeof value !== 'string') return reject('invalid-reference');
      if (value.trim()) dirHints.push(value.trim());
    }
  }

  if (!Array.isArray(sessionFiles) || sessionFiles.length === 0) {
    return reject('no-session-files');
  }

  // 按 ref.fileId 精确匹配；同一条记录 id/fileId 冲突且命中时直接拒绝。
  let match = null;
  for (const record of sessionFiles) {
    if (!isPlainObject(record)) continue;
    const id = text(record.id);
    const fileId = text(record.fileId);
    if (id && fileId && id !== fileId) {
      if (id === refFileId || fileId === refFileId) return reject('record-id-conflict');
      continue;
    }
    const key = fileId || id;
    if (!key || key !== refFileId) continue;
    if (match) return reject('ambiguous-match');
    match = record;
  }
  if (!match) return reject('no-match');

  const recordSessionId = text(match.sessionId);
  if (!recordSessionId || recordSessionId !== snapshotId) return reject('session-mismatch');

  const recordSessionPath = text(match.sessionPath);
  if (!recordSessionPath || !pathEquals(recordSessionPath, snapshotPath)) return reject('path-mismatch');

  if (match.isDirectory !== true || match.kind !== 'directory') return reject('not-directory');
  if (match.status !== 'available') return reject('unavailable');

  const dirPath = text(match.realPath) || text(match.filePath);
  if (!dirPath) return reject('missing-path');

  const recordCardId = text(match.cardId);
  if (recordCardId) {
    for (const cardId of uniqueCardIds) {
      if (cardId !== recordCardId) return reject('card-id-conflict');
    }
  }

  for (const hint of dirHints) {
    if (!dirEquals(hint, dirPath)) return reject('dir-path-conflict');
  }

  const sessionFile = Object.freeze({
    id: text(match.id) || text(match.fileId),
    fileId: text(match.fileId) || text(match.id),
    sessionId: snapshotId,
    sessionPath: snapshotPath,
    realPath: dirPath,
    filePath: text(match.filePath) || dirPath,
    kind: 'directory',
    isDirectory: true,
    status: 'available',
  });

  return { status: 'resolved', dirPath, sessionFile };
}
