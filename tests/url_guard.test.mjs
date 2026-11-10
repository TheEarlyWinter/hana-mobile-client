/* 服务器地址校验：真 JVM 单测
 *
 * 为什么要这么绕：地址校验逻辑在 MainActivity.java 里（不能在别处另建一份实现，
 * 否则测的和跑的不是同一段代码）。这里把 MainActivity 里那段**纯 Java**的
 * `normalizeStartUrl` 原文抽出来，拼成一个独立类，用 javac 编译、`java` 跑，
 * 因此断言的是真正会进 APK 的那几行代码，而不是测试里重写的一版。
 *
 * 这也是为什么 MainActivity 里的校验方法不许用 android.* 类型：它得能在裸 JVM 上跑。
 *
 * 用例覆盖：裸 IP:端口、缺斜杠、协议大小写、host:port 与 scheme 的歧义、
 * javascript:/file:/intent: 之类危险协议、空白与控制字符、userinfo 钓鱼写法、超长串、
 * 端口 0（归一化就得拒，否则存进配置后 isSafeHttpUrl 又拒它，两边不一致）。
 *
 * 另抽几条同一份源码里的纯 Java 小方法做真 JVM 测试：
 * - redactUrlForLog：日志里只允许出现 origin + 路径标志，token 不进 logcat；
 * - normalizeMode：无效 / 缺失的模式必须落到 MODE_LOCAL（本机 / USB）；
 * - backAction：返回键的三态决策表，null（还没查出页面标记）必须落到「问用户」。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const JAVA_SRC = fileURLToPath(new URL('../android/src/com/hanamobile/app/MainActivity.java', import.meta.url));

/* ------------------------------------------------------------------ */
/* 从真源码里抽方法                                                     */
/* ------------------------------------------------------------------ */

/** 从 `签名` 起按大括号配对切出整个方法体（方法里的字符串字面量不含大括号，够用）。 */
function extractMethod(java, signature) {
  const at = java.indexOf(signature);
  if (at < 0) return null;
  const braceAt = java.indexOf('{', at);
  if (braceAt < 0) return null;
  let depth = 0;
  for (let i = braceAt; i < java.length; i += 1) {
    const c = java[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return java.slice(at, i + 1);
    }
  }
  return null;
}

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

const java = fs.readFileSync(JAVA_SRC, 'utf8');
const method = extractMethod(java, 'static String normalizeStartUrl(String raw)');

if (!method) {
  console.log('FAIL  没在 MainActivity.java 里找到 static String normalizeStartUrl(String raw)');
  console.log('      地址校验必须是一个纯 Java（不碰 android.*）的静态方法，才能被这条测试编译执行');
  process.exit(1);
}

const maxLenMatch = java.match(/MAX_URL_LENGTH\s*=\s*(\d+)\s*;/);
const maxLen = maxLenMatch ? Number(maxLenMatch[1]) : 2048;

/* ------------------------------------------------------------------ */
/* 生成探针类并编译                                                     */
/* ------------------------------------------------------------------ */

