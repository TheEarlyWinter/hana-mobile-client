/* tests/card_package_reference.test.mjs
 *
 * web/card-package-reference.js 纯数据契约测试
 * 覆盖：
 * 1. 只处理 projected interactive_card + packageRef 对象 + 无 inline code
 * 2. 按 ref.fileId 精确匹配官方 sessionFiles（id / fileId，id-only / fileId-only）
 * 3. 会话身份 / 路径 / cardId 各层一致性，矛盾即拒绝
 * 4. entryName、目录属性、status、真实路径的硬门槛
 * 5. 缺元数据、无匹配、歧义、id/fileId 冲突、目录声明冲突
 * 6. 输出只含 controller 需要的合成 sessionFile，不修改原 event / record
 */

import assert from 'node:assert/strict';
import { resolvePackageReference } from '../web/card-package-reference.js';

let bad = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

const PKG_DIR = 'C:\\Users\\WIT\\.hanako\\session-files\\s1\\c_pkg';
const SNAPSHOT = { sessionId: 's1', sessionPath: 'C:/s1.jsonl' };

function record(overrides = {}) {
  return {
    id: 'file-pkg-1',
    fileId: 'file-pkg-1',
    sessionId: 's1',
    sessionPath: 'C:/s1.jsonl',
    realPath: PKG_DIR,
    filePath: PKG_DIR,
    kind: 'directory',
    isDirectory: true,
    status: 'available',
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    type: 'interactive_card',
    cardId: 'card-pkg-1',
    title: '包卡片',
    packageRef: {
      fileId: 'file-pkg-1',
      sessionId: 's1',
      sessionPath: 'C:/s1.jsonl',
      entryName: 'index.html',
    },
    ...overrides,
  };
}

function resolveWith(overrides = {}) {
  return resolvePackageReference({
    event: event(),
    receipt: event(),
    snapshot: SNAPSHOT,
    sessionFiles: [record()],
    ...overrides,
  });
}

/* ------------------------------------------------------------------ */
/* 1. 不适用时完全忽略                                                 */
/* ------------------------------------------------------------------ */

await t('ignore: 非 interactive_card / 非对象 packageRef / 无 packageRef 的纯 inline', () => {
  assert.equal(resolvePackageReference({}).status, 'ignore');
  assert.equal(resolvePackageReference({ event: null }).status, 'ignore');
  assert.equal(resolveWith({ event: { ...event(), type: 'card' } }).status, 'ignore');
  assert.equal(resolveWith({ event: { ...event(), packageRef: 'file-pkg-1' } }).status, 'ignore');
  assert.equal(resolveWith({ event: { ...event(), packageRef: [] } }).status, 'ignore');

  // 纯 inline（没有 packageRef）仍走旧 Fragment 路径，resolver 不插手
  assert.equal(resolveWith({ event: { ...event(), packageRef: undefined, code: '<div>x</div>' } }).status, 'ignore');
  assert.equal(resolveWith({ event: { ...event(), packageRef: null, details: { code: '<div>x</div>' } } }).status, 'ignore');
});

await t('rejected: packageRef 与 inline code（含畸形 code）同时声明 -> source-conflict', () => {
  const variants = [
    { ...event(), code: '<div>x</div>' },
    { ...event(), details: { code: '<div>x</div>' } },
    { ...event(), details: { receipt: { code: '<div>x</div>' } } },
    { ...event(), packageRef: { ...event().packageRef, sessionId: 's2' }, code: '<div>x</div>' },
    { ...event(), code: { html: '<div>x</div>' } },
    { ...event(), details: { code: { html: '<div>x</div>' } } },
    { ...event(), details: { receipt: { code: 42 } } },
    { ...event(), code: 42 },
    { ...event(), code: ['<div>x</div>'] },
  ];
  for (const ev of variants) {
    const result = resolveWith({ event: ev });
    assert.equal(result.status, 'rejected', JSON.stringify(ev.code || ev.details));
    assert.equal(result.reason, 'source-conflict');
  }

  // controller 已提取的 inline 源（html/srcdoc 等）同样不能与 packageRef 共存
  const viaExtracted = resolvePackageReference({
    event: event(),
    receipt: event(),
    snapshot: SNAPSHOT,
    sessionFiles: [record()],
    inlineCode: '<div>from html</div>',
  });
  assert.equal(viaExtracted.status, 'rejected');
  assert.equal(viaExtracted.reason, 'source-conflict');

  // 空字符串 code 不算声明
  assert.equal(resolveWith({ event: event({ code: '' }) }).status, 'resolved');
});

