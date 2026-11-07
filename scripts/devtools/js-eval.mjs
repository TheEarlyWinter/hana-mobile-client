#!/usr/bin/env node
// js-eval —— 在真机 WebView 的页面上下文里执行一段 JS，把结果打出来。
//
// 用处：读 DOM 状态、断言某个面板开没开、确认登录态。以前这些只能在 console 里看，
// 而壳没开调试时连 console 都看不到。
//
// 例：
//   node scripts/devtools/js-eval.mjs "document.querySelector('#settingsPanel').hidden"
//   node scripts/devtools/js-eval.mjs "document.querySelectorAll('.session-item').length" --expect 3
//   node scripts/devtools/js-eval.mjs --file scripts/devtools/tmp/check.js
//
// 零第三方依赖（Node 22+ 自带 fetch / WebSocket）+ child_process 调 adb。

import { readFile } from 'node:fs/promises';
import { DevtoolsError, renderError } from './lib/errors.mjs';
import { removeForward } from './lib/adb.mjs';
import { CdpSession } from './lib/cdp.mjs';
import { assertWebView, openEndpoint } from './lib/attach.mjs';

function parseArgs(argv) {
  const opts = {
    device: '',
    expression: '',
    file: '',
    cdpUrl: '',
    match: '',
    port: 9222,
    timeout: 10000,
    json: false,
    expect: null,
    keepForward: false,
    noWebviewCheck: false,
    verbose: false,
    help: false,
  };
  const readValue = (name, i) => {
    if (i + 1 >= argv.length) throw new DevtoolsError(`参数 ${name} 后面缺一个值`, '--help 看用法');
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--device':
      case '-s':
        opts.device = readValue(arg, i); i += 1; break;
      case '--file':
        opts.file = readValue(arg, i); i += 1; break;
      case '--cdp-url':
        opts.cdpUrl = readValue(arg, i); i += 1; break;
      case '--match':
        opts.match = readValue(arg, i); i += 1; break;
      case '--port':
        opts.port = Number(readValue(arg, i)); i += 1; break;
      case '--timeout':
        opts.timeout = Number(readValue(arg, i)); i += 1; break;
      case '--expect':
        opts.expect = readValue(arg, i); i += 1; break;
      case '--json':
        opts.json = true; break;
      case '--keep-forward':
        opts.keepForward = true; break;
      case '--no-webview-check':
        opts.noWebviewCheck = true; break;
      case '--verbose':
        opts.verbose = true; break;
      case '-h':
      case '--help':
        opts.help = true; break;
      default:
        if (arg.startsWith('-') && arg !== '-') {
          throw new DevtoolsError(`不认识的参数：${arg}`, '--help 看完整用法');
        }
        if (opts.expression) {
          throw new DevtoolsError('只接受一段表达式；含空格的请加引号', `已经拿到「${opts.expression}」，又多出「${arg}」`);
        }
        opts.expression = arg;
    }
  }
  if (Number.isNaN(opts.port) || opts.port <= 0) throw new DevtoolsError('--port 需要正整数', '--help 看用法');
  if (Number.isNaN(opts.timeout) || opts.timeout < 1000) throw new DevtoolsError('--timeout 至少 1000（毫秒）', '--help 看用法');
  return opts;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function stringifyValue(value, type) {
  if (type === 'undefined' || value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function printHelp() {
  const lines = [
    'js-eval —— 在真机 WebView 的页面里执行一段 JS',
    '',
    '用法：',
    '  node scripts/devtools/js-eval.mjs "<表达式>" [选项]',
    '  node scripts/devtools/js-eval.mjs --file <文件> [选项]',
    '  echo "<表达式>" | node scripts/devtools/js-eval.mjs - [选项]',
    '',
    '选项：',
    '  -s, --device <序列号>   目标设备（也可用 HANA_ANDROID_SERIAL / ANDROID_SERIAL）',
    '      --file <路径>       从文件读表达式（省掉命令行引号地狱）',
    '      --expect <值>       断言：输出必须等于这个值，否则退出码 1',
    '      --json              按 JSON 输出 {ok,type,value}',
    '      --cdp-url <url>     直连一个 CDP 端点（ws:// 或 http://），跳过设备发现',
    '      --match <子串>      有多个可调试页面时按 url/title 选一个',
    '      --port <n>          adb forward 的本地端口，默认 9222',
    '      --timeout <ms>      超时，默认 10000',
    '      --keep-forward      跑完不删 adb forward',
    '      --no-webview-check  跳过「这是不是 WebView」的 UA 检查',
    '      --verbose           出错时多打一层原始细节',
    '  -h, --help              这张说明',
    '',
    '退出码：0 成功 / 断言通过；1 页面里抛错 / 断言不符；2 参数或设备问题。',
    '',
    '例子：',
    '  node scripts/devtools/js-eval.mjs "document.title"',
    '  node scripts/devtools/js-eval.mjs "document.querySelector(\\"#drawerPanel\\").className"',
    '  node scripts/devtools/js-eval.mjs "document.querySelectorAll(\\".session-item\\").length" --expect 3',
    '  node scripts/devtools/js-eval.mjs "window.HanaMobile ? typeof window.HanaMobile.back : \\"none\\""',
    '',
    '前提：App 必须是 debuggable 构建（pwsh android/build.ps1 -Debuggable），否则壳里',
    '不会开 WebView 调试端口，本工具会直接说「WebView 调试没开」。',
    '',
    '离线自检（不需要真机）：node scripts/devtools/selftest.mjs',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${renderError(err, { verbose: true })}\n`);
    return 2;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }

  let expression = opts.expression;
  if (opts.file) {
    try {
      expression = await readFile(opts.file, 'utf8');
    } catch (err) {
      process.stderr.write(`${renderError(new DevtoolsError(`读不了 --file 指定的文件：${opts.file}`, '检查路径', err.message))}\n`);
      return 2;
    }
  } else if (!expression || expression === '-') {
    const piped = await readStdin();
    if (!piped.trim()) {
      process.stderr.write(`${renderError(new DevtoolsError('没有给表达式', '例：node scripts/devtools/js-eval.mjs "document.title"'), { verbose: true })}\n`);
      return 2;
    }
    expression = piped;
  }

  const log = (message) => process.stderr.write(`${message}\n`);
  let ep = null;
  let session = null;
  let forwardRemoved = false;
  const cleanup = async () => {
    if (session) session.close();
    if (ep && ep.forward && ep.forward.owned && !opts.keepForward && !forwardRemoved) {
      forwardRemoved = true;
      await removeForward(ep.serial, ep.forward.port);
    }
  };
  process.on('SIGINT', () => {
    cleanup().finally(() => process.exit(130));
  });

  try {
    ep = await openEndpoint(opts, log);
    session = await CdpSession.connect(ep.wsUrl, { timeout: opts.timeout });

    // 先认一下这是不是 WebView：读 UA 失败不当成致命（页面可能正忙），只是跳过检查
    const ua = await session.evaluate('navigator.userAgent', { timeout: opts.timeout, awaitPromise: false });
    if (ua.ok && ua.value) assertWebView({ ua: ua.value }, opts);

    const res = await session.evaluate(expression, { timeout: opts.timeout });
    if (!res.ok) {
      process.stderr.write(`${renderError(new DevtoolsError('页面内执行抛错', '表达式本身的问题；也可以加 --json 看原始返回', res.error), { verbose: false })}\n`);
      return 1;
    }

    const shown = stringifyValue(res.value, res.type);

    if (opts.expect !== null) {
      const actual = typeof res.value === 'string' ? res.value : stringifyValue(res.value, res.type);
      const matched = String(actual).trim() === String(opts.expect).trim();
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ ok: matched, type: res.type, value: res.value, expect: opts.expect }, null, 2)}\n`);
      } else {
        process.stdout.write(`${shown}\n`);
      }
      if (!matched) {
        process.stderr.write(`断言失败：期望「${opts.expect}」，实际「${String(actual).trim()}」\n`);
        return 1;
      }
      return 0;
    }

    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, type: res.type, value: res.value === undefined ? null : res.value }, null, 2)}\n`);
    } else {
      process.stdout.write(`${shown}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`${renderError(err, { verbose: opts.verbose })}\n`);
    return 1;
  } finally {
    await cleanup();
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  process.stderr.write(`${renderError(err, { verbose: true })}\n`);
  process.exitCode = 1;
});
