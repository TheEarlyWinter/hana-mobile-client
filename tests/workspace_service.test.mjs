/* tests/workspace_service.test.mjs
 *
 * 工作区服务层契约测试
 * 覆盖：
 * 1. normalizeSubdir: 拒绝绝对路径、盘符、UNC 与 .. 逃逸
 * 2. validateFileName: 拒绝斜杠、控制字符、. 和 ..
 * 3. list: 默认 root 要求 agentId、HTTP 200 ok:false 报错、超时中断
 * 4. readTextPreview: 有界文本拉取（<=64KiB），返回 truncated 标志，不读全量 8MiB
 * 5. readFullBytes: 严格校验 offset、length、decoded 长度、totalBytes 安全整型与版本一致性
 * 6. upload: 限制校验、零字节拦截、逐文件结果检查
 * 7. downloadUrl: 规范 URL 生成
 * 8. listRoots: GET /api/studio/workspaces 真实根发现与业务错误
 * 9. 宿主限制：content-chunk 无 version、>20MiB 413 不伪造截断成功
 */

import assert from 'node:assert/strict';
import {
  createWorkspaceService,
  normalizeSubdir,
  validateFileName,
  detectRasterImageMime,
  isTextPreviewable,
  MOBILE_MAX_SINGLE_FILE_BYTES,
  MOBILE_MAX_TOTAL_UPLOAD_BYTES,
  MOBILE_MAX_UPLOAD_FILES_COUNT,
  PREVIEW_MAX_BYTES,
  PREVIEW_MAX_CHUNKS,
  TEXT_PREVIEW_MAX_BYTES,
} from '../web/workspace-service.js';

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

/** 断言 promise 在 ms 内以拒绝结束；超时本身算测试失败，而不是被当成拒绝。 */
async function rejectsWithin(promise, ms, pattern) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`did_not_settle_within_${ms}ms`);
      err.code = 'test_deadline';
      reject(err);
    }, ms);
  });
  try {
    try {
      await Promise.race([promise, deadline]);
    } catch (err) {
      if (err?.code === 'test_deadline') throw err;
      if (pattern) assert.match(String(err.message || err), pattern);
      return err;
    }
    assert.fail('期望请求被拒绝，但它成功完成了');
  } finally {
    clearTimeout(timer);
  }
}

function mockResponse(data, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return {
    ok,
    status,
    statusText,
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  };
}

/* ------------------------------------------------------------------ */
/* 1. 路径与文件名安全校验测试                                         */
/* ------------------------------------------------------------------ */

await t('normalizeSubdir: 拒绝绝对路径、盘符、UNC 与 .. 逃逸', () => {
  assert.equal(normalizeSubdir(''), '');
  assert.equal(normalizeSubdir('foo/bar'), 'foo/bar');
  assert.equal(normalizeSubdir('nested\\dir'), 'nested/dir');

  // 严禁以斜杠开头的绝对路径（不能静默转成相对路径）
  assert.throws(() => normalizeSubdir('/foo/bar'), /absolute_path_rejected/);
  assert.throws(() => normalizeSubdir('\\windows'), /absolute_path_rejected/);

  // 严禁盘符与驱动器
  assert.throws(() => normalizeSubdir('C:/secret'), /drive_path_rejected/);
  assert.throws(() => normalizeSubdir('d:\\data'), /drive_path_rejected/);

  // 严禁 UNC 路径
  assert.throws(() => normalizeSubdir('\\\\server\\share'), /unc_path_rejected/);

  // 严禁 .. 路径逃逸
  assert.throws(() => normalizeSubdir('../secret'), /path_traversal/);
  assert.throws(() => normalizeSubdir('foo/../../bar'), /path_traversal/);
  assert.throws(() => normalizeSubdir('..'), /path_traversal/);
});

await t('validateFileName: 拒绝斜杠、控制字符、. 和 .. 并保留合法文件名', () => {
  assert.equal(validateFileName('hello.txt'), 'hello.txt');
  assert.equal(validateFileName('my photo (1).png'), 'my photo (1).png');

  // 拒绝空、点、双点
  assert.throws(() => validateFileName(''), /invalid_file_name/);
  assert.throws(() => validateFileName('.'), /invalid_file_name/);
  assert.throws(() => validateFileName('..'), /invalid_file_name/);

  // 拒绝包含路径分隔符
  assert.throws(() => validateFileName('a/b.txt'), /invalid_file_name/);
  assert.throws(() => validateFileName('a\\b.txt'), /invalid_file_name/);

  // 拒绝包含控制字符 (ASCII < 32)
  assert.throws(() => validateFileName('test\n.txt'), /invalid_file_name/);
  assert.throws(() => validateFileName('test\0.txt'), /invalid_file_name/);
});

