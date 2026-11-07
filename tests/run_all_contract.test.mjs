import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'hana-runner-contract-'));
const testsDir = path.join(tempRoot, 'tests');
const scriptsDir = path.join(tempRoot, 'scripts');
const runnerPath = path.join(scriptsDir, 'run-all-tests.mjs');
const envRecordPath = path.join(tempRoot, 'env.json');
const markerPath = path.join(tempRoot, 'invalid-ran.marker');
const environmentTest = path.join(testsDir, '10_env-fixture.test.mjs');
const invalidGuardTest = path.join(testsDir, '00_invalid_guard.test.mjs');
const wholeSkipTest = path.join(testsDir, '20_skip-fixture_whole.test.mjs');
const partialSkipTest = path.join(testsDir, '21_skip-fixture_partial.test.mjs');
const secretSentinels = {
  HANA_HOME: 'FAKE_HANA_HOME_DO_NOT_PRINT',
  HANA_TOKEN: 'FAKE_HANA_TOKEN_DO_NOT_PRINT',
  HANA_OWNER_TOKEN: 'FAKE_HANA_OWNER_TOKEN_DO_NOT_PRINT',
  AWS_SECRET_ACCESS_KEY: 'FAKE_CLOUD_SECRET_DO_NOT_PRINT',
  NODE_OPTIONS: '--trace-warnings',
};
const fixtureEnv = Object.fromEntries(
  Object.entries({
    PATH: process.env.PATH,
    JAVA_HOME: 'FAKE_JAVA_HOME_PATH',
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    ANDROID_HOME: 'FAKE_ANDROID_HOME_PATH',
    CHROME_PATH: 'FAKE_CHROME_PATH_WITH_SPACES/chrome.exe',
    HANA_SKIP_BROWSER_TESTS: '1',
    HANA_GATEWAY_LOG: 'must-not-be-inherited-from-parent',
    ...secretSentinels,
  }).filter(([, value]) => typeof value === 'string'),
);

