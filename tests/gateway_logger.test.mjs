/* gateway/logger.mjs 的契约回归：JSON Lines、按天命名、query 剥离、脱敏、保留期、切段、写盘失败兜底。
 *
 * 全部用内存假 fs，不碰真实磁盘、不启动网关进程。
 */

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../gateway/logger.mjs';

const DIR = path.join(os.tmpdir(), `hana-gw-logger-${process.pid}`);
const DAY = '2026-11-05';
const FILE = path.join(DIR, `gateway-${DAY}.jsonl`);
const FIXED_NOW = () => new Date(2026, 10, 5, 17, 14, 0, 0);

function makeMemoryFs() {
  const files = new Map();
  let appendCalls = 0;
  let statCalls = 0;
  let readdirCalls = 0;
  let failWrites = false;
  let failMkdir = false;

  return {
    files,
    get appendCalls() {
      return appendCalls;
    },
    get statCalls() {
      return statCalls;
    },
    get readdirCalls() {
      return readdirCalls;
    },
    set failWrites(value) {
      failWrites = Boolean(value);
    },
    set failMkdir(value) {
      failMkdir = Boolean(value);
    },
    seed(file, content) {
      files.set(path.normalize(file), String(content));
    },
    read(file) {
      return files.get(path.normalize(file));
    },
    /** 目录里现有的文件名（不含目录）。 */
    names() {
      return [...files.keys()].map((file) => path.basename(file)).sort();
    },
    async mkdir() {
      if (failMkdir) {
        const err = new Error('EACCES: fake mkdir blocked');
        err.code = 'EACCES';
        throw err;
      }
    },
    async appendFile(file, data) {
      if (failWrites) {
        const err = new Error('EACCES: fake write blocked');
        err.code = 'EACCES';
        throw err;
      }
      appendCalls += 1;
      const key = path.normalize(file);
      files.set(key, (files.get(key) || '') + data);
    },
    async stat(file) {
      statCalls += 1;
      const key = path.normalize(file);
      if (!files.has(key)) {
        const err = new Error('ENOENT: fake file missing');
        err.code = 'ENOENT';
        throw err;
      }
      return { size: Buffer.byteLength(files.get(key), 'utf8'), isFile: () => true };
    },
    async readdir(dir) {
      readdirCalls += 1;
      const prefix = path.normalize(dir);
      return [...files.keys()]
        .filter((file) => path.dirname(file) === prefix)
        .map((file) => path.basename(file));
    },
    async unlink(file) {
      const key = path.normalize(file);
      if (!files.delete(key)) {
        const err = new Error('ENOENT: fake file missing');
        err.code = 'ENOENT';
        throw err;
      }
    },
  };
}