await t('validateFileName: 首尾空白整体拒绝，绝不 trim 改名', () => {
  for (const name of [' foo.txt', 'foo.txt ', '\tfoo.txt', 'foo.txt\t', '\u00a0foo.txt']) {
    assert.throws(() => validateFileName(name), /invalid_file_name/, `应拒绝 ${JSON.stringify(name)}`);
  }

  // 合法原串原样保留：内部空格、%20 字面量都不得二次 decode/trim
  assert.equal(validateFileName('my photo (1).png'), 'my photo (1).png');
  assert.equal(validateFileName('a  b.txt'), 'a  b.txt');
  assert.equal(validateFileName('%20foo.txt'), '%20foo.txt');
});

/* ------------------------------------------------------------------ */
/* 2. 类型嗅探与文本可读性测试                                         */
/* ------------------------------------------------------------------ */

await t('detectRasterImageMime: 基于 Magic Bytes 准确判断图片格式', () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  assert.equal(detectRasterImageMime(pngBytes), 'image/png');

  const jpegBytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]);
  assert.equal(detectRasterImageMime(jpegBytes), 'image/jpeg');

  const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  assert.equal(detectRasterImageMime(gifBytes), 'image/gif');

  const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assert.equal(detectRasterImageMime(webpBytes), 'image/webp');

  const bmpBytes = new Uint8Array([0x42, 0x4D, 0, 0]);
  assert.equal(detectRasterImageMime(bmpBytes), 'image/bmp');

  const txtBytes = new Uint8Array([0x68, 0x65, 0x6C, 0x6C, 0x6F]);
  assert.equal(detectRasterImageMime(txtBytes), null);
});

await t('isTextPreviewable: 判定文本预览扩展名', () => {
  assert.equal(isTextPreviewable('README.md'), true);
  assert.equal(isTextPreviewable('index.html'), true);
  assert.equal(isTextPreviewable('icon.svg'), true);
  assert.equal(isTextPreviewable('app.js'), true);
  assert.equal(isTextPreviewable('config.json'), true);
  assert.equal(isTextPreviewable('style.css'), true);
  assert.equal(isTextPreviewable('archive.zip'), false);
  assert.equal(isTextPreviewable('binary.exe'), false);
});

/* ------------------------------------------------------------------ */
/* 3. list: 参数校验、HTTP 200 错误处理与超时保护                       */
/* ------------------------------------------------------------------ */

await t('list: 默认 root 必须显式要求 agentId', async () => {
  const service = createWorkspaceService({ fetchImpl: async () => mockResponse({}) });
  await assert.rejects(
    async () => service.list({ mountId: 'default' }),
    /agent_id_required/
  );
});

await t('list: HTTP 200 返回 ok: false 或包含 error 时抛出异常', async () => {
  const fakeFetch = async () => mockResponse({
    ok: false,
    error: 'invalid_path',
  });

  const service = createWorkspaceService({ fetchImpl: fakeFetch });
  await assert.rejects(
    async () => service.list({ mountId: 'default', agentId: 'hakimi' }, 'invalid_dir'),
    /invalid_path/
  );
});

