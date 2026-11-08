/* /gw/file 按路径读文档：会话文件卡（xlsx/pptx/pdf/docx…）在手机上的唯一读法
 *
 * 真机 bug：点开文件卡报「文件读取失败（400）」，网关日志显示
 * `GET /api/resources/sf_…/content` → 上游 400。会话文件条目其实带绝对路径
 * （`filePath`），但宿主对 agent 生成/外部存储的文件（storageKind: "external"）
 * 在资源地址上回 400；前端只能退到 `/gw/file/<b64url(path)>`，而这条路由过去
 * 只放行图片、且只认 HANA_HOME 三个目录。
 *
 * 本文件锁的行为（真起 gateway/server.mjs 子进程 + 假上游）：
 *   1. HANA_HOME 三个目录里的文档能按路径读：状态/MIME/nosniff/逐字节正文；
 *   2. 工作区根里的文档也能读（根来自上游 /api/studio/workspaces，按 Cookie 隔离、60s 缓存）；
 *   3. 放行表只多了文档扩展名：可执行文件、未知扩展名一律 403；
 *   4. 越权仍拒绝：根外路径、`..`、软链接/junction 指向根外 → 403，不变成任意读；
 *   5. HEAD 只回头；
 *   6. 上游 /api/studio/workspaces 挂掉 / 500 / 非 JSON 时，HANA_HOME 里的文件照旧能读，
 *      工作区文件降级成 403（不是 500）；
 *   7. 缓存：同一 Cookie 60 秒内复用成功结果，换 Cookie 必须重新取根。
 *
 * 上游是 127.0.0.1 上的假服务，不碰真实凭据、真实网关或设备。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import { b64url as webB64url, createSessionFileUrls } from '../web/file-urls.js';
import { buildWorkspaceContentUrl, matchWorkspaceByLabel, workspaceUrlForFile } from '../web/file-source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.resolve(__dirname, '..', 'gateway', 'server.mjs');

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** 有效登录 Cookie（假上游只认这个）。 */
const COOKIE = 'hana_session=valid';
/** 同一个登录态的另一条 Cookie：缓存键不同，用来观察「取根真的又发了一次」。 */
const COOKIE_OTHER = 'hana_session=valid; probe=second';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/* ------------------------------------------------------------------ */
/* 基础设施                                                            */
/* ------------------------------------------------------------------ */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function request(port, rawPath, { method = 'GET', cookie, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { connection: 'close' };
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`request timeout: ${rawPath}`)));
    req.on('error', reject);
    req.end();
  });
}

function waitTcp(port, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`gateway 未就绪（port ${port}）`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const fileUrl = (absPath) => `/gw/file/${b64url(absPath)}`;

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-gw-read-'));
const hanaHome = path.join(tmpRoot, 'hana-home');
const sessionFiles = path.join(hanaHome, 'session-files');
const uploadsDir = path.join(hanaHome, 'uploads');
const attachmentsDir = path.join(hanaHome, 'attachments');
const workRoot = path.join(tmpRoot, 'work', 'workspace');
const outsideDir = path.join(tmpRoot, 'outside');

await fsp.mkdir(sessionFiles, { recursive: true });
await fsp.mkdir(uploadsDir, { recursive: true });
await fsp.mkdir(attachmentsDir, { recursive: true });
await fsp.mkdir(workRoot, { recursive: true });
await fsp.mkdir(outsideDir, { recursive: true });

// xlsx 用「看起来像 zip 头」的字节：网关不该解析内容，只按扩展名决定类型、逐字节发出。
const XLSX_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('报表正文-SHEET-2026', 'utf8'),
  Buffer.alloc(512, 0x41),
]);
const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'utf8');
const DOCX_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('WORD-正文', 'utf8')]);
const CSV_BYTES = Buffer.from('name,qty\n报表,2\n', 'utf8');
const TXT_BYTES = Buffer.from('纯文本文档 CONTENT\n', 'utf8');

const sheetPath = path.join(sessionFiles, '报表 2026.xlsx');
const pdfPath = path.join(sessionFiles, 'report.pdf');
const txtPath = path.join(sessionFiles, 'notes.txt');
const picPath = path.join(sessionFiles, 'pic.png');
const exePath = path.join(sessionFiles, 'setup.exe');
const weirdPath = path.join(sessionFiles, 'mystery.xyz');
const workDocPath = path.join(workRoot, '报告.docx');
const workCsvPath = path.join(workRoot, 'data.csv');
const outsidePath = path.join(outsideDir, 'secret.txt');