/* ------------------------------------------------------------------ */
/* 2. 正常解析                                                         */
/* ------------------------------------------------------------------ */

await t('resolved: 官方记录匹配后输出真实目录与合成 sessionFile，不修改原对象', () => {
  const ev = event();
  const rec = record();
  const evBefore = JSON.stringify(ev);
  const recBefore = JSON.stringify(rec);

  const result = resolvePackageReference({ event: ev, receipt: ev, snapshot: SNAPSHOT, sessionFiles: [rec] });

  assert.equal(result.status, 'resolved');
  assert.equal(result.dirPath, PKG_DIR);
  assert.equal(result.sessionFile.sessionId, 's1');
  assert.equal(result.sessionFile.sessionPath, 'C:/s1.jsonl');
  assert.equal(result.sessionFile.realPath, PKG_DIR);
  assert.equal(result.sessionFile.filePath, PKG_DIR);
  assert.equal(result.sessionFile.kind, 'directory');
  assert.equal(result.sessionFile.isDirectory, true);
  assert.equal(result.sessionFile.status, 'available');
  assert.equal(result.sessionFile.id, 'file-pkg-1');
  assert.equal(result.sessionFile.fileId, 'file-pkg-1');
  assert.equal('version' in result.sessionFile, false, '不得把 metadata.version 塞进合成文件');

  assert.equal(JSON.stringify(ev), evBefore, '原 event 不得被修改');
  assert.equal(JSON.stringify(rec), recBefore, '原 record 不得被修改');
});

await t('resolved: 记录只有 id 或只有 fileId 时都能精确匹配', () => {
  const idOnly = resolvePackageReference({
    event: event(),
    receipt: event(),
    snapshot: SNAPSHOT,
    sessionFiles: [record({ fileId: undefined })],
  });
  assert.equal(idOnly.status, 'resolved');

  const fileIdOnly = resolvePackageReference({
    event: event(),
    receipt: event(),
    snapshot: SNAPSHOT,
    sessionFiles: [record({ id: undefined })],
  });
  assert.equal(fileIdOnly.status, 'resolved');
  assert.equal(fileIdOnly.sessionFile.id, 'file-pkg-1');
  assert.equal(fileIdOnly.sessionFile.fileId, 'file-pkg-1');
});