await t('list: 超时中断保护', async () => {
  const hangingFetch = async (url, { signal } = {}) => {
    return new Promise((_, reject) => {
      if (signal) {
        signal.addEventListener('abort', () => {
          const err = new Error('request_timeout');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  };

  const service = createWorkspaceService({ fetchImpl: hangingFetch, timeoutMs: 30 });
  await assert.rejects(
    async () => service.list({ mountId: 'default', agentId: 'hakimi' }),
    /timeout/
  );
});

await t('list: 响应头已返回但 json() 永不解析时仍有限超时（abort 无效也不能挂死）', async () => {
  const service = createWorkspaceService({
    timeoutMs: 30,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => new Promise(() => {}),
      text: () => new Promise(() => {}),
    }),
  });

  const err = await rejectsWithin(
    service.list({ mountId: 'default', agentId: 'hakimi' }),
    500,
    /timeout/
  );
  assert.equal(err.code, 'request_timeout');
});

/* ------------------------------------------------------------------ */
/* 3b. listRoots: GET /api/studio/workspaces 真实根发现                 */
/* ------------------------------------------------------------------ */

await t('listRoots: 读取 /api/studio/workspaces 并保留真实根字段', async () => {
  const urls = [];
  const service = createWorkspaceService({
    fetchImpl: async (url) => {
      urls.push(url);
      return mockResponse({
        studioId: 'studio-1',
        localDeviceName: 'DESKTOP-01',
        workspaces: [
          {
            workspaceId: 'ws-1',
            mountId: 'mount-alpha',
            label: '项目 Alpha',
            sourceKind: 'folder',
            provider: 'local',
            presentation: { icon: 'folder' },
            capabilities: ['files.read'],
            access: { mode: 'read' },
            rootAvailable: true,
            nodeOnline: true,
            homeOfAgents: ['agent-1'],
          },
        ],
      });
    },
  });

  const res = await service.listRoots();
  assert.deepEqual(urls, ['/api/studio/workspaces']);
  assert.equal(res.ok, true);
  assert.equal(res.studioId, 'studio-1');
  assert.equal(res.localDeviceName, 'DESKTOP-01');
  assert.equal(res.workspaces.length, 1);
  assert.deepEqual(res.workspaces[0], {
    workspaceId: 'ws-1',
    mountId: 'mount-alpha',
    label: '项目 Alpha',
    sourceKind: 'folder',
    provider: 'local',
    presentation: { icon: 'folder' },
    capabilities: ['files.read'],
    access: { mode: 'read' },
    rootAvailable: true,
    nodeOnline: true,
    homeOfAgents: ['agent-1'],
  });
});

await t('listRoots: HTTP 200 业务 error 必须抛出，不返回空 roots 冒充成功', async () => {
  for (const body of [
    { ok: false, error: 'insufficient_scope' },
    { error: 'files_read_denied' },
  ]) {
    const service = createWorkspaceService({ fetchImpl: async () => mockResponse(body) });
    await assert.rejects(async () => service.listRoots(), new RegExp(body.error));
  }

  const invalid = createWorkspaceService({
    fetchImpl: async () => mockResponse({ studioId: 's' }),
  });
  await assert.rejects(async () => invalid.listRoots(), /invalid_roots_response/);
});

await t('listRoots: 无 mountId 的条目被跳过，不伪造根身份', async () => {
  const service = createWorkspaceService({
    fetchImpl: async () => mockResponse({
      studioId: 's',
      workspaces: [
        { workspaceId: 'bad', label: '没有 mountId' },
        { workspaceId: 'ok', mountId: 'mount-ok', label: '可用根' },
      ],
    }),
  });
  const res = await service.listRoots();
  assert.equal(res.workspaces.length, 1);
  assert.equal(res.workspaces[0].mountId, 'mount-ok');
});

await t('readTextPreview: 宿主 20MiB 上限的 413 必须原样暴露，不伪造截断成功', async () => {
  const service = createWorkspaceService({
    fetchImpl: async () => mockResponse(
      { error: 'file_too_large', maxBytes: 20 * 1024 * 1024 },
      { ok: false, status: 413, statusText: 'Payload Too Large' }
    ),
  });

  const err = await rejectsWithin(
    service.readTextPreview(
      { mountId: 'default', agentId: 'hakimi' },
      { name: 'huge.txt', maxBytes: 64 * 1024 }
    ),
    1000,
    /file_too_large/
  );
  assert.equal(err.status, 413);
  assert.equal(err.data.error, 'file_too_large');
});

/* ------------------------------------------------------------------ */
/* 4. readTextPreview: 有界文本读取 (<=64KiB)，不拉取全量 8MiB         */
/* ------------------------------------------------------------------ */

await t('readTextPreview: 仅读取前 64KiB 并返回 truncated 标志', async () => {
  // 用满 64KiB 的合法块，服务端一次返回整块、total 仍远大于 cap
  const chunkText = 'x'.repeat(64 * 1024);
  const chunkBase64 = Buffer.from(chunkText).toString('base64');
  const requestedLengths = [];
  let requests = 0;

  const fakeFetch = async (url) => {
    const u = new URL(url, 'http://localhost');
    const maxLength = Number(u.searchParams.get('maxLength'));
    const offset = Number(u.searchParams.get('offset'));
    requestedLengths.push(maxLength);
    requests += 1;

    assert.equal(offset, 0);
    return mockResponse({
      ok: true,
      filename: 'huge_log.txt',
      offset: 0,
      length: chunkText.length,
      totalBytes: 5 * 1024 * 1024, // 5MiB 文件
      eof: false,
      data: chunkBase64,
      version: 'v1',
    });
  };

  const service = createWorkspaceService({ fetchImpl: fakeFetch });
  const res = await service.readTextPreview(
    { mountId: 'default', agentId: 'hakimi' },
    { name: 'huge_log.txt', maxBytes: 64 * 1024 }
  );

  assert.equal(res.ok, true);
  assert.equal(res.text, chunkText);
  assert.equal(res.truncated, true);
  assert.equal(res.totalBytes, 5 * 1024 * 1024);
  assert.ok(requestedLengths[0] <= 64 * 1024, '单次请求上限不得超过 64KiB');
  assert.equal(requests, 1, '读满硬上限后必须停止，不能继续拉取');
});

await t('readTextPreview: 多块累计仍硬封顶 64KiB，且每块长度/offset 严格校验', async () => {
  const total = 128 * 1024;
  const piece = 'a'.repeat(32 * 1024);
  const requested = [];

  const fakeFetch = async (url) => {
    const u = new URL(url, 'http://localhost');
    const offset = Number(u.searchParams.get('offset'));
    const maxLength = Number(u.searchParams.get('maxLength'));
    requested.push({ offset, maxLength });
    return mockResponse({
      ok: true,
      filename: 'long.txt',
      offset,
      length: piece.length,
      totalBytes: total,
      eof: offset + piece.length >= total,
      data: Buffer.from(piece).toString('base64'),
    });
  };

  const service = createWorkspaceService({ fetchImpl: fakeFetch });
  const res = await service.readTextPreview(
    { mountId: 'default', agentId: 'hakimi' },
    { name: 'long.txt', maxBytes: 1024 * 1024 }
  );

  assert.equal(res.text.length, 64 * 1024);
  assert.equal(res.truncated, true);
  assert.equal(requested.length, 2);
  assert.equal(requested[0].maxLength, 64 * 1024);
  assert.equal(requested[1].maxLength, 32 * 1024);
  assert.ok(requested.every((r) => r.maxLength <= 64 * 1024));
});

await t('readTextPreview: 提前 EOF / 非法 base64 同样拒绝', async () => {
  const service = createWorkspaceService({
    fetchImpl: async () => mockResponse({
      ok: true,
      filename: 'bad.txt',
      offset: 0,
      length: 4,
      totalBytes: 100,
      eof: true,
      data: Buffer.from('abcd').toString('base64'),
    }),
  });
  await assert.rejects(
    async () => service.readTextPreview(
      { mountId: 'default', agentId: 'hakimi' },
      { name: 'bad.txt' }
    ),
    /eof_mismatch/
  );

  const badB64 = createWorkspaceService({
    fetchImpl: async () => mockResponse({
      ok: true,
      filename: 'bad.txt',
      offset: 0,
      length: 4,
      totalBytes: 4,
      eof: true,
      data: '!!!!',
    }),
  });
  await assert.rejects(
    async () => badB64.readTextPreview(
      { mountId: 'default', agentId: 'hakimi' },
      { name: 'bad.txt' }
    ),
    /invalid_base64/
  );
});

/* ------------------------------------------------------------------ */
/* 5. readFullBytes: 严格校验 offset, length, totalBytes 与容量计算      */
/* ------------------------------------------------------------------ */

await t('readFullBytes: offset 错位或 decoded 长度不符时报错', async () => {
  const fakeFetch = async () => mockResponse({
    ok: true,
    filename: 'corrupt.bin',
    offset: 100, // 期望从 0 开始，返回了 100
    length: 10,
    totalBytes: 200,
    eof: false,
    data: Buffer.from('1234567890').toString('base64'),
  });

  const service = createWorkspaceService({ fetchImpl: fakeFetch });
  await assert.rejects(
    async () => service.readFullBytes({ mountId: 'default', agentId: 'hakimi' }, { name: 'corrupt.bin' }),
    /offset_mismatch/
  );
});

await t('readFullBytes: totalBytes 非安全整型或缺失时报错', async () => {
  const fakeFetch = async () => mockResponse({
    ok: true,
    filename: 'no_total.bin',
    offset: 0,
    length: 5,
    totalBytes: null, // 缺失
    eof: false,
    data: Buffer.from('hello').toString('base64'),
  });

  const service = createWorkspaceService({ fetchImpl: fakeFetch });
  await assert.rejects(
    async () => service.readFullBytes({ mountId: 'default', agentId: 'hakimi' }, { name: 'no_total.bin' }),
    /invalid_total_bytes/
  );
});

await t('readFullBytes: 非法 base64（含非规范填充）拒绝', async () => {
  for (const data of ['!!!!', 'QR==', 'QQ=', 'QUJD\n']) {
    const service = createWorkspaceService({
      fetchImpl: async () => mockResponse({
        ok: true,
        filename: 'bad.bin',
        offset: 0,
        length: 4,
        totalBytes: 4,
        eof: true,
        data,
      }),
    });
    await assert.rejects(
      async () => service.readFullBytes(
        { mountId: 'default', agentId: 'hakimi' },
        { name: 'bad.bin' }
      ),
      /invalid_base64/,
      `应拒绝 base64 ${JSON.stringify(data)}`
    );
  }
});

await t('readFullBytes: length 必须等于 decoded 长度、<= 本轮 maxLength，eof 必须是 bool 且与范围一致', async () => {
  const lengthMismatch = createWorkspaceService({
    fetchImpl: async () => mockResponse({
      ok: true,
      filename: 'x.bin',
      offset: 0,
      length: 5,
      totalBytes: 5,
      eof: true,
      data: Buffer.from('abcd').toString('base64'),
    }),
  });
  await assert.rejects(
    async () => lengthMismatch.readFullBytes(
      { mountId: 'default', agentId: 'hakimi' },
      { name: 'x.bin' }
    ),
    /length_mismatch/
  );

  const exceedsMax = createWorkspaceService({
    fetchImpl: async () => mockResponse({
      ok: true,
      filename: 'x.bin',
      offset: 0,
      length: 5,
      totalBytes: 5,
      eof: true,
      data: Buffer.from('abcde').toString('base64'),
    }),
  });
  await assert.rejects(
    async () => exceedsMax.readFullBytes(
      { mountId: 'default', agentId: 'hakimi' },
      { name: 'x.bin', maxBytes: 4 }
    ),
    /length_exceeds_max/
  );

  const eofType = createWorkspaceService({
    fetchImpl: async () => mockResponse({
      ok: true,
      filename: 'x.bin',
      offset: 0,
      length: 4,
      totalBytes: 4,
      eof: 'true',
      data: Buffer.from('abcd').toString('base64'),
    }),
  });
  await assert.rejects(
    async () => eofType.readFullBytes(
      { mountId: 'default', agentId: 'hakimi' },
      { name: 'x.bin' }
    ),
    /invalid_eof/
  );

  const earlyEof = createWorkspaceService({
    fetchImpl: async () => mockResponse({
      ok: true,
      filename: 'x.bin',
      offset: 0,
      length: 2,
      totalBytes: 10,
      eof: true,
      data: Buffer.from('ab').toString('base64'),
    }),
  });
  await assert.rejects(
    async () => earlyEof.readFullBytes(
      { mountId: 'default', agentId: 'hakimi' },
      { name: 'x.bin' }
    ),
    /eof_mismatch/
  );
});

await t('readFullBytes: totalBytes 每块必须相同，零进展非 EOF 拒绝', async () => {
  let calls = 0;
  const totalChanged = createWorkspaceService({
    fetchImpl: async (url) => {
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
      calls += 1;
      return mockResponse({
        ok: true,
        filename: 'x.bin',
        offset,
        length: 2,
        totalBytes: offset === 0 ? 4 : 5,
        eof: false,
        data: Buffer.from(offset === 0 ? 'ab' : 'cd').toString('base64'),
      });
    },
  });
  await assert.rejects(
    async () => totalChanged.readFullBytes(
      { mountId: 'default', agentId: 'hakimi' },
      { name: 'x.bin' }
    ),
    /total_bytes_changed/
  );
  assert.equal(calls, 2);

  const noProgress = createWorkspaceService({
    fetchImpl: async () => mockResponse({
      ok: true,
      filename: 'x.bin',
      offset: 0,
      length: 0,
      totalBytes: 10,
      eof: false,
      data: '',
    }),
  });
  await assert.rejects(
    async () => noProgress.readFullBytes(
      { mountId: 'default', agentId: 'hakimi' },
      { name: 'x.bin' }
    ),
    /zero_progress/
  );
});

await t('readFullBytes: 0 字节合法读取返回空，不误报', async () => {
  const service = createWorkspaceService({
    fetchImpl: async () => mockResponse({
      ok: true,
      filename: 'empty.bin',
      offset: 0,
      length: 0,
      totalBytes: 0,
      eof: true,
      data: '',
    }),
  });
  const res = await service.readFullBytes(
    { mountId: 'default', agentId: 'hakimi' },
    { name: 'empty.bin' }
  );
  assert.equal(res.ok, true);
  assert.equal(res.bytes.length, 0);
  assert.equal(res.totalBytes, 0);
});

await t('readFullBytes: version 为对象时按内容比较，存在性变化报错', async () => {
  const sameVersion = createWorkspaceService({
    fetchImpl: async (url) => {
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
      return mockResponse({
        ok: true,
        filename: 'v.bin',
        offset,
        length: 2,
        totalBytes: 4,
        eof: offset + 2 >= 4,
        data: Buffer.from(offset === 0 ? 'ab' : 'cd').toString('base64'),
        version: offset === 0
          ? { rev: 1, meta: { a: 2, b: 3 } }
          : { meta: { b: 3, a: 2 }, rev: 1 },
      });
    },
  });
  const res = await sameVersion.readFullBytes(
    { mountId: 'default', agentId: 'hakimi' },
    { name: 'v.bin' }
  );
  assert.equal(Buffer.from(res.bytes).toString('utf8'), 'abcd');

  let calls = 0;
  const versionDisappears = createWorkspaceService({
    fetchImpl: async (url) => {
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
      calls += 1;
      return mockResponse({
        ok: true,
        filename: 'v.bin',
        offset,
        length: 2,
        totalBytes: 4,
        eof: offset + 2 >= 4,
        data: Buffer.from(offset === 0 ? 'ab' : 'cd').toString('base64'),
        ...(offset === 0 ? { version: { rev: 1 } } : {}),
      });
    },
  });
  await assert.rejects(
    async () => versionDisappears.readFullBytes(
      { mountId: 'default', agentId: 'hakimi' },
      { name: 'v.bin' }
    ),
    /version_conflict/
  );
  assert.equal(calls, 2);
});

await t('readFullBytes: 真实拉满 8MiB（128 × 64KiB），不是容量公式', async () => {
  const total = PREVIEW_MAX_BYTES;
  const chunkSize = 64 * 1024;
  const chunkB64 = Buffer.alloc(chunkSize, 0x41).toString('base64');
  let requests = 0;

  const service = createWorkspaceService({
    fetchImpl: async (url) => {
      const u = new URL(url, 'http://localhost');
      const offset = Number(u.searchParams.get('offset'));
      const maxLength = Number(u.searchParams.get('maxLength'));
      requests += 1;
      assert.equal(maxLength, chunkSize, '每轮都只能请求 64KiB');
      const length = Math.min(chunkSize, total - offset);
      return mockResponse({
        ok: true,
        filename: 'big.bin',
        offset,
        length,
        totalBytes: total,
        eof: offset + length >= total,
        data: chunkB64,
      });
    },
  });

  const res = await service.readFullBytes(
    { mountId: 'default', agentId: 'hakimi' },
    { name: 'big.bin' }
  );
  assert.equal(res.ok, true);
  assert.equal(res.bytes.length, total);
  assert.equal(res.totalBytes, total);
  assert.equal(res.bytes[0], 0x41);
  assert.equal(res.bytes[total - 1], 0x41);
  assert.equal(requests, 128);
});

await t('readFullBytes: 保证 8MiB 可达（容量计算满足 8MiB 规格）', async () => {
  assert.equal(PREVIEW_MAX_BYTES, 8 * 1024 * 1024);
  // 128 块 * 64KiB = 8MiB
  assert.ok(PREVIEW_MAX_CHUNKS * 64 * 1024 >= PREVIEW_MAX_BYTES);
});

/* ------------------------------------------------------------------ */
/* 6. upload: 限制校验、零字节拦截、逐文件结果检查                      */
/* ------------------------------------------------------------------ */

await t('upload: 零字节文件明确拒绝不发起 POST', async () => {
  let postCalled = false;
  const fakeFetch = async () => { postCalled = true; return mockResponse({}); };
  const service = createWorkspaceService({ fetchImpl: fakeFetch });

  await assert.rejects(
    async () => service.upload(
      { mountId: 'default', agentId: 'hakimi' },
      { files: [{ name: 'empty.txt', contentBase64: '' }] }
    ),
    /empty_file_not_supported/
  );
  assert.equal(postCalled, false);
});

await t('upload: 非法 base64 拒绝且不发起 POST', async () => {
  let postCalled = false;
  const fakeFetch = async () => { postCalled = true; return mockResponse({}); };
  const service = createWorkspaceService({ fetchImpl: fakeFetch });

  await assert.rejects(
    async () => service.upload(
      { mountId: 'default', agentId: 'hakimi' },
      { files: [{ name: 'bad.txt', contentBase64: '!!!!' }] }
    ),
    /invalid_base64/
  );
  assert.equal(postCalled, false);
});

await t('upload: 超出移动端保守限制拒绝上传', async () => {
  const service = createWorkspaceService({ fetchImpl: async () => mockResponse({}) });

  // 超过 10 个文件
  const elevenFiles = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, contentBase64: 'MQ==' }));
  await assert.rejects(
    async () => service.upload({ mountId: 'default', agentId: 'hakimi' }, { files: elevenFiles }),
    /too_many_files/
  );
});

