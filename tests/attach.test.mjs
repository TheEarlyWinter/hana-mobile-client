/* attach.js 的纯函数测试
 * 只需要 node（无 DOM），因为被测函数不碰浏览器 API。
 * 断言里写死的数字对应 hana-server 的校验：一次 ≤ 10 张图、单张 base64 ≤ 20MB、
 * 图片 mimeType 只认 png/jpeg/gif/webp；非图片走 `/api/upload-blob` 上传成会话文件，
 * 文档 base64 ≤ 12MB 字符、单次 ≤ 9 个、mimeType 只认 bIn 那张表。服务端改了这边要跟着改。
 */

import assert from 'node:assert/strict';
import {
  MAX_IMAGES,
  MAX_BASE64_CHARS,
  ALLOWED_IMAGE_MIMES,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_FILE_BASE64_CHARS,
  UPLOAD_BLOB_PATH,
  FILE_READY_FLAG,
  ALLOWED_FILE_MIMES,
  isAllowedFileMime,
  isFileAttachment,
  resolveFileMime,
  fileSizeProblem,
  fileBadge,
  buildSessionFileRefs,
  uploadSessionFile,
  fileToBase64,
  normalizeMime,
  isAllowedImageMime,
  fitWithin,
  base64Bytes,
  dataUrlToBase64,
  dataUrlMime,
  toBareBase64,
  imageBlockData,
  splitUserContent,
  imagesFromAttachments,
  validateForSend,
  formatBytes,
  buildPromptFrame,
} from '../web/attach.js';

let bad = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

/* ---- 协议常量 ---- */