await fsp.writeFile(sheetPath, XLSX_BYTES);
await fsp.writeFile(pdfPath, PDF_BYTES);
await fsp.writeFile(txtPath, TXT_BYTES);
await fsp.writeFile(picPath, TINY_PNG);
await fsp.writeFile(exePath, 'MZ_NOT_ALLOWED');
await fsp.writeFile(weirdPath, 'MYSTERY');
await fsp.writeFile(workDocPath, DOCX_BYTES);
await fsp.writeFile(workCsvPath, CSV_BYTES);
await fsp.writeFile(outsidePath, 'OUTSIDE_SECRET');

/** 软链接/junction：字面路径在根里，真实路径在根外。 */
const escapeLink = path.join(sessionFiles, 'escape');
let escapeReady = true;
try {
  await fsp.symlink(outsideDir, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');
} catch (err) {
  // 没权限建链接时不能假装测过越界：后面那几条会明确报告「夹具不可用」。
  escapeReady = false;
  console.log(`SKIP-SETUP 软链接/联接点建不出来（${err?.code || err?.message}），越界 realpath 用例将失败`);
}

/* ------------------------------------------------------------------ */
/* 假上游：登录态 + 工作区列表                                          */
/* ------------------------------------------------------------------ */

/** 'ok' | 'http500' | 'garbage' | 'reset'：控制 /api/studio/workspaces 的回答。 */
let workspaceMode = 'ok';
const workspacesCalls = [];

const upstream = http.createServer((req, res) => {
  if (req.url === '/api/web-auth/session') {
    const authed = String(req.headers.cookie || '').includes('hana_session=valid');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ authenticated: authed, principal: authed ? { kind: 'local_user' } : null }));
  }
  if (req.url === '/api/studio/workspaces') {
    workspacesCalls.push(req.headers.cookie || '');
    if (workspaceMode === 'reset') {
      // 连响应都不给：模拟上游被掐断（网关不能因此 500）。
      req.socket.destroy();
      return;
    }
    if (workspaceMode === 'http500') {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      return res.end('{"error":"boom"}');
    }
    if (workspaceMode === 'garbage') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('<html>not json</html>');
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: true,
      studioId: 'studio-1',
      workspaces: [
        { mountId: 'mount-work', label: 'workspace', nativeRootPath: workRoot, rootAvailable: true },
        // 不可用的挂载点不能当作可读根
        { mountId: 'mount-gone', label: '离线盘', nativeRootPath: path.join(tmpRoot, 'gone'), rootAvailable: false },
      ],
    }));
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