function recordsIn(fs, file) {
  const content = fs.read(file);
  if (!content) return [];
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('同一天的多条记录写进按日期命名的文件，逐行都是合法 JSON', async () => {
  const fs = makeMemoryFs();
  const logger = createLogger({ dir: DIR, now: FIXED_NOW, fs });

  logger.log({
    level: 'info',
    kind: 'http',
    method: 'GET',
    path: '/api/sessions',
    status: 200,
    ms: 12,
    requestId: 'req-1',
  });
  logger.log({ level: 'warn', kind: 'ws', event: 'open' });
  logger.log({ level: 'error', kind: 'lifecycle', event: 'config', detail: 'bad config' });
  await logger.flush();

  const records = recordsIn(fs, FILE);
  assert.equal(records.length, 3, '三条记录应写进同一个按日期命名的文件');
  assert.deepEqual(
    records.map((record) => record.level),
    ['info', 'warn', 'error'],
    '顺序必须保持',
  );
  assert.equal(records[0].kind, 'http');
  assert.equal(records[0].status, 200);
  assert.equal(records[0].ms, 12);
  assert.equal(records[0].requestId, 'req-1');
  assert.equal(fs.appendCalls, 1, '同一 tick 内多次 log 应合并成一次 append');
  for (const record of records) {
    assert.match(
      record.ts,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
      `ts 必须是带时区偏移的 ISO 8601：${record.ts}`,
    );
  }
});

t('HTTP path 的 query string 被剥掉', async () => {
  const fs = makeMemoryFs();
  const logger = createLogger({ dir: DIR, now: FIXED_NOW, fs });

  logger.log({
    level: 'info',
    kind: 'http',
    method: 'GET',
    path: '/api/workspace/content?token=abc&name=x.png',
    status: 200,
    ms: 3,
  });
  await logger.flush();

  const [record] = recordsIn(fs, FILE);
  assert.equal(record.path, '/api/workspace/content');
  assert.equal('requestId' in record, false, '空值字段应省略');
  assert.equal(fs.read(FILE).includes('token'), false);
});

t('敏感字段和片段在写出前被脱敏', async () => {
  const fs = makeMemoryFs();
  const logger = createLogger({ dir: DIR, now: FIXED_NOW, fs });

  logger.log({
    level: 'error',
    kind: 'http',
    method: 'POST',
    path: '/api/sessions?token=query-secret-9',
    status: 500,
    ms: 10,
    requestId: 'Bearer bearer-secret-3',
    errorCode: 'ECONNRESET',
    error:
      'upstream failed Bearer bearer-secret-4; cookie=cookie-secret-5; password: pass-secret-6; {"token":"json-secret-7"}',
    // 白名单之外的字段（正文/头）根本不会落盘。
    cookie: 'cookie-secret-8',
    authorization: 'Bearer auth-secret-10',
    body: 'response-body-secret-11',
  });
  logger.log({
    level: 'warn',
    kind: 'lifecycle',
    event: 'config',
    detail: 'x-api-key: api-secret-12',
  });
  logger.log({
    level: 'warn',
    kind: 'lifecycle',
    event: 'config',
    detail: 'authorization: Basic YmFzaWMtYXV0aC1zZWNyZXQ=',
  });
  await logger.flush();

  const raw = fs.read(FILE);
  for (const secret of [
    'query-secret-9',
    'bearer-secret-3',
    'bearer-secret-4',
    'cookie-secret-5',
    'pass-secret-6',
    'json-secret-7',
    'cookie-secret-8',
    'auth-secret-10',
    'response-body-secret-11',
    'api-secret-12',
    'YmFzaWMtYXV0aC1zZWNyZXQ=',
  ]) {
    assert.equal(raw.includes(secret), false, `日志里不应出现 ${secret}`);
  }
  assert.ok(raw.includes('[redacted]'), '敏感值应替换成 [redacted]');
});

t('error 压成一行并截到 300 字符', async () => {
  const fs = makeMemoryFs();
  const logger = createLogger({ dir: DIR, now: FIXED_NOW, fs });

  logger.log({
    level: 'error',
    kind: 'lifecycle',
    event: 'config',
    detail: 'x',
    error: `first line\nsecond line ${'a'.repeat(400)}`,
  });
  await logger.flush();

  const [record] = recordsIn(fs, FILE);
  assert.equal(record.error.includes('\n'), false, 'error 不能带换行');
  assert.equal(Array.from(record.error).length, 300, 'error 应截到 300 字符');
});

t('prune 只删除超过保留期的日志，别的不动', async () => {
  const fs = makeMemoryFs();
  fs.seed(path.join(DIR, 'gateway-2026-10-01.jsonl'), 'old\n');
  fs.seed(path.join(DIR, 'gateway-2026-10-01.2.jsonl'), 'old\n');
  fs.seed(path.join(DIR, 'gateway-2026-10-30.jsonl'), 'recent\n');
  fs.seed(path.join(DIR, 'notes.txt'), 'keep\n');
  fs.seed(path.join(DIR, 'gateway-not-a-date.jsonl'), 'keep\n');

  const logger = createLogger({
    dir: DIR,
    now: () => new Date(2026, 10, 5, 12, 0, 0, 0),
    fs,
    retentionDays: 14,
  });
  const removed = await logger.prune();

  assert.equal(removed, 2);
  assert.equal(fs.read(path.join(DIR, 'gateway-2026-10-01.jsonl')), undefined);
  assert.equal(fs.read(path.join(DIR, 'gateway-2026-10-01.2.jsonl')), undefined);
  assert.equal(fs.read(path.join(DIR, 'gateway-2026-10-30.jsonl')), 'recent\n');
  assert.equal(fs.read(path.join(DIR, 'notes.txt')), 'keep\n');
  assert.equal(fs.read(path.join(DIR, 'gateway-not-a-date.jsonl')), 'keep\n');
});

t('单文件超过 maxBytes 时切到 .1.jsonl', async () => {
  const fs = makeMemoryFs();
  const logger = createLogger({ dir: DIR, now: FIXED_NOW, fs, maxBytes: 120 });

  logger.log({ level: 'info', kind: 'http', method: 'GET', path: '/api/one', status: 200, ms: 1 });
  logger.log({ level: 'info', kind: 'http', method: 'GET', path: '/api/two', status: 200, ms: 2 });
  await logger.flush();

  const base = recordsIn(fs, FILE);
  const rotated = recordsIn(fs, path.join(DIR, `gateway-${DAY}.1.jsonl`));
  assert.equal(base.length, 1, '基础文件只放第一条');
  assert.equal(base[0].path, '/api/one');
  assert.equal(rotated.length, 1, '超限后应切到 .1.jsonl');
  assert.equal(rotated[0].path, '/api/two');
  assert.equal(fs.read(path.join(DIR, `gateway-${DAY}.2.jsonl`)), undefined);
});

t('段数超过 keepFiles 时删最旧的，当前文件仍有内容', async () => {
  const fs = makeMemoryFs();
  // maxBytes 比一行还小：每条记录都新开一段，段数完全由记录条数决定，断言不依赖行宽
  const logger = createLogger({ dir: DIR, now: FIXED_NOW, fs, maxBytes: 40, keepFiles: 3 });

  for (let i = 0; i < 6; i += 1) {
    logger.log({ level: 'info', kind: 'http', method: 'GET', path: `/api/${i}`, status: 200, ms: i });
  }
  await logger.flush();

  const names = fs.names();
  assert.deepEqual(
    names,
    [`gateway-${DAY}.3.jsonl`, `gateway-${DAY}.4.jsonl`, `gateway-${DAY}.5.jsonl`],
    `只该留最新 3 份，实际：${names.join(',')}`,
  );
  // 最旧的两份（base、.1）已被删，最新的一份有内容且是最后写的那条
  assert.equal(fs.read(FILE), undefined, '最旧的 base 应被删掉');
  const newest = recordsIn(fs, path.join(DIR, `gateway-${DAY}.5.jsonl`));
  assert.equal(newest.length, 1);
  assert.equal(newest[0].path, '/api/5', '当前文件里必须是最新那条');
});

t('低流量跨天：每天只写一点，也会按份数上限删最旧的', async () => {
  const fs = makeMemoryFs();
  fs.seed(path.join(DIR, 'gateway-2026-11-01.jsonl'), 'a\n');
  fs.seed(path.join(DIR, 'gateway-2026-11-02.jsonl'), 'b\n');
  fs.seed(path.join(DIR, 'gateway-2026-11-03.jsonl'), 'c\n');

  // 一天只有一条小记录，永远碰不到 5MB 滚动：不跨天清就会一直攒文件
  let day = 3;
  const logger = createLogger({
    dir: DIR,
    now: () => new Date(2026, 10, day, 9, 0, 0),
    fs,
    keepFiles: 2,
    maxBytes: 1024 * 1024,
  });
  day = 4;
  logger.log({ level: 'info', kind: 'http', method: 'GET', path: '/api/new-day', status: 200, ms: 1 });
  await logger.flush();

  assert.deepEqual(
    fs.names(),
    ['gateway-2026-11-03.jsonl', 'gateway-2026-11-04.jsonl'],
    `只该留最新 2 份，实际：${fs.names().join(',')}`,
  );
  assert.equal(recordsIn(fs, path.join(DIR, 'gateway-2026-11-04.jsonl')).length, 1);
});

t('重启后接着写最后一段，不回头覆盖已满的 base', async () => {
  const fs = makeMemoryFs();
  const seg1 = path.join(DIR, `gateway-${DAY}.1.jsonl`);
  const before =
    `{"ts":"2026-11-05T10:00:00.000+08:00","level":"info","kind":"http","method":"GET","path":"/api/before","status":200,"ms":1}\n`;
  fs.seed(FILE, `${'x'.repeat(400)}\n`); // base 已写满
  fs.seed(seg1, before); // .1 还有空间

  const logger = createLogger({ dir: DIR, now: FIXED_NOW, fs, maxBytes: 300, keepFiles: 5 });
  logger.log({ level: 'info', kind: 'http', method: 'GET', path: '/api/after-restart', status: 200, ms: 2 });
  await logger.flush();

  assert.equal(fs.read(FILE), `${'x'.repeat(400)}\n`, '写满的 base 不能再被写');
  assert.equal(fs.read(path.join(DIR, `gateway-${DAY}.2.jsonl`)), undefined, '没写满就不该另起一段');
  const records = recordsIn(fs, seg1);
  assert.equal(records.length, 2, '.1 应该接着写');
  assert.equal(records[1].path, '/api/after-restart');
});

t('阈内判断不做 stat：30 条记录只 stat 一次、扫目录两次', async () => {
  const fs = makeMemoryFs();
  const logger = createLogger({ dir: DIR, now: FIXED_NOW, fs, maxBytes: 1024 * 1024 });

  for (let batch = 0; batch < 3; batch += 1) {
    for (let i = 0; i < 10; i += 1) {
      logger.log({ level: 'info', kind: 'http', method: 'GET', path: `/api/${batch}-${i}`, status: 200, ms: i });
    }
    await logger.flush();
  }

  assert.equal(fs.appendCalls, 3, '三个 tick 三次 append（同 tick 合并写不能被轮转逻辑破坏）');
  assert.equal(fs.statCalls, 1, `阈内不该反复 stat，实际 stat ${fs.statCalls} 次`);
  // 第一次写当天：找已有段一次 + 按份数清一次；之后不再扫目录
  assert.equal(fs.readdirCalls, 2, `只有当天第一次写扫目录，实际 ${fs.readdirCalls} 次`);
});

t('日志目录不可写：只喊一行 stderr，不抛也不拒', async () => {
  const fs = makeMemoryFs();
  fs.failMkdir = true;
  const logger = createLogger({ dir: DIR, now: FIXED_NOW, fs });

  const originalError = console.error;
  const stderrLines = [];
  console.error = (...args) => {
    stderrLines.push(args.join(' '));
  };
  try {
    assert.doesNotThrow(() => logger.log({ level: 'info', kind: 'lifecycle', event: 'start' }));
    await logger.flush();
    const removed = await logger.prune();
    assert.equal(removed, 0);
  } finally {
    console.error = originalError;
  }

  assert.equal(stderrLines.length, 1, `stderr 应只有一行，实际：${stderrLines.join(' | ')}`);
  assert.match(stderrLines[0], /\[gateway-log\] write failed/);
  assert.match(stderrLines[0], /fake mkdir blocked/);
});

/* ---- 真磁盘：临时目录里跑一次完整轮转（不污染仓库，不用 sleep） ---- */

t('真磁盘：超过阈值滚动、超过份数删最旧、当前文件仍可读', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-gw-log-rotate-'));
  const MAX_BYTES = 1024;
  const KEEP = 3;
  try {
    const logger = createLogger({ dir: tmpDir, now: FIXED_NOW, maxBytes: MAX_BYTES, keepFiles: KEEP });
    for (let i = 0; i < 60; i += 1) {
      logger.log({ level: 'info', kind: 'http', method: 'GET', path: `/api/real/${i}`, status: 200, ms: i });
      if (i % 10 === 9) await logger.flush();
    }
    await logger.flush();

    const parse = (name) => {
      const match = /^gateway-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/.exec(name);
      assert.ok(match, `不认识的日志文件：${name}`);
      return { dateKey: match[1], index: match[2] === undefined ? 0 : Number(match[2]) };
    };
    const names = (await fsp.readdir(tmpDir)).sort();
    const files = names.map((name) => ({ name, ...parse(name) })).sort((a, b) => a.index - b.index);

    assert.equal(files.length, KEEP, `只该留 ${KEEP} 份，实际 ${files.map((f) => f.name).join(',')}`);
    assert.ok(files.every((f) => f.dateKey === DAY), '所有段都按本地日期命名');
    assert.ok(files[0].index > 0, `最旧的 base 应已删掉，实际留下：${files.map((f) => f.name).join(',')}`);
    // 序号必须是连续且递增的，不能出现重号（重号就说明「谁更旧」有歧义）
    const indexes = files.map((f) => f.index);
    assert.deepEqual(indexes, [indexes[0], indexes[0] + 1, indexes[0] + 2], `序号不连续：${indexes.join(',')}`);

    const newest = files[files.length - 1];
    const content = await fsp.readFile(path.join(tmpDir, newest.name), 'utf8');
    assert.ok(content.trim().length > 0, '当前文件不能是空的');
    const lastRecord = JSON.parse(content.trim().split('\n').pop());
    assert.equal(lastRecord.path, '/api/real/59', '最新一条必须落在当前文件里');

    let total = 0;
    for (const file of files) {
      total += (await fsp.stat(path.join(tmpDir, file.name))).size;
    }
    assert.ok(
      total <= KEEP * MAX_BYTES + 200,
      `总占用 ${total} 应被「单文件上限 × 份数」卡住（${KEEP * MAX_BYTES} + 一行余量）`,
    );
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

t('fs 写盘失败时 log 不抛异常，只往 stderr 打一行', async () => {
  const fs = makeMemoryFs();
  fs.failWrites = true;
  const logger = createLogger({ dir: DIR, now: FIXED_NOW, fs });

  const originalError = console.error;
  const stderrLines = [];
  console.error = (...args) => {
    stderrLines.push(args.join(' '));
  };
  try {
    assert.doesNotThrow(() =>
      logger.log({ level: 'info', kind: 'lifecycle', event: 'start', detail: 'boom' }),
    );
    await logger.flush();
  } finally {
    console.error = originalError;
  }

  assert.equal(stderrLines.length, 1, `stderr 应只有一行，实际：${stderrLines.join(' | ')}`);
  assert.match(stderrLines[0], /\[gateway-log\]/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

if (failed) {
  console.log(`\n${failed} 个用例失败`);
  process.exitCode = 1;
}