t('limits match hana-server', () => {
  assert.equal(MAX_IMAGES, 10);
  assert.equal(MAX_BASE64_CHARS, 20 * 1024 * 1024);
  assert.deepEqual([...ALLOWED_IMAGE_MIMES], ['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
});

/* ---- mime ---- */

t('normalizeMime folds aliases', () => {
  assert.equal(normalizeMime('image/JPG'), 'image/jpeg');
  assert.equal(normalizeMime('image/pjpeg'), 'image/jpeg');
  assert.equal(normalizeMime(' IMAGE/PNG '), 'image/png');
  assert.equal(normalizeMime(''), '');
  assert.equal(normalizeMime(undefined), '');
});

t('isAllowedImageMime rejects heic and svg', () => {
  assert.equal(isAllowedImageMime('image/jpeg'), true);
  assert.equal(isAllowedImageMime('image/heic'), false);
  assert.equal(isAllowedImageMime('image/svg+xml'), false);
});

/* ---- 缩放 ---- */

t('fitWithin keeps small images untouched', () => {
  const r = fitWithin(800, 600, 1568);
  assert.deepEqual([r.width, r.height, r.resized], [800, 600, false]);
});

t('fitWithin scales landscape by long edge', () => {
  const r = fitWithin(4032, 3024, 1568);
  assert.equal(r.width, 1568);
  assert.equal(r.height, 1176);
  assert.equal(r.resized, true);
  assert.ok(Math.abs(r.width / r.height - 4032 / 3024) < 0.01);
});

t('fitWithin scales portrait by long edge', () => {
  const r = fitWithin(3024, 4032, 1568);
  assert.deepEqual([r.width, r.height], [1176, 1568]);
});

t('fitWithin never returns zero edge', () => {
  const r = fitWithin(10000, 3, 100);
  assert.equal(r.width, 100);
  assert.equal(r.height, 1);
});

t('fitWithin tolerates junk input', () => {
  assert.deepEqual(fitWithin(0, 0).resized, false);
  assert.deepEqual(fitWithin(NaN, 10).width, 0);
});

/* ---- base64 ---- */

t('base64Bytes counts padding correctly', () => {
  assert.equal(base64Bytes(''), 0);
  assert.equal(base64Bytes('TQ=='), 1);
  assert.equal(base64Bytes('TWE='), 2);
  assert.equal(base64Bytes('TWFu'), 3);
  assert.equal(base64Bytes('AAAA'), 3);
});

t('dataUrlToBase64 strips prefix', () => {
  assert.equal(dataUrlToBase64('data:image/png;base64,AAAA'), 'AAAA');
  assert.equal(dataUrlToBase64('AAAA'), '');
  assert.equal(dataUrlToBase64(null), '');
});

t('dataUrlMime reads media type', () => {
  assert.equal(dataUrlMime('data:image/JPEG;base64,AAAA'), 'image/jpeg');
  assert.equal(dataUrlMime('nope'), '');
});

t('toBareBase64 accepts both forms', () => {
  assert.equal(toBareBase64('data:image/png;base64,AAAA'), 'AAAA');
  assert.equal(toBareBase64('  AAAA  '), 'AAAA');
  assert.equal(toBareBase64(42), '');
});

/* ---- 历史块解析 ---- */

t('imageBlockData handles flat and nested source', () => {
  assert.deepEqual(imageBlockData({ type: 'image', data: 'AAAA', mimeType: 'image/png' }), {
    data: 'AAAA',
    mimeType: 'image/png',
  });
  assert.deepEqual(
    imageBlockData({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }),
    { data: 'BBBB', mimeType: 'image/jpeg' },
  );
  assert.equal(imageBlockData({ type: 'text', text: 'hi' }), null);
  assert.equal(imageBlockData({ type: 'image' }), null);
});

t('splitUserContent separates text and images', () => {
  const { text, images } = splitUserContent([
    { type: 'text', text: '看看这个' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'text', text: '有问题吗' },
  ]);
  assert.equal(text, '看看这个\n有问题吗');
  assert.equal(images.length, 1);
  assert.equal(images[0].src, 'data:image/png;base64,AAAA');
  assert.equal(images[0].bytes, 3);
});

t('splitUserContent accepts a plain string', () => {
  const { text, images } = splitUserContent('纯文本');
  assert.equal(text, '纯文本');
  assert.equal(images.length, 0);
});

t('splitUserContent skips thinking blocks', () => {
  const { text } = splitUserContent([
    { type: 'thinking', text: '内心戏' },
    { type: 'text', text: '正文' },
  ]);
  assert.equal(text, '正文');
});

/* ---- `[attached_image: …]` 历史标记 ----
 * 正文里的换行、缩进、连续空格都是用户写的，抽图时只能删标记本身。
 * 标记映射不出网关地址时必须原样留在正文里（连同排版一个字都不动）。
 */

t('splitUserContent keeps an unmapped marker and all whitespace intact', () => {
  const raw = '第一段\n\n第二段  这里有两个空格\n    缩进的行\n[attached_image: C:\\tmp\\x.png]';
  const { text, images } = splitUserContent(raw, { fileUrl: () => null });
  assert.equal(images.length, 0);
  assert.equal(text, raw);
});

t('splitUserContent removes a mapped marker and keeps the layout', () => {
  const raw = '第一行\n\n第二行  连续两个空格\n    const x = 1;\n[attached_image: C:\\tmp\\a.png]';
  const { text, images } = splitUserContent(raw, { fileUrl: (p) => `/gw/file/${p.length}` });
  assert.equal(images.length, 1);
  assert.equal(images[0].src, `/gw/file/${'C:\\tmp\\a.png'.length}`);
  assert.equal(images[0].name, 'a.png');
  assert.equal(images[0].mimeType, 'image/png');
  assert.equal(text, '第一行\n\n第二行  连续两个空格\n    const x = 1;');
});

t('splitUserContent keeps the unmappable marker when a sibling marker maps', () => {
  const body = '解释一下这张：\n  - 要点一\n  - 要点二\n\n    缩进结论';
  const okPath = 'C:\\tmp\\ok.png';
  const badPath = 'C:\\tmp\\gone.png';
  const raw = `${body}\n[attached_image: ${okPath}]\n[attached_image: ${badPath}]`;
  const { text, images } = splitUserContent(raw, { fileUrl: (p) => (p === okPath ? '/gw/file/ok' : null) });
  assert.equal(images.length, 1);
  assert.equal(images[0].src, '/gw/file/ok');
  assert.equal(text, `${body}\n\n[attached_image: ${badPath}]`);
});

t('splitUserContent leaves a lone mapped marker with empty text', () => {
  const { text, images } = splitUserContent('[attached_image: C:\\tmp\\only.png]', { fileUrl: () => '/gw/only' });
  assert.equal(images.length, 1);
  assert.equal(text, '');
});

/* ---- `[SessionFile] {…}` 与 `[hana_reference]` ----
 * 这两样是桌面端粘过来的引用和平台塞给模型的机器提示，都不是用户写的正文。
 */

const SF_JSON = '{"fileId":"sf_90a5","sessionPath":"C:/tmp/a.jsonl","sessionId":"sess_1","label":"粘贴图片.jpg","kind":"attachment"}';

t('splitUserContent pulls a SessionFile marker out as a file ref', () => {
  const raw = `[SessionFile] ${SF_JSON}\n正文一段`;
  const { text, files } = splitUserContent(raw, { resourceUrl: () => null });
  assert.equal(files.length, 1);
  assert.equal(files[0].fileId, 'sf_90a5');
  assert.equal(files[0].label, '粘贴图片.jpg');
  assert.equal(files[0].kind, 'attachment');
  assert.equal(text, '正文一段');
});

t('splitUserContent turns a lone image SessionFile into an image', () => {
  const { text, images, files } = splitUserContent(`[SessionFile] ${SF_JSON}`, {
    resourceUrl: (id) => `/api/resources/${id}/content`,
  });
  assert.equal(text, '');
  assert.equal(files.length, 0);
  assert.equal(images.length, 1);
  assert.equal(images[0].src, '/api/resources/sf_90a5/content');
  assert.equal(images[0].mimeType, 'image/jpeg');
});

t('splitUserContent keeps a SessionFile as a chip when an image already exists', () => {
  const raw = `[SessionFile] ${SF_JSON}\n[attached_image: C:\\tmp\\a.png]`;
  const { images, files } = splitUserContent(raw, {
    fileUrl: () => '/gw/file/ok',
    resourceUrl: (id) => `/api/resources/${id}/content`,
  });
  assert.equal(images.length, 1);
  assert.equal(images[0].src, '/gw/file/ok');
  assert.equal(files.length, 1);
});

t('splitUserContent drops the [hana_reference] hint block', () => {
  const raw = [
    { type: 'text', text: '看看这张图' },
    { type: 'text', text: '[hana_reference]\n此处未加载历史图片。\n[/hana_reference]' },
  ];
  const { text } = splitUserContent(raw);
  assert.equal(text, '看看这张图');
});

t('splitUserContent leaves a malformed SessionFile marker alone', () => {
  const raw = '[SessionFile] {不是 json}\n正文';
  const { text, files } = splitUserContent(raw, { resourceUrl: () => '/x' });
  assert.equal(files.length, 0);
  assert.equal(text, raw);
});

/* ---- 附件路径 ---- */

t('imagesFromAttachments uses inline data first', () => {
  const out = imagesFromAttachments(
    [{ name: 'a.png', mimeType: 'image/png', base64Data: 'AAAA', path: 'C:/x/a.png' }],
    { fileUrl: () => '/gw/file/nope' },
  );
  assert.equal(out.length, 1);
  assert.ok(out[0].src.startsWith('data:image/png;base64,'));
});

t('imagesFromAttachments falls back to gateway url', () => {
  const out = imagesFromAttachments(
    [{ name: 'a.png', mimeType: 'image/png', path: 'C:/x/a.png' }],
    { fileUrl: (p) => `/gw/file/${p.length}` },
  );
  assert.equal(out[0].src, '/gw/file/10');
});

t('imagesFromAttachments skips non-images and dirs', () => {
  const out = imagesFromAttachments(
    [
      { name: 'a.txt', mimeType: 'text/plain', path: 'C:/x/a.txt' },
      { name: 'dir', isDirectory: true, path: 'C:/x' },
      { name: 'b.png', mimeType: 'image/png', path: 'C:/x/b.png' },
    ],
    { fileUrl: () => '/gw/file/ok' },
  );
  assert.equal(out.length, 1);
});

t('imagesFromAttachments drops entries with no source', () => {
  const out = imagesFromAttachments([{ name: 'b.png', mimeType: 'image/png' }], { fileUrl: () => null });
  assert.equal(out.length, 0);
});

/* ---- 发送前校验 ---- */

t('validateForSend passes a normal message', () => {
  assert.equal(validateForSend([{ mimeType: 'image/jpeg', data: 'AAAA' }]), null);
  assert.equal(validateForSend([]), null);
});

t('validateForSend rejects too many images', () => {
  const many = Array.from({ length: 11 }, () => ({ mimeType: 'image/jpeg', data: 'AAAA' }));
  assert.match(validateForSend(many), /10/);
});

t('validateForSend rejects bad mime', () => {
  assert.match(validateForSend([{ mimeType: 'image/heic', data: 'AAAA' }]), /不支持/);
});

t('validateForSend rejects oversized payload', () => {
  const huge = { mimeType: 'image/jpeg', data: 'A'.repeat(MAX_BASE64_CHARS + 1) };
  assert.match(validateForSend([huge]), /太大/);
});

/* ---- 其它 ---- */

t('formatBytes', () => {
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB');
});

/* ---- prompt 帧 ---- */

t('buildPromptFrame keeps the proven field set', () => {
  const f = buildPromptFrame({
    session: { sessionId: 'sess_x', path: 'C:/s/x.jsonl' },
    text: '你好',
    inputId: 'm-1',
  });
  assert.deepEqual(f, {
    type: 'prompt',
    sessionId: 'sess_x',
    sessionPath: 'C:/s/x.jsonl',
    text: '你好',
    displayMessage: { text: '你好' },
    clientMessageId: 'm-1',
    inputId: 'm-1',
  });
  assert.equal('feedItemId' in f, false, '普通帧不能带空日报字段');
  assert.equal('feedRevision' in f, false, '普通帧不能带空日报字段');
});

t('buildPromptFrame puts prepared feed reference only at the top level', () => {
  const f = buildPromptFrame({
    session: { sessionId: 'sess-feed', path: 'C:/s/feed.jsonl' },
    text: '请解释原因',
    inputId: 'm-feed',
    feedItemId: 'fi_0123456789ABCDEFGHJKMNPQRS',
    feedRevision: 7,
  });
  assert.equal(f.feedItemId, 'fi_0123456789ABCDEFGHJKMNPQRS');
  assert.equal(f.feedRevision, 7);
  assert.deepEqual(f.displayMessage, { text: '请解释原因' });
  assert.equal('feedCard' in f.displayMessage, false, '客户端不能伪造 displayMessage.feedCard');
});

t('buildPromptFrame adds bare base64 images', () => {
  const f = buildPromptFrame({
    session: { sessionId: 's', path: 'p' },
    text: '',
    inputId: 'm-2',
    attachments: [
      { mimeType: 'image/JPG', base64: 'AAAA', previewUrl: 'data:image/jpeg;base64,AAAA' },
      { mimeType: 'image/png', base64: '' }, // 还没处理完的占位，丢掉
    ],
  });
  assert.deepEqual(f.images, [{ mimeType: 'image/jpeg', data: 'AAAA' }]);
  // 不能把 data: 前缀带进帧里
  assert.ok(!f.images[0].data.startsWith('data:'));
  assert.equal(f.text, '');
});

t('buildPromptFrame omits images when none', () => {
  const f = buildPromptFrame({ session: { sessionId: 's', path: 'p' }, text: 'hi', inputId: 'm' });
  assert.equal('images' in f, false);
});

t('buildPromptFrame never sends displayMessage.attachments', () => {
  const f = buildPromptFrame({
    session: { sessionId: 's', path: 'p' },
    text: '看',
    inputId: 'm',
    attachments: [{ mimeType: 'image/png', base64: 'AAAA', name: 'a.png' }],
  });
  assert.equal('attachments' in f.displayMessage, false);
});

t('buildPromptFrame caps at MAX_IMAGES', () => {
  const many = Array.from({ length: 15 }, () => ({ mimeType: 'image/png', base64: 'AAAA' }));
  const f = buildPromptFrame({ session: {}, text: 'x', inputId: 'm', attachments: many });
  assert.equal(f.images.length, MAX_IMAGES);
});

/* ---- 会话文件（文档 / 音频）：先上传成会话文件，再用 fileId 引用 ----
 *
 * 宿主事实（hana-server 1.5.70 bundle）：WS prompt 帧只有 text / images / videos /
 * audios / sessionFileRefs 五个载荷字段，**没有** documents；非图片附件只能先走
 * POST /api/upload-blob 换一个 fileId，再由 sessionFileRefs 引用。
 */

t('file limits match hana-server', () => {
  assert.equal(MAX_FILES, 9, '宿主 upload-blob 单次最多 9 个 blob');
  assert.equal(MAX_FILE_BASE64_CHARS, 12 * 1024 * 1024, '文档/压缩包的 base64 上限是 12MB 字符');
  assert.equal(MAX_FILE_BYTES, 9 * 1024 * 1024, '12MB 字符的 base64 正好装 9MB 原始字节');
  assert.equal(UPLOAD_BLOB_PATH, '/api/upload-blob');
  assert.equal(FILE_READY_FLAG, 'file');
});

t('ALLOWED_FILE_MIMES matches the host whitelist', () => {
  assert.deepEqual([...ALLOWED_FILE_MIMES], [
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/xml',
    'application/xml',
    'application/json',
    'application/rtf',
    'application/zip',
    'application/x-zip-compressed',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/octet-stream',
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/mp4',
    'audio/ogg',
    'audio/flac',
  ]);
  assert.equal(isAllowedFileMime('APPLICATION/PDF'), true);
  assert.equal(isAllowedFileMime('video/mp4'), false, '宿主没有视频上传接口，别放进来');
  assert.equal(isAllowedFileMime('image/png'), false, '图片不走这条路');
});

t('isFileAttachment only recognises kind=file', () => {
  assert.equal(isFileAttachment({ kind: 'file', fileId: 'sf_1' }), true);
  assert.equal(isFileAttachment({ base64: 'AAAA', mimeType: 'image/png' }), false);
  assert.equal(isFileAttachment(null), false);
});

t('resolveFileMime keeps the browser type when the extension agrees', () => {
  assert.deepEqual(resolveFileMime({ name: 'report.pdf', type: 'application/pdf' }), {
    ok: true,
    mimeType: 'application/pdf',
  });
  assert.deepEqual(resolveFileMime({ name: 'a.DOCX', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), {
    ok: true,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
});

t('resolveFileMime falls back to the extension when the browser says nothing', () => {
  // Android 文件管理器经常给空 type 或 octet-stream
  assert.deepEqual(resolveFileMime({ name: '报价单.xlsx', type: '' }), {
    ok: true,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  assert.deepEqual(resolveFileMime({ name: '归档.zip', type: 'application/octet-stream' }), {
    ok: true,
    mimeType: 'application/zip',
  });
  assert.deepEqual(resolveFileMime({ name: 'note.md', type: 'text/x-markdown' }), {
    ok: true,
    mimeType: 'text/markdown',
  });
});

t('resolveFileMime uploads code as octet-stream so the host keeps the filename', () => {
  // 宿主会按 mime 反查扩展名重命名：text/plain 的 a.py 进去就变成 a.py.txt
  assert.deepEqual(resolveFileMime({ name: 'main.py', type: 'text/plain' }), {
    ok: true,
    mimeType: 'application/octet-stream',
  });
  assert.deepEqual(resolveFileMime({ name: 'index.ts', type: 'text/javascript' }), {
    ok: true,
    mimeType: 'application/octet-stream',
  });
  assert.deepEqual(resolveFileMime({ name: 'docker-compose.yml', type: '' }), {
    ok: true,
    mimeType: 'application/octet-stream',
  });
});

t('resolveFileMime keeps a known mime when the file has no extension', () => {
  assert.deepEqual(resolveFileMime({ name: 'scan', type: 'application/pdf' }), {
    ok: true,
    mimeType: 'application/pdf',
  });
});

t('resolveFileMime rejects what the host cannot take', () => {
  assert.equal(resolveFileMime({ name: 'evil.exe', type: 'application/x-msdownload' }).ok, false);
  assert.equal(resolveFileMime({ name: 'logo.svg', type: 'image/svg+xml' }).ok, false);
  assert.equal(resolveFileMime({ name: 'clip.mp4', type: 'video/mp4' }).ok, false);
  assert.match(resolveFileMime({ name: 'evil.exe', type: 'application/x-msdownload' }).reason, /不支持/);
  assert.match(resolveFileMime({ name: 'mystery', type: '' }).reason, /认不出/);
});

t('fileSizeProblem uses the host byte limit', () => {
  assert.equal(fileSizeProblem(0), null);
  assert.equal(fileSizeProblem(MAX_FILE_BYTES), null);
  const msg = fileSizeProblem(MAX_FILE_BYTES + 1);
  assert.ok(msg && /9\.0 MB/.test(msg), `超限提示要带上具体上限，实际：${msg}`);
});

t('fileBadge shows a short extension label', () => {
  assert.equal(fileBadge('report.pdf'), 'PDF');
  assert.equal(fileBadge('a.tar.gz'), 'GZ');
  assert.equal(fileBadge('无扩展名'), 'FILE');
});

t('buildSessionFileRefs maps uploaded files and skips pending ones', () => {
  const refs = buildSessionFileRefs(
    [
      { kind: 'file', name: 'a.pdf', fileId: 'sf_a' },
      { kind: 'file', name: 'b.docx', fileId: 'sf_b' },
      { kind: 'file', name: '还没传.pdf' },
      { kind: 'file', name: 'a 重复.pdf', fileId: 'sf_a' },
      { base64: 'AAAA', mimeType: 'image/png' },
    ],
    { sessionPath: 'C:/s/x.jsonl', sessionId: 'sess_1' },
  );
  assert.deepEqual(refs, [
    { fileId: 'sf_a', label: 'a.pdf', kind: 'attachment', sessionPath: 'C:/s/x.jsonl', sessionId: 'sess_1' },
    { fileId: 'sf_b', label: 'b.docx', kind: 'attachment', sessionPath: 'C:/s/x.jsonl', sessionId: 'sess_1' },
  ]);
});

t('buildSessionFileRefs caps at MAX_FILES', () => {
  const many = Array.from({ length: 12 }, (_v, i) => ({ kind: 'file', name: `f${i}.pdf`, fileId: `sf_${i}` }));
  assert.equal(buildSessionFileRefs(many, { sessionPath: 'p' }).length, MAX_FILES);
});

t('buildPromptFrame carries files as sessionFileRefs, images stay inline', () => {
  const f = buildPromptFrame({
    session: { sessionId: 'sess_x', path: 'C:/s/x.jsonl' },
    text: '看下这份',
    inputId: 'm-9',
    attachments: [
      { base64: 'AAAA', mimeType: 'image/png', name: 'a.png', previewUrl: 'data:image/png;base64,AAAA' },
      { kind: 'file', name: '合同.pdf', mimeType: 'application/pdf', fileId: 'sf_pdf', base64: FILE_READY_FLAG },
    ],
  });
  assert.deepEqual(f.images, [{ mimeType: 'image/png', data: 'AAAA' }]);
  assert.deepEqual(f.sessionFileRefs, [
    { fileId: 'sf_pdf', label: '合同.pdf', kind: 'attachment', sessionPath: 'C:/s/x.jsonl', sessionId: 'sess_x' },
  ]);
  assert.equal(f.text, '看下这份');
  assert.equal('attachments' in f.displayMessage, false, '文件引用走 sessionFileRefs，不塞 displayMessage');
});

t('buildPromptFrame sends a file-only message with empty text', () => {
  const f = buildPromptFrame({
    session: { sessionId: 's', path: 'p' },
    text: '',
    inputId: 'm-10',
    attachments: [{ kind: 'file', name: 'x.xlsx', fileId: 'sf_x', base64: FILE_READY_FLAG }],
  });
  assert.equal(f.text, '');
  assert.equal('images' in f, false);
  assert.equal(f.sessionFileRefs.length, 1);
  assert.equal(f.sessionFileRefs[0].fileId, 'sf_x');
});

t('buildPromptFrame omits sessionFileRefs when nothing was uploaded', () => {
  const f = buildPromptFrame({
    session: { path: 'p' },
    text: 'hi',
    inputId: 'm-11',
    attachments: [{ kind: 'file', name: '还没传.pdf', base64: FILE_READY_FLAG }],
  });
  assert.equal('sessionFileRefs' in f, false);
  assert.equal('images' in f, false);
});

t('validateForSend accepts file attachments and rejects junk ones', () => {
  assert.equal(validateForSend([{ mimeType: 'application/pdf', data: FILE_READY_FLAG }]), null);
  assert.match(
    validateForSend([{ mimeType: 'application/x-msdownload', data: FILE_READY_FLAG }]),
    /不支持的文件格式/,
  );
  const many = Array.from({ length: MAX_FILES + 1 }, () => ({ mimeType: 'application/pdf', data: FILE_READY_FLAG }));
  assert.match(validateForSend(many), new RegExp(`${MAX_FILES} 个文件`));
});

t('validateForSend keeps image and file budgets apart', () => {
  const list = [
    ...Array.from({ length: MAX_IMAGES }, () => ({ mimeType: 'image/png', data: 'AAAA' })),
    { mimeType: 'application/pdf', data: FILE_READY_FLAG },
  ];
  assert.equal(validateForSend(list), null, '10 张图 + 1 个文件不冲突，各算各的上限');
});

/* ---- 上传：POST /api/upload-blob ---- */

function fakeApi(handler) {
  const calls = [];
  return {
    calls,
    api: async (pathname, init = {}) => {
      calls.push({ pathname, init });
      return handler(pathname, init);
    },
  };
}

const cases = [];
function ta(name, fn) {
  cases.push({ name, fn });
}

function installFileReader() {
  globalThis.FileReader = class MockFileReader {
    readAsDataURL(blob) {
      setTimeout(() => {
        this.result = `data:${blob?.type || 'application/octet-stream'};base64,${blob?._b64 || ''}`;
        if (typeof this.onload === 'function') this.onload();
      }, 0);
    }
  };
}
installFileReader();

const makeDoc = (name, types = {}) => ({
  name,
  type: types.type ?? '',
  size: types.size ?? 1024,
  _b64: types.b64 ?? 'UERG',
});

ta('uploadSessionFile posts base64 to /api/upload-blob and returns the fileId', async () => {
  const { api, calls } = fakeApi(() => ({ uploads: [{ fileId: 'sf_new', name: '合同.pdf', mime: 'application/pdf', size: 1024 }] }));
  const out = await uploadSessionFile(makeDoc('合同.pdf', { type: 'application/pdf' }), {
    api,
    sessionPath: 'C:/s/x.jsonl',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, UPLOAD_BLOB_PATH);
  assert.equal(calls[0].init.method, 'POST');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.sessionPath, 'C:/s/x.jsonl');
  assert.equal(body.name, '合同.pdf');
  assert.equal(body.base64Data, 'UERG');
  assert.equal(body.mimeType, 'application/pdf');
  assert.equal(body.presentation, 'attachment');
  assert.deepEqual(out, { fileId: 'sf_new', name: '合同.pdf', mimeType: 'application/pdf', bytes: 1024 });
});

ta('uploadSessionFile surfaces the host rejection in Chinese', async () => {
  const { api } = fakeApi(() => ({ uploads: [{ error: 'unsupported mimeType' }] }));
  await assert.rejects(
    () => uploadSessionFile(makeDoc('a.pdf', { type: 'application/pdf' }), { api, sessionPath: 'p' }),
    /宿主不接受这种文件格式/,
  );
  const second = fakeApi(() => ({ uploads: [{ error: 'blob too large (max 12582912 bytes)' }] }));
  await assert.rejects(
    () => uploadSessionFile(makeDoc('a.pdf', { type: 'application/pdf' }), { api: second.api, sessionPath: 'p' }),
    /9\.0 MB/,
  );
});

ta('uploadSessionFile refuses oversized files without touching the network', async () => {
  const { api, calls } = fakeApi(() => ({}));
  await assert.rejects(
    () => uploadSessionFile(makeDoc('huge.pdf', { type: 'application/pdf', size: MAX_FILE_BYTES + 1 }), { api, sessionPath: 'p' }),
    /9\.0 MB/,
  );
  assert.equal(calls.length, 0);
});

ta('uploadSessionFile needs a session path', async () => {
  const { api, calls } = fakeApi(() => ({}));
  await assert.rejects(
    () => uploadSessionFile(makeDoc('a.pdf', { type: 'application/pdf' }), { api, sessionPath: '' }),
    /还没有会话/,
  );
  assert.equal(calls.length, 0);
});

ta('uploadSessionFile refuses a response without fileId', async () => {
  const { api } = fakeApi(() => ({ uploads: [{}] }));
  await assert.rejects(
    () => uploadSessionFile(makeDoc('a.pdf', { type: 'application/pdf' }), { api, sessionPath: 'p' }),
    /没有返回文件 ID/,
  );
});

ta('uploadSessionFile reports a slow network as a timeout, not as a host rejection', async () => {
  const timeout = Object.assign(new Error('请求超时：/api/upload-blob'), { code: 'timeout' });
  const { api } = fakeApi(() => { throw timeout; });
  await assert.rejects(
    () => uploadSessionFile(makeDoc('a.pdf', { type: 'application/pdf' }), { api, sessionPath: 'p' }),
    /上传超时/,
  );
});

ta('fileToBase64 reads a File through FileReader', async () => {
  const b64 = await fileToBase64({ type: 'application/pdf', _b64: 'QUJDRA==' });
  assert.equal(b64, 'QUJDRA==');
});

for (const c of cases) {
  try {
    await c.fn();
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${c.name}\n      ${err.message}`);
  }
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