await t('upload: HTTP 200 部分失败不可吞', async () => {
  const fakeFetch = async () => mockResponse({
    ok: false,
    rootId: 'default',
    mountId: 'default',
    results: [
      { name: 'success.txt', ok: true, size: 5 },
      { name: 'fail.txt', ok: false, error: 'disk_full' },
    ],
  });

  const service = createWorkspaceService({ fetchImpl: fakeFetch });
  const res = await service.upload(
    { mountId: 'default', agentId: 'hakimi' },
    { files: [{ name: 'success.txt', contentBase64: 'MQ==' }, { name: 'fail.txt', contentBase64: 'Mg==' }] }
  );

  assert.equal(res.ok, false);
  assert.equal(res.results.length, 2);
  assert.equal(res.results[0].ok, true);
  assert.equal(res.results[1].ok, false);
  assert.equal(res.results[1].error, 'disk_full');
});

await t('previewChunk: 不发送宿主 dct 不存在的 versioned 字段', async () => {
  let capturedUrl = null;
  const service = createWorkspaceService({
    fetchImpl: async (url) => {
      capturedUrl = url;
      return mockResponse({ ok: true });
    },
  });
  await service.previewChunk(
    { mountId: 'default', agentId: 'hakimi' },
    { name: 'a.txt', offset: 0, maxLength: 16 }
  );
  const url = new URL(capturedUrl, 'http://localhost');
  assert.equal(url.searchParams.has('versioned'), false);
  assert.equal(url.searchParams.get('offset'), '0');
  assert.equal(url.searchParams.get('maxLength'), '16');
});

/* ------------------------------------------------------------------ */
/* 7. downloadUrl 规范 URL 生成                                        */
/* ------------------------------------------------------------------ */

await t('downloadUrl: 规范同源 URL 生成并正确转义', () => {
  const service = createWorkspaceService();
  const url = service.downloadUrl(
    { mountId: 'default', agentId: 'hakimi' },
    { subdir: 'my docs', name: 'photo 1.png' }
  );
  assert.equal(
    url,
    '/api/mobile/workspace/content?mountId=default&agentId=hakimi&subdir=my%20docs&name=photo%201.png'
  );
});

if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