const probe = [
  'import java.net.URI;',
  'import java.util.Locale;',
  '',
  'public class UrlProbe {',
  `    static final int MAX_URL_LENGTH = ${maxLen};`,
  '',
  method,
  '',
  '    // 输入输出都走 base64：Windows 控制台编码不可靠，避免中文/控制字符被改掉',
  '    public static void main(String[] args) {',
  '        java.util.Base64.Decoder dec = java.util.Base64.getDecoder();',
  '        for (int i = 0; i < args.length; i += 1) {',
  '            String raw;',
  '            if ("!null".equals(args[i])) {',
  '                raw = null;',
  '            } else {',
  '                raw = new String(dec.decode(args[i]), java.nio.charset.StandardCharsets.UTF_8);',
  '            }',
  '            String out = normalizeStartUrl(raw);',
  '            String payload = out == null',
  '                    ? "N"',
  '                    : "R" + java.util.Base64.getEncoder().encodeToString(',
  '                            out.getBytes(java.nio.charset.StandardCharsets.UTF_8));',
  '            System.out.println(i + "\\t" + payload);',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-url-guard-'));
const srcFile = path.join(tmp, 'UrlProbe.java');
fs.writeFileSync(srcFile, probe, 'utf8');

/* ------------------------------------------------------------------ */
/* 用例表                                                              */
/* ------------------------------------------------------------------ */

const cases = [
  ['空串', '', null],
  ['纯空白', '   ', null],
  ['null', null, null],
  ['裸 IP:端口', '192.168.31.89:24000', 'http://192.168.31.89:24000/'],
  ['IP:端口 + 斜杠', '192.168.31.89:24000/', 'http://192.168.31.89:24000/'],
  ['http 补斜杠', 'http://192.168.31.89:24000', 'http://192.168.31.89:24000/'],
  ['https 保留路径', 'https://example.com/app/', 'https://example.com/app/'],
  ['协议名大小写归一', 'HTTPS://Example.COM', 'https://Example.COM/'],
  ['localhost:端口 别误判成协议', 'localhost:24000', 'http://localhost:24000/'],
  ['纯域名', 'example.com', 'http://example.com/'],
  ['首尾空白 trim', '  http://192.168.31.89:24000  ', 'http://192.168.31.89:24000/'],
  ['IPv6 字面量', 'http://[::1]:24000/', 'http://[::1]:24000/'],
  ['查询串保留', 'http://host:1/?a=1', 'http://host:1/?a=1'],
  ['javascript: 拒绝', 'javascript:alert(1)', null],
  ['file: 拒绝', 'file:///etc/passwd', null],
  ['intent: 拒绝', 'intent://scan/#Intent;end', null],
  ['data: 拒绝', 'data:text/html,<script>1</script>', null],
  ['userinfo 钓鱼写法拒绝', 'http://user:pw@evil.com:1/', null],
  ['内嵌空格拒绝', 'http://192.168.31.89 :24000/', null],
  ['内嵌换行拒绝', 'http://a.com\n/evil', null],
  ['端口越界拒绝', 'http://host:99999/', null],
  ['端口 0 拒绝（带 scheme）', 'http://host:0/', null],
  ['端口 0 拒绝（裸写法）', 'host:0', null],
  ['端口 0 拒绝（带路径）', 'http://host:0/chat', null],
  ['默认端口照样接受（http 不写端口）', 'http://example.com/', 'http://example.com/'],
  ['默认端口照样接受（https 写 443）', 'https://example.com:443/', 'https://example.com:443/'],
  ['超长拒绝', `http://${'a'.repeat(3000)}/`, null],
];

let javacOk = true;
try {
  execFileSync('javac', ['--release', '17', '-encoding', 'UTF-8', '-d', tmp, srcFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
} catch (err) {
  javacOk = false;
  const detail = String(err.stderr || err.stdout || err.message || err);
  console.log('FAIL  地址校验代码编译不过（javac）');
  console.log(detail.split('\n').slice(0, 12).map((l) => '      ' + l).join('\n'));
}

if (javacOk) {
  const arg = (v) => (v === null ? '!null' : Buffer.from(v, 'utf8').toString('base64'));
  let stdout = '';
  let javaOk = true;
  try {
    stdout = execFileSync('java', ['-cp', tmp, 'UrlProbe', ...cases.map(([, input]) => arg(input))], {
      encoding: 'utf8',
      timeout: 120000,
    });
  } catch (err) {
    javaOk = false;
    console.log('FAIL  探针执行失败（java）');
    console.log(String(err.stderr || err.message || err).split('\n').slice(0, 12).map((l) => '      ' + l).join('\n'));
  }

  if (javaOk) {
    const out = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [i, payload] = line.split('\t');
        const value = payload === 'N' || !payload
          ? null
          : Buffer.from(payload.slice(1), 'base64').toString('utf8');
        return { i: Number(i), value };
      });
    const got = new Map(out.map(({ i, value }) => [i, value]));

    for (let i = 0; i < cases.length; i += 1) {
      const [name, input, expect] = cases[i];
      t(`地址校验：${name}`, () => {
        assert.ok(got.has(i), `探针没有返回第 ${i} 个用例`);
        assert.equal(got.get(i), expect, `输入 ${JSON.stringify(input)} 期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(got.get(i))}`);
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 日志脱敏 + 默认接入方式：同一份源码里的另两个纯 Java 方法            */
/* ------------------------------------------------------------------ */

const redactMethod = extractMethod(java, 'static String redactUrlForLog(String raw)');
const modeMethod = extractMethod(java, 'private static String normalizeMode(String raw)');

if (!redactMethod) {
  t('日志脱敏：找到 redactUrlForLog()', () => {
    throw new Error('MainActivity.java 里没有 static String redactUrlForLog(String raw)；日志脱敏必须是纯 Java 静态方法，才能被这条测试编译执行');
  });
} else {
  const redactProbe = [
    'import java.net.URI;',
    'import java.util.Locale;',
    '',
    'public class RedactProbe {',
    redactMethod,
    '',
    '    public static void main(String[] args) {',
    '        java.util.Base64.Decoder dec = java.util.Base64.getDecoder();',
    '        for (int i = 0; i < args.length; i += 1) {',
    '            String raw;',
    '            if ("!null".equals(args[i])) {',
    '                raw = null;',
    '            } else {',
    '                raw = new String(dec.decode(args[i]), java.nio.charset.StandardCharsets.UTF_8);',
    '            }',
    '            String out = redactUrlForLog(raw);',
    '            System.out.println(i + "\\t" + java.util.Base64.getEncoder().encodeToString(',
    '                    out.getBytes(java.nio.charset.StandardCharsets.UTF_8)));',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');

  const redactFile = path.join(tmp, 'RedactProbe.java');
  fs.writeFileSync(redactFile, redactProbe, 'utf8');

  const redactCases = [
    ['null 当未配置', null, '(unset)'],
    ['空串当未配置', '', '(unset)'],
    ['全空白当未配置', '   ', '(unset)'],
    ['根路径 + 查询串：只留 origin 与 path=/', 'http://host:24000/?token=SECRET', 'http://host:24000 path=/'],
    ['非根路径 + 查询串 + fragment：路径内容不出现', 'http://host:24000/chat?token=SECRET#frag', 'http://host:24000 path=set'],
    ['userinfo 不出现', 'https://user:pw@host:443/app', 'https://host:443 path=set'],
    ['IPv6 字面量加回方括号', 'http://[::1]:24000/', 'http://[::1]:24000 path=/'],
    ['无 scheme 的串', '192.168.31.89:24000/', '(unparsable)'],
    ['协议名统一小写', 'HTTPS://Example.COM/', 'https://Example.COM path=/'],
  ];

  let redactOk = true;
  try {
    execFileSync('javac', ['--release', '17', '-encoding', 'UTF-8', '-d', tmp, redactFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
  } catch (err) {
    redactOk = false;
    const detail = String(err.stderr || err.stdout || err.message || err);
    console.log('FAIL  日志脱敏探针编译不过（javac）');
    console.log(detail.split('\n').slice(0, 12).map((l) => '      ' + l).join('\n'));
    bad += 1;
  }

  if (redactOk) {
    try {
      const arg = (v) => (v === null ? '!null' : Buffer.from(v, 'utf8').toString('base64'));
      const stdout = execFileSync('java', ['-cp', tmp, 'RedactProbe', ...redactCases.map(([, input]) => arg(input))], {
        encoding: 'utf8',
        timeout: 120000,
      });
      const got = new Map(stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [index, payload] = line.split('\t');
          return [Number(index), Buffer.from(payload, 'base64').toString('utf8')];
        }));
      redactCases.forEach(([name, input, expect], i) => {
        t(`日志脱敏：${name}`, () => {
          assert.equal(got.get(i), expect, `输入 ${JSON.stringify(input)} 期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(got.get(i))}`);
        });
      });
      t('日志脱敏：token 不出现在任何一条脱敏结果里', () => {
        for (const value of got.values()) {
          assert.ok(!String(value).includes('SECRET'), `脱敏结果里出现了 token：${value}`);
          assert.ok(!String(value).includes('user:pw'), `脱敏结果里出现了 userinfo：${value}`);
        }
      });
    } catch (err) {
      bad += 1;
      console.log('FAIL  日志脱敏探针执行失败（java）');
      console.log(String(err.stderr || err.message || err).split('\n').slice(0, 12).map((l) => '      ' + l).join('\n'));
    }
  }
}

if (!modeMethod) {
  t('默认接入方式：找到 normalizeMode()', () => {
    throw new Error('MainActivity.java 里没有 private static String normalizeMode(String raw)');
  });
} else {
  // 常量值从源码里读，不在测试里另写一份，否则常量改了测试还绿。
  const modeConsts = Object.fromEntries(
    [...java.matchAll(/static final String (MODE_[A-Z]+)\s*=\s*"([^"]*)";/g)].map((m) => [m[1], m[2]]),
  );
  const modesDecl = java.match(/String\[\]\s*MODES\s*=\s*\{([^}]*)\}/);
  const modeValues = (modesDecl ? modesDecl[1].split(',').map((s) => s.trim()).filter(Boolean) : [])
    .map((name) => modeConsts[name]);

  t('默认接入方式：常量表可解析，第一个就是本机 / USB', () => {
    assert.ok(modesDecl, '找不到 MODES 声明');
    assert.deepEqual(modeValues, ['local_usb', 'tailscale', 'tunnel', 'custom'], 'MODES 顺序与常量值应为四种接入方式');
  });

  const modeProbe = [
    'public class ModeProbe {',
    ...Object.entries(modeConsts).map(([name, value]) => `    static final String ${name} = "${value}";`),
    `    static final String[] MODES = {${modeValues.map((v) => `"${v}"`).join(', ')}};`,
    '',
    modeMethod,
    '',
    '    public static void main(String[] args) {',
    '        java.util.Base64.Decoder dec = java.util.Base64.getDecoder();',
    '        for (int i = 0; i < args.length; i += 1) {',
    '            String raw;',
    '            if ("!null".equals(args[i])) {',
    '                raw = null;',
    '            } else {',
    '                raw = new String(dec.decode(args[i]), java.nio.charset.StandardCharsets.UTF_8);',
    '            }',
    '            String out = normalizeMode(raw);',
    '            System.out.println(i + "\\t" + java.util.Base64.getEncoder().encodeToString(',
    '                    out.getBytes(java.nio.charset.StandardCharsets.UTF_8)));',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');

  const modeFile = path.join(tmp, 'ModeProbe.java');
  fs.writeFileSync(modeFile, modeProbe, 'utf8');

  const modeCases = [
    ['没存过（null）→ 本机 / USB', null, 'local_usb'],
    ['空串 → 本机 / USB', '', 'local_usb'],
    ['旧版本存的外观不明值 → 本机 / USB', 'wifi', 'local_usb'],
    ['大小写不对 → 本机 / USB', 'LOCAL_USB', 'local_usb'],
    ['已知的 tailscale 原样返回', 'tailscale', 'tailscale'],
    ['已知的 custom 原样返回', 'custom', 'custom'],
  ];

  let modeOk = true;
  try {
    execFileSync('javac', ['--release', '17', '-encoding', 'UTF-8', '-d', tmp, modeFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
  } catch (err) {
    modeOk = false;
    const detail = String(err.stderr || err.stdout || err.message || err);
    console.log('FAIL  默认接入方式探针编译不过（javac）');
    console.log(detail.split('\n').slice(0, 12).map((l) => '      ' + l).join('\n'));
    bad += 1;
  }

  if (modeOk) {
    try {
      const arg = (v) => (v === null ? '!null' : Buffer.from(v, 'utf8').toString('base64'));
      const stdout = execFileSync('java', ['-cp', tmp, 'ModeProbe', ...modeCases.map(([, input]) => arg(input))], {
        encoding: 'utf8',
        timeout: 120000,
      });
      const got = new Map(stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [index, payload] = line.split('\t');
          return [Number(index), Buffer.from(payload, 'base64').toString('utf8')];
        }));
      modeCases.forEach(([name, input, expect], i) => {
        t(`默认接入方式：${name}`, () => {
          assert.equal(got.get(i), expect, `输入 ${JSON.stringify(input)} 期望 ${expect}，实际 ${got.get(i)}`);
        });
      });
    } catch (err) {
      bad += 1;
      console.log('FAIL  默认接入方式探针执行失败（java）');
      console.log(String(err.stderr || err.message || err).split('\n').slice(0, 12).map((l) => '      ' + l).join('\n'));
    }
  }
}

/* ------------------------------------------------------------------ */
/* 返回键决策表：三态的每一种组合都钉住                                */
/* ------------------------------------------------------------------ */

const backTable = extractMethod(java, 'static String backAction(');

if (!backTable) {
  t('返回键决策：找到 backAction()', () => {
    throw new Error('MainActivity.java 里没有 static String backAction(...)；三态决策必须是纯 Java 静态方法，才能被这条测试编译执行');
  });
} else {
  const backConsts = Object.fromEntries(
    [...java.matchAll(/static final String (BACK_[A-Z_]+)\s*=\s*"([^"]*)";/g)].map((m) => [m[1], m[2]]),
  );

  const backProbe = [
    'public class BackProbe {',
    ...Object.entries(backConsts).map(([name, value]) => `    static final String ${name} = "${value}";`),
    '',
    backTable,
    '',
    '    public static void main(String[] args) {',
    '        for (int i = 0; i < args.length; i += 1) {',
    '            String[] parts = args[i].split(",", -1);',
    '            Boolean marker = "T".equals(parts[3]) ? Boolean.TRUE',
    '                    : ("F".equals(parts[3]) ? Boolean.FALSE : null);',
    '            String out = backAction("1".equals(parts[0]), "1".equals(parts[1]), "1".equals(parts[2]), marker);',
    '            System.out.println(i + "\\t" + out);',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');

  const backFile = path.join(tmp, 'BackProbe.java');
  fs.writeFileSync(backFile, backProbe, 'utf8');

  // [名字, 网页解了, 错误页, 可退历史, 页面标记(T/F/N), 期望常量名]
  const backCases = [
    ['网页自己退了 → 原生不动', 1, 0, 1, 'T', 'BACK_NONE'],
    ['网页自己退了（错误页上也一样）', 1, 1, 0, 'F', 'BACK_NONE'],
    ['错误页 → 直接退出', 0, 1, 1, 'N', 'BACK_FINISH'],
    ['有历史 → 先退历史', 0, 0, 1, 'T', 'BACK_GO_BACK'],
    ['有历史时页面标记不影响（先退历史）', 0, 0, 1, 'F', 'BACK_GO_BACK'],
    ['有历史、标记未知 → 仍先退历史', 0, 0, 1, 'N', 'BACK_GO_BACK'],
    ['自己的页面、无历史 → 退出', 0, 0, 0, 'T', 'BACK_FINISH'],
    ['别人的页面 → 问用户', 0, 0, 0, 'F', 'BACK_ASK'],
    ['还没查出页面标记（null）→ 问用户，不直接退出', 0, 0, 0, 'N', 'BACK_ASK'],
  ];

  t('返回键决策：常量表可解析', () => {
    assert.deepEqual(
      Object.keys(backConsts).sort(),
      ['BACK_ASK', 'BACK_FINISH', 'BACK_GO_BACK', 'BACK_NONE'],
      'backAction 的四个结果常量应当都在',
    );
  });

  let backOk = true;
  try {
    execFileSync('javac', ['--release', '17', '-encoding', 'UTF-8', '-d', tmp, backFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
  } catch (err) {
    backOk = false;
    const detail = String(err.stderr || err.stdout || err.message || err);
    console.log('FAIL  返回键决策探针编译不过（javac）');
    console.log(detail.split('\n').slice(0, 12).map((l) => '      ' + l).join('\n'));
    bad += 1;
  }

  if (backOk) {
    try {
      const args = backCases.map(([, webHandled, errorPage, canGoBack, marker]) =>
        [webHandled, errorPage, canGoBack, marker].join(','));
      const stdout = execFileSync('java', ['-cp', tmp, 'BackProbe', ...args], {
        encoding: 'utf8',
        timeout: 120000,
      });
      const got = new Map(stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [index, value] = line.split('\t');
          return [Number(index), value];
        }));
      backCases.forEach(([name, , , , , expectKey], i) => {
        t(`返回键决策：${name}`, () => {
          assert.ok(got.has(i), `探针没有返回第 ${i} 个用例`);
          assert.equal(got.get(i), backConsts[expectKey], `期望 ${expectKey}（${backConsts[expectKey]}），实际 ${got.get(i)}`);
        });
      });
    } catch (err) {
      bad += 1;
      console.log('FAIL  返回键决策探针执行失败（java）');
      console.log(String(err.stderr || err.message || err).split('\n').slice(0, 12).map((l) => '      ' + l).join('\n'));
    }
  }
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉不影响结论 */
}

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