const upstreamPort = await listen(upstream);
const gwPort = await freePort();
const gateway = spawn(process.execPath, [GATEWAY], {
  env: {
    ...process.env,
    HANA_GATEWAY_LOG: 'off',
    HANA_HOME: hanaHome,
    HANA_UPSTREAM_HOST: '127.0.0.1',
    HANA_UPSTREAM_PORT: String(upstreamPort),
    HANA_GW_HOST: '127.0.0.1',
    HANA_GW_PORT: String(gwPort),
    HANA_GW_LOG_WS: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let gatewayLog = '';
gateway.stdout.on('data', (c) => {
  gatewayLog += c.toString('utf8');
});
gateway.stderr.on('data', (c) => {
  gatewayLog += c.toString('utf8');
});

try {
  await waitTcp(gwPort);
} catch (err) {
  gateway.kill();
  throw new Error(`${err.message}\n${gatewayLog}`);
}

async function teardown() {
  if (gateway.exitCode === null) {
    gateway.kill();
    await new Promise((resolve) => gateway.once('exit', resolve));
  }
  await new Promise((resolve) => upstream.close(resolve));
  await fsp.rm(tmpRoot, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* 用例（全部先声明，下面的循环才跑）                                   */
/* ------------------------------------------------------------------ */

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('HANA_HOME 会话目录里的 xlsx：200、类型/nosniff/逐字节一致、中文名 inline', async () => {
  const res = await request(gwPort, fileUrl(sheetPath), { cookie: COOKIE });
  assert.equal(res.status, 200, `应 200，实际 ${res.status}: ${res.body.toString('utf8')}`);
  assert.equal(res.headers['content-type'], XLSX_TYPE);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(Number(res.headers['content-length']), XLSX_BYTES.length);
  assert.equal(res.body.length, XLSX_BYTES.length);
  assert.ok(res.body.equals(XLSX_BYTES), '正文必须与文件逐字节一致');

  const disposition = res.headers['content-disposition'] || '';
  assert.match(disposition, /^inline;/, `文档必须是 inline 展示，实际 ${disposition}`);
  assert.ok(
    disposition.includes("filename*=UTF-8''" + encodeURIComponent('报表 2026.xlsx')),
    `中文名要走 RFC 5987 的 filename*，实际 ${disposition}`,
  );
  // 头里不能出现非 ASCII：出现就说明有人把裸文件名塞进去了（客户端会乱码/丢头）。
  assert.ok(
    /^[\u0020-\u007e]*$/.test(disposition),
    `content-disposition 必须是纯 ASCII，实际 ${JSON.stringify(disposition)}`,
  );
});

t('图片保持旧行为：200、image/png、不带 content-disposition', async () => {
  const res = await request(gwPort, fileUrl(picPath), { cookie: COOKIE });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['content-disposition'], undefined, '图片不需要下载名');
  assert.ok(res.body.equals(TINY_PNG));
});

t('pdf / txt 的 MIME 也要对', async () => {
  const pdf = await request(gwPort, fileUrl(pdfPath), { cookie: COOKIE });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.ok(pdf.body.equals(PDF_BYTES));

  const txt = await request(gwPort, fileUrl(txtPath), { cookie: COOKIE });
  assert.equal(txt.status, 200);
  assert.equal(txt.headers['content-type'], 'text/plain; charset=utf-8');
  assert.ok(txt.body.equals(TXT_BYTES));
});

t('HEAD 只回头：状态/长度/类型与 GET 一致，正文为空', async () => {
  const res = await request(gwPort, fileUrl(sheetPath), { method: 'HEAD', cookie: COOKIE });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], XLSX_TYPE);
  assert.equal(Number(res.headers['content-length']), XLSX_BYTES.length);
  assert.ok(res.headers['content-disposition'], 'HEAD 也要带下载名');
  assert.equal(res.body.length, 0, 'HEAD 不能有正文');
});

t('放行表没被放宽成任意文件：.exe 与未知扩展名 403', async () => {
  const exe = await request(gwPort, fileUrl(exePath), { cookie: COOKIE });
  assert.equal(exe.status, 403, `可执行文件必须拒绝，实际 ${exe.status}`);
  assert.ok(!exe.body.toString('utf8').includes('MZ_NOT_ALLOWED'));

  const weird = await request(gwPort, fileUrl(weirdPath), { cookie: COOKIE });
  assert.equal(weird.status, 403, `未知扩展名必须拒绝，实际 ${weird.status}`);
  assert.ok(!weird.body.toString('utf8').includes('MYSTERY'));
});

t('根外文件 → 403（不许变成任意读）', async () => {
  const res = await request(gwPort, fileUrl(outsidePath), { cookie: COOKIE });
  assert.equal(res.status, 403);
  assert.ok(!res.body.toString('utf8').includes('OUTSIDE_SECRET'));
});

t('`..` 逃逸 → 拒绝，且拿不到根外内容', async () => {
  const escapePath = `${sessionFiles}${path.sep}..${path.sep}..${path.sep}outside${path.sep}secret.txt`;
  const res = await request(gwPort, fileUrl(escapePath), { cookie: COOKIE });
  assert.ok([403, 404].includes(res.status), `越界路径必须拒绝，实际 ${res.status}`);
  assert.ok(!res.body.toString('utf8').includes('OUTSIDE_SECRET'));
});

t('软链接/junction 指向根外 → 403（字面在根里也要按 realpath 判）', async () => {
  assert.equal(escapeReady, true, '夹具不可用：链接建不出来，这条用例等于没测');
  const res = await request(gwPort, fileUrl(path.join(escapeLink, 'secret.txt')), { cookie: COOKIE });
  assert.equal(res.status, 403, `字面路径在根里、真实路径在根外，必须 403（实际 ${res.status}）`);
  assert.ok(!res.body.toString('utf8').includes('OUTSIDE_SECRET'));
});

t('工作区根里的文档（根来自上游工作区列表）→ 200、逐字节一致', async () => {
  workspaceMode = 'ok';
  const res = await request(gwPort, fileUrl(workDocPath), { cookie: COOKIE });
  assert.equal(res.status, 200, `工作区文件应可读，实际 ${res.status}: ${res.body.toString('utf8')}`);
  assert.equal(res.headers['content-type'], DOCX_TYPE);
  assert.ok(res.body.equals(DOCX_BYTES), '正文必须与文件逐字节一致');

  const csv = await request(gwPort, fileUrl(workCsvPath), { cookie: COOKIE });
  assert.equal(csv.status, 200);
  assert.equal(csv.headers['content-type'], 'text/csv; charset=utf-8');
  assert.ok(csv.body.equals(CSV_BYTES));
});

t('缓存：同一 Cookie 60 秒内复用成功结果，换 Cookie 必须重新取根', async () => {
  // 上一条用例已经用 COOKIE 取过一次根；现在让上游坏掉，同一 Cookie 仍应命中缓存。
  workspaceMode = 'http500';
  const before = workspacesCalls.length;
  const cached = await request(gwPort, fileUrl(workDocPath), { cookie: COOKIE });
  assert.equal(cached.status, 200, '缓存命中时不该因为上游这次失败而拒绝');
  assert.equal(workspacesCalls.length, before, '同一 Cookie 命中缓存，不该再打上游');

  // 换一条 Cookie：缓存键不同，这次真的去问，而此刻上游是 500 → 只有 HANA_HOME 三个根。
  const other = await request(gwPort, fileUrl(workDocPath), { cookie: COOKIE_OTHER });
  assert.equal(other.status, 403, `换了 Cookie 就不该拿到别人的根，实际 ${other.status}`);
  assert.ok(workspacesCalls.length > before, '换 Cookie 必须重新取根');
  assert.ok(workspacesCalls.at(-1).includes(COOKIE_OTHER), '取根要用这个请求自己的 Cookie');

  const stillHome = await request(gwPort, fileUrl(sheetPath), { cookie: COOKIE_OTHER });
  assert.equal(stillHome.status, 200, 'HANA_HOME 的文件与工作区根无关，必须照旧可读');
  workspaceMode = 'ok';
});

t('上游工作区接口 500：HANA_HOME 文件照旧 200，工作区文件降级 403（不是 500）', async () => {
  workspaceMode = 'http500';
  const home = await request(gwPort, fileUrl(sheetPath), { cookie: 'hana_session=valid; probe=up500' });
  assert.equal(home.status, 200, `取根失败不能影响 HANA_HOME 里的文件，实际 ${home.status}: ${home.body.toString('utf8')}`);

  const work = await request(gwPort, fileUrl(workDocPath), { cookie: 'hana_session=valid; probe=up500' });
  assert.equal(work.status, 403, `取不到根就是能力降级（403），不是 500，实际 ${work.status}`);
  workspaceMode = 'ok';
});

t('上游工作区接口返回非 JSON：同上，不 500', async () => {
  workspaceMode = 'garbage';
  const home = await request(gwPort, fileUrl(sheetPath), { cookie: 'hana_session=valid; probe=garbage' });
  assert.equal(home.status, 200, `非 JSON 不能把 HANA_HOME 的读取带崩，实际 ${home.status}`);

  const work = await request(gwPort, fileUrl(workDocPath), { cookie: 'hana_session=valid; probe=garbage' });
  assert.equal(work.status, 403, `实际 ${work.status}`);
  workspaceMode = 'ok';
});

t('上游工作区接口把连接掐断：仍能读 HANA_HOME 的文件，不崩网关', async () => {
  workspaceMode = 'reset';
  const home = await request(gwPort, fileUrl(sheetPath), { cookie: 'hana_session=valid; probe=reset' });
  assert.equal(home.status, 200, `上游掐断不能影响 HANA_HOME 的读取，实际 ${home.status}: ${home.body.toString('utf8')}`);
  assert.ok(home.body.equals(XLSX_BYTES));

  const work = await request(gwPort, fileUrl(workDocPath), { cookie: 'hana_session=valid; probe=reset' });
  assert.equal(work.status, 403, `实际 ${work.status}`);
  workspaceMode = 'ok';

  // 网关进程仍然活着且能服务（上面两条都成功返回就说明没崩）
  const after = await request(gwPort, fileUrl(picPath), { cookie: COOKIE });
  assert.equal(after.status, 200, '上游异常后网关必须继续服务');
});

t('未登录：没有 Cookie 仍 401（这条路由不是匿名读）', async () => {
  const res = await request(gwPort, fileUrl(sheetPath));
  assert.equal(res.status, 401);
});

/* ------------------------------------------------------------------ */
/* web/file-urls.js：forFile 的退路顺序                                  */
/* ------------------------------------------------------------------ */

/** 真机上的条目形状：工作区映射失败时仍有 filePath。 */
const WORK_FILE = {
  fileId: 'sf_work',
  filePath: 'C:/work/workspace/out/report.xlsx',
  label: 'report.xlsx',
  ext: 'xlsx',
};

/** 用真实的 file-source 映射函数拼一个 fileUrls 实例，只换根列表与身份。 */
function makeFileUrls({ roots, rootsThrow = false, session = { agentId: 'agent-1' }, principal = { id: 'user-1' } }) {
  return createSessionFileUrls({
    service: {
      listRoots: async () => {
        if (rootsThrow) throw new Error('取根失败');
        return { workspaces: roots };
      },
    },
    getSession: () => session,
    getPrincipal: () => principal,
    workspaceUrlForFile,
    matchWorkspaceByLabel,
    buildWorkspaceContentUrl,
  });
}

const WORKSPACE_CONTENT = '/api/mobile/workspace/content';

t('forFile：映射不到工作区但有 filePath → readUrl 走 /gw/file，下载地址仍为 null', async () => {
  for (const variant of [
    { roots: [], rootsThrow: false, why: '工作区列表为空' },
    { roots: [], rootsThrow: true, why: '取根失败' },
    { roots: [{ mountId: 'mount-1', label: 'Other', nativeRootPath: 'C:/somewhere/else' }], rootsThrow: false, why: '路径不在任何根里' },
  ]) {
    const urls = makeFileUrls({ roots: variant.roots, rootsThrow: variant.rootsThrow });
    const { readUrl, downloadUrl } = await urls.forFile(WORK_FILE);
    assert.equal(
      readUrl,
      `/gw/file/${webB64url(WORK_FILE.filePath)}`,
      `${variant.why} 时读地址应按路径走网关，实际 ${readUrl}`,
    );
    assert.equal(downloadUrl, null, `${variant.why} 时不能给下载地址（壳不认 /gw/file）`);
  }
});

t('forFile：映射成功 → 读和下载都用工作区地址（老行为不变）', async () => {
  const urls = makeFileUrls({
    roots: [{ mountId: 'mount-1', label: 'workspace', nativeRootPath: 'C:/work/workspace' }],
  });
  const { readUrl, downloadUrl } = await urls.forFile(WORK_FILE);
  assert.ok(downloadUrl?.startsWith(WORKSPACE_CONTENT), `下载地址必须是壳认的，实际 ${downloadUrl}`);
  assert.equal(readUrl, downloadUrl, '能映射到工作区时读和下载是同一个地址');
  assert.ok(!String(readUrl).startsWith('/gw/file/'), '映射成功就不该退到按路径读');
  assert.equal(await urls.downloadUrlFor(WORK_FILE), downloadUrl, 'downloadUrlFor 单独调用也必须给同一个地址');
});

t('forFile：既没映射也没 filePath → 退回资源地址（只有 fileId 的旧文件）', async () => {
  const urls = makeFileUrls({ roots: [] });
  const { readUrl, downloadUrl } = await urls.forFile({ fileId: 'sf_old', label: 'old.txt', ext: 'txt' });
  assert.equal(readUrl, '/api/resources/sf_old/content');
  assert.equal(downloadUrl, null);
});

t('forFile：/gw/file 绝不进下载地址', async () => {
  const urls = makeFileUrls({ roots: [] });
  const { readUrl, downloadUrl } = await urls.forFile(WORK_FILE);
  assert.ok(readUrl.startsWith('/gw/file/'));
  assert.equal(downloadUrl, null);
  assert.ok(
    downloadUrl === null || !downloadUrl.startsWith('/gw/file/'),
    '壳的下载白名单只认 workspace content，/gw/file 不能当下载地址',
  );
});

/* ------------------------------------------------------------------ */
/* 跑测循环                                                            */
/* ------------------------------------------------------------------ */

let bad = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

await teardown();

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  if (gatewayLog.trim()) console.log(`--- gateway log ---\n${gatewayLog.trim()}`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
