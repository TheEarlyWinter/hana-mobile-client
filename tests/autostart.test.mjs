/* 开机自启脚本的契约：-Plan 不落盘、-Install 能真的建出快捷方式、-Uninstall 能删干净。
 *
 * 为什么不真往系统启动文件夹写：那是用户机器上的持久副作用。测试统一用
 * -StartupDir 指到临时目录，验完即删。脚本本身也支持 HANA_AUTOSTART_DIR 覆盖。
 *
 * 断言只认脚本输出的 key=value（ASCII），不匹配中文说明：
 * CI 的 Windows runner 控制台代码页与本地不同，中文可能变成问号，按中文断言会假红。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.resolve('scripts/autostart.ps1');

let bad = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err && err.message ? err.message : err}`);
  }
}

function run(args, extraEnv = {}) {
  const result = spawnSync('pwsh', ['-NoProfile', '-File', script, ...args], {
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, ...extraEnv },
  });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  return { code: result.status, out, fields: parseFields(out) };
}

/** 把 key=value 行解析成对象；`#` 开头的说明行忽略。 */
function parseFields(out) {
  const fields = {};
  for (const line of String(out).split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

const tmpDirs = [];
function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-autostart-'));
  tmpDirs.push(dir);
  return dir;
}

t('脚本存在且参数表可读', () => {
  assert.ok(fs.existsSync(script), `找不到 ${script}`);
  const text = fs.readFileSync(script, 'utf8');
  for (const flag of ['-Install', '-Uninstall', '-Status', '-Plan', '-StartupDir']) {
    assert.ok(text.includes(flag), `脚本里应出现 ${flag}`);
  }
});

t('-Plan 只打印计划，不创建任何文件', () => {
  const dir = makeTmp();
  const { code, fields } = run(['-Plan', '-StartupDir', dir, '-Mode', 'lan', '-Port', '24000']);
  assert.equal(code, 0, `退出码应为 0，实际 ${code}`);
  assert.equal(fields.action, 'plan');
  assert.equal(fields.startupDir, dir, '应回显启动文件夹');
  assert.ok(fields.shortcut && fields.shortcut.endsWith('.lnk'), '应给出 .lnk 路径');
  assert.match(fields.arguments || '', /gateway\\start\.ps1/i, '参数里应指向 gateway\\start.ps1');
  assert.match(fields.arguments || '', /-Mode lan/, '应带上模式');
  assert.match(fields.arguments || '', /-Port 24000/, '应带上端口');
  assert.equal(fields.workdir, path.resolve('.'), '工作目录应是仓库根');
  assert.deepEqual(fs.readdirSync(dir), [], 'Plan 不应落盘');
});

t('-Install 在指定目录建出快捷方式，-Uninstall 能删掉', () => {
  const dir = makeTmp();
  const install = run(['-Install', '-StartupDir', dir]);
  assert.equal(install.code, 0, `安装应成功：${install.out}`);
  assert.equal(install.fields.action, 'install');
  assert.equal(install.fields.result, 'created');

  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, `应只产生一个文件，实际 ${JSON.stringify(files)}`);
  assert.match(files[0], /\.lnk$/i, `应产生 .lnk，实际 ${files[0]}`);
  assert.ok(fs.statSync(path.join(dir, files[0])).size > 0, '快捷方式不应是空文件');

  const status = run(['-Status', '-StartupDir', dir]);
  assert.equal(status.code, 0);
  assert.equal(status.fields.installed, 'yes', '应报告已登记');

  const uninstall = run(['-Uninstall', '-StartupDir', dir]);
  assert.equal(uninstall.code, 0, `卸载应成功：${uninstall.out}`);
  assert.equal(uninstall.fields.result, 'removed');
  assert.deepEqual(fs.readdirSync(dir), [], '卸载后目录应为空');
});

t('重复安装幂等，不会产生两个文件', () => {
  const dir = makeTmp();
  assert.equal(run(['-Install', '-StartupDir', dir]).code, 0);
  assert.equal(run(['-Install', '-StartupDir', dir]).code, 0);
  assert.equal(fs.readdirSync(dir).length, 1, '仍应只有一个快捷方式');
});

t('未登记时 -Uninstall 不报错，并说明原因', () => {
  const dir = makeTmp();
  const { code, fields } = run(['-Uninstall', '-StartupDir', dir]);
  assert.equal(code, 0);
  assert.equal(fields.result, 'absent');
});

t('非法模式被拒绝', () => {
  const dir = makeTmp();
  const { code, fields } = run(['-Plan', '-StartupDir', dir, '-Mode', 'nope']);
  assert.equal(code, 1, '应失败退出');
  assert.equal(fields.error, 'invalid_mode');
  assert.deepEqual(fs.readdirSync(dir), []);
});

t('非法端口被拒绝', () => {
  const dir = makeTmp();
  const { code, fields } = run(['-Plan', '-StartupDir', dir, '-Port', '70000']);
  assert.equal(code, 1);
  assert.equal(fields.error, 'invalid_port');
});

t('同时给多个动作被拒绝', () => {
  const dir = makeTmp();
  const { code, fields } = run(['-Install', '-Uninstall', '-StartupDir', dir]);
  assert.equal(code, 1);
  assert.equal(fields.error, 'multiple_actions');
  assert.deepEqual(fs.readdirSync(dir), [], '冲突时不应落盘');
});

t('默认动作为 -Status（不传参数不会误装）', () => {
  const dir = makeTmp();
  const { code, fields } = run(['-StartupDir', dir]);
  assert.equal(code, 0);
  assert.equal(fields.action, 'status');
  assert.equal(fields.installed, 'no');
  assert.deepEqual(fs.readdirSync(dir), [], '默认动作不应落盘');
});

for (const dir of tmpDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
}

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
} else {
  console.log('\nALL PASS');
}