await t('resolved: realPath 为空时回退 filePath', () => {
  const result = resolvePackageReference({
    event: event(),
    receipt: event(),
    snapshot: SNAPSHOT,
    sessionFiles: [record({ realPath: '', filePath: 'C:\\alias\\c_pkg' })],
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.dirPath, 'C:\\alias\\c_pkg');
  assert.equal(result.sessionFile.realPath, 'C:\\alias\\c_pkg');
});

await t('resolved: 会话路径按大小写/斜杠规范化比较，ref 可省略 sessionPath', () => {
  const result = resolvePackageReference({
    event: {
      ...event(),
      packageRef: { fileId: 'file-pkg-1', sessionId: 's1', entryName: 'index.html' },
      sessionPath: 'c:\\S1.JSONL',
    },
    receipt: event(),
    snapshot: { sessionId: 's1', sessionPath: 'C:/s1.jsonl' },
    sessionFiles: [record({ sessionPath: 'C:\\S1.JSONL' })],
  });
  assert.equal(result.status, 'resolved');
});

/* ------------------------------------------------------------------ */
/* 3. 拒绝矩阵                                                         */
/* ------------------------------------------------------------------ */

await t('rejected: 缺身份 / 引用非法 / 入口不对', () => {
  const reasons = [
    ['missing-snapshot', resolveWith({ snapshot: { sessionPath: 'C:/s1.jsonl' } })],
    ['missing-snapshot', resolveWith({ snapshot: { sessionId: 's1' } })],
    ['invalid-reference', resolveWith({ event: { ...event(), packageRef: { ...event().packageRef, fileId: '' } } })],
    ['invalid-reference', resolveWith({ event: { ...event(), packageRef: { ...event().packageRef, sessionId: 42 } } })],
    ['entry-not-index', resolveWith({ event: { ...event(), packageRef: { ...event().packageRef, entryName: 'card.html' } } })],
    ['entry-not-index', resolveWith({ event: { ...event(), packageRef: { ...event().packageRef, entryName: undefined } } })],
  ];
  for (const [expected, result] of reasons) {
    assert.equal(result.status, 'rejected', expected);
    assert.equal(result.reason, expected);
  }
});

await t('rejected: 缺 sessionFiles / 无匹配 / 歧义 / id-fileId 冲突', () => {
  assert.equal(resolveWith({ sessionFiles: undefined }).reason, 'no-session-files');
  assert.equal(resolveWith({ sessionFiles: [] }).reason, 'no-session-files');
  assert.equal(resolveWith({ sessionFiles: {} }).reason, 'no-session-files');
  assert.equal(resolveWith({ sessionFiles: [record({ id: 'other', fileId: 'other' })] }).reason, 'no-match');
  assert.equal(resolveWith({ sessionFiles: [record(), record({ id: undefined })] }).reason, 'ambiguous-match');
  assert.equal(resolveWith({ sessionFiles: [record({ fileId: 'other' })] }).reason, 'record-id-conflict');
});

await t('rejected: 会话 / 路径 / cardId 各层冲突', () => {
  const reasons = [
    ['session-mismatch', resolveWith({ sessionFiles: [record({ sessionId: 's2' })] })],
    ['session-mismatch', resolveWith({ event: { ...event(), sessionId: 's2' } })],
    ['session-mismatch', resolveWith({ event: { ...event(), packageRef: { ...event().packageRef, sessionId: 's2' } } })],
    ['path-mismatch', resolveWith({ sessionFiles: [record({ sessionPath: 'C:/s2.jsonl' })] })],
    ['path-mismatch', resolveWith({ event: { ...event(), sessionPath: 'C:/s2.jsonl' } })],
    ['path-mismatch', resolveWith({ event: { ...event(), details: { sessionPath: 'C:/s2.jsonl' } } })],
    ['path-mismatch', resolveWith({ event: { ...event(), packageRef: { ...event().packageRef, sessionPath: 'C:/s2.jsonl' } } })],
    ['card-id-conflict', resolveWith({ event: { ...event(), details: { cardId: 'other-card' } } })],
    ['card-id-conflict', resolveWith({ sessionFiles: [record({ cardId: 'other-card' })] })],
    ['dir-path-conflict', resolveWith({ event: { ...event(), cardDir: 'C:\\forged\\dir' } })],
  ];
  for (const [expected, result] of reasons) {
    assert.equal(result.status, 'rejected', expected);
    assert.equal(result.reason, expected);
  }
});

await t('rejected: 目录属性 / status / 真实路径硬门槛', () => {
  const reasons = [
    ['not-directory', resolveWith({ sessionFiles: [record({ isDirectory: false })] })],
    ['not-directory', resolveWith({ sessionFiles: [record({ kind: 'file' })] })],
    ['not-directory', resolveWith({ sessionFiles: [record({ isDirectory: 'true' })] })],
    ['unavailable', resolveWith({ sessionFiles: [record({ status: 'missing' })] })],
    ['unavailable', resolveWith({ sessionFiles: [record({ status: undefined })] })],
    ['missing-path', resolveWith({ sessionFiles: [record({ realPath: '', filePath: '' })] })],
    ['missing-path', resolveWith({ sessionFiles: [record({ realPath: undefined, filePath: '   ' })] })],
  ];
  for (const [expected, result] of reasons) {
    assert.equal(result.status, 'rejected', expected);
    assert.equal(result.reason, expected);
  }
});

await t('rejected: 记录 sessionPath 缺失也不能靠猜', () => {
  const result = resolveWith({ sessionFiles: [record({ sessionPath: undefined })] });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'path-mismatch');
});

/* ------------------------------------------------------------------ */
/* 4. 一致的多层声明可以解析                                           */
/* ------------------------------------------------------------------ */

await t('resolved: 各层一致声明的 sessionId/sessionPath/cardId 不误伤', () => {
  const ev = {
    ...event(),
    sessionId: 's1',
    sessionPath: 'C:/s1.jsonl',
    details: {
      cardId: 'card-pkg-1',
      sessionId: 's1',
      sessionPath: 'C:/s1.jsonl',
      receipt: {
        cardId: 'card-pkg-1',
        sessionId: 's1',
        sessionPath: 'C:\\S1.JSONL',
      },
    },
  };
  const result = resolvePackageReference({ event: ev, receipt: ev.details.receipt, snapshot: SNAPSHOT, sessionFiles: [record()] });
  assert.equal(result.status, 'resolved');
});

await t('rejected: 非对象或畸形记录被跳过，不会误选', () => {
  const result = resolvePackageReference({
    event: event(),
    receipt: event(),
    snapshot: SNAPSHOT,
    sessionFiles: [null, 'x', [], record({ id: 'other', fileId: 'other' })],
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'no-match');
});

if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