function runRunner(args) {
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: tempRoot,
    env: fixtureEnv,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function outputOf(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function removeKnownFiles() {
  for (const file of [runnerPath, environmentTest, invalidGuardTest, wholeSkipTest, partialSkipTest, envRecordPath, markerPath]) {
    try {
      unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const directory of [testsDir, scriptsDir, tempRoot]) {
    try {
      rmdirSync(directory);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

try {
  mkdirSync(testsDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    runnerPath,
    readFileSync(path.join(repoRoot, 'scripts', 'run-all-tests.mjs'), 'utf8'),
  );
  writeFileSync(
    environmentTest,
    [
      "import { writeFileSync } from 'node:fs';",
      `const names = ${JSON.stringify([
        'PATH', 'JAVA_HOME', 'ANDROID_HOME', 'CHROME_PATH', 'HANA_SKIP_BROWSER_TESTS',
        'HANA_GATEWAY_LOG', 'HANA_HOME', 'HANA_TOKEN', 'HANA_OWNER_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS',
      ])};`,
      'const observed = Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]));',
      `writeFileSync(${JSON.stringify(envRecordPath)}, JSON.stringify(observed));`,
      '',
    ].join('\n'),
  );
  writeFileSync(
    invalidGuardTest,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerPath)}, 'ran');\n`,
  );
  writeFileSync(wholeSkipTest, "console.log('SKIP  fixture: entire file not run');\n");
  writeFileSync(
    partialSkipTest,
    "console.log('PASS  fixture: non-browser assertion ran');\nconsole.log('SKIP  fixture 浏览器场景：未运行');\n",
  );

  const environmentRun = runRunner(['--max-rss', '0', '--filter', 'env-fixture']);
  assert.equal(environmentRun.error, undefined, outputOf(environmentRun));
  assert.equal(environmentRun.status, 0, outputOf(environmentRun));
  const observed = JSON.parse(readFileSync(envRecordPath, 'utf8'));
  assert.ok(observed.PATH === fixtureEnv.PATH, 'runner must preserve PATH');
  assert.ok(observed.JAVA_HOME === fixtureEnv.JAVA_HOME, 'runner must preserve JAVA_HOME');
  assert.ok(observed.ANDROID_HOME === fixtureEnv.ANDROID_HOME, 'runner must preserve ANDROID_HOME');
  assert.ok(observed.CHROME_PATH === fixtureEnv.CHROME_PATH, 'runner must preserve CHROME_PATH');
  assert.ok(observed.HANA_SKIP_BROWSER_TESTS === '1', 'runner must preserve the explicit browser-skip switch');
  assert.ok(observed.HANA_GATEWAY_LOG === 'off', 'runner must set its own gateway-log control');
  for (const name of ['HANA_HOME', 'HANA_TOKEN', 'HANA_OWNER_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS']) {
    assert.ok(observed[name] === null, `child must not inherit ${name}`);
  }
  for (const value of Object.values(secretSentinels)) {
    assert.ok(!outputOf(environmentRun).includes(value), 'runner output must not print environment values');
  }

  const invalidArgs = [
    ['--timeout', 'NaN'],
    ['--timeout', 'Infinity'],
    ['--timeout', '0'],
    ['--timeout', '-1'],
    ['--timeout'],
    ['--mem', 'NaN'],
    ['--mem', '0'],
    ['--mem', '-1'],
    ['--mem', '1.5'],
    ['--mem'],
    ['--max-rss', 'NaN'],
    ['--max-rss', 'Infinity'],
    ['--max-rss', ''],
    ['--max-rss', '-1'],
    ['--max-rss'],
    ['--shard', '0/1'],
    ['--shard', '1/0'],
    ['--shard', '2/1'],
    ['--shard', '9007199254740992/9007199254740992'],
    ['--shard', ''],
    ['--shard'],
  ];
  for (const args of invalidArgs) {
    try {
      unlinkSync(markerPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const result = runRunner([...args, '--filter', 'invalid_guard']);
    assert.equal(result.error, undefined, `invalid args must fail promptly: ${args.join(' ')}`);
    assert.equal(result.status, 2, `invalid args must exit 2: ${args.join(' ')}`);
    assert.ok(!existsSync(markerPath), `invalid args must not start tests: ${args.join(' ')}`);
    for (const value of Object.values(secretSentinels)) {
      assert.ok(!outputOf(result).includes(value), 'runner output must not print environment values');
    }
  }

  const zeroRssRun = runRunner(['--max-rss', '0', '--filter', 'invalid_guard']);
  assert.equal(zeroRssRun.error, undefined, outputOf(zeroRssRun));
  assert.equal(zeroRssRun.status, 0, outputOf(zeroRssRun));
  assert.equal(readFileSync(markerPath, 'utf8'), 'ran', '--max-rss=0 must explicitly disable the RSS limit, not the test');

  const skipRun = runRunner(['--max-rss', '0', '--filter', 'skip-fixture']);
  assert.equal(skipRun.error, undefined, outputOf(skipRun));
  assert.equal(skipRun.status, 0, outputOf(skipRun));
  assert.match(skipRun.stdout, /SKIP\s+20_skip-fixture_whole\.test\.mjs.*整文件/, outputOf(skipRun));
  assert.match(skipRun.stdout, /PARTIAL\s+21_skip-fixture_partial\.test\.mjs.*部分跳过/, outputOf(skipRun));
  assert.match(skipRun.stdout, /浏览器场景：未运行/, outputOf(skipRun));
  assert.match(skipRun.stdout, /部分跳过.*未执行|相关覆盖未验证/, outputOf(skipRun));
  assert.doesNotMatch(skipRun.stdout, /全覆盖|全部覆盖/, '跳过浏览器场景不能显示成全覆盖');

  console.log('PASS  环境白名单、数值参数拒绝、max-rss=0 和整文件/部分 SKIP 契约');
} finally {
  removeKnownFiles();
}
