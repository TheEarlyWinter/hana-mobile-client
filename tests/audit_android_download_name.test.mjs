/* A1 回归：下载文件名清洗必须允许合法文件名包含连续点。
 *
 * 直接抽取 MainActivity.java 的 sanitizeDownloadFileName，用 javac/java 执行真实方法。
 * 覆盖：a..b、中文、独立 ..、目录结尾、混合分隔符、长度限制、路径 basename 保护。
 * 临时源码与 class 保留在 tests/artifacts/audit-android-a1-*。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const JAVA_SRC = fileURLToPath(new URL('../android/src/com/hanamobile/app/MainActivity.java', import.meta.url));
const ARTIFACTS = fileURLToPath(new URL('./artifacts/', import.meta.url));

/** 去掉注释，避免注释里的括号干扰方法边界。 */
function stripComments(code) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < code.length && code[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function extractMethod(java, signature) {
  const at = java.indexOf(signature);
  if (at < 0) return null;
  const braceAt = java.indexOf('{', at);
  if (braceAt < 0) return null;
  let depth = 0;
  for (let i = braceAt; i < java.length; i += 1) {
    if (java[i] === '{') depth += 1;
    else if (java[i] === '}') {
      depth -= 1;
      if (depth === 0) return java.slice(at, i + 1);
    }
  }
  return null;
}

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures += 1;
    const detail = String(err.message || err).split('\n').slice(0, 3).join(' ').slice(0, 500);
    console.log(`FAIL  ${name}\n      ${detail}`);
  }
}

const java = stripComments(fs.readFileSync(JAVA_SRC, 'utf8'));
const method = extractMethod(java, 'static String sanitizeDownloadFileName(String raw)');
if (!method) {
  console.log('FAIL  找不到 sanitizeDownloadFileName(String)');
  process.exit(1);
}

const outDir = path.join(ARTIFACTS, `audit-android-a1-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
fs.mkdirSync(outDir, { recursive: true });

const probe = [
  'import java.nio.charset.StandardCharsets;',
  'import java.util.Base64;',
  '',
  'public final class AndroidDownloadNameProbe {',
  method,
  '    private static String decode(String value) {',
  '        return "~".equals(value) ? null : new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);',
  '    }',
  '    public static void main(String[] args) {',
  '        for (int i = 0; i < args.length; i += 1) {',
  '            String out = sanitizeDownloadFileName(decode(args[i]));',
  '            System.out.println(i + "\\t" + (out == null ? "N"',
  '                    : "V" + Base64.getEncoder().encodeToString(out.getBytes(StandardCharsets.UTF_8))));',
  '        }',
  '    }',
  '}',
  '',
].join('\n');
const srcFile = path.join(outDir, 'AndroidDownloadNameProbe.java');
fs.writeFileSync(srcFile, probe, 'utf8');

const cases = [
  // 合法名字里可以有两个连续点：旧实现被 name.contains("..") 误杀
  ['a..b.docx', 'a..b.docx'],
  ['报告..v2.docx', '报告..v2.docx'],
  // 独立 . / .. 仍然拒绝
  ['..', null],
  ['.', null],
  // 目录结尾：basename 为空，仍然拒绝
  ['dir/', null],
  ['C:\\Users\\alice\\', null],
  ['folder/sub\\', null],
  // 混合分隔符：两种分隔符都按路径处理，只留 basename
  ['C:\\Users/alice\\report..final.docx', 'report..final.docx'],
  // 原有路径 basename 保护：先截 basename 再清洗，不能用 null 误伤
  ['../../etc/passwd', 'passwd'],
  ['../x', 'x'],
  ['/../../secret.txt', 'secret.txt'],
  ['C:\\Users\\alice\\photo.jpg', 'photo.jpg'],
  // 控制字符仍被剔除；空名仍拒绝
  ['bad\r\nname.txt', 'badname.txt'],
  ['', null],
  ['\u0001', null],
  // 长度限制：原始输入超过 4096 直接拒绝
  ['a'.repeat(4097), null],
  // 字节超限时截断，但保留扩展名（200 个 a + .docx → 175 个 a + .docx = 180 字节）
  ['a'.repeat(200) + '.docx', 'a'.repeat(175) + '.docx'],
  // UTF-8 多字节截断不能切半个字符：预算 180 - 5 = 175，58 个中文 = 174 字节
  ['中'.repeat(100) + '.docx', '中'.repeat(58) + '.docx'],
];

try {
  execFileSync('javac', ['--release', '17', '-encoding', 'UTF-8', '-d', outDir, srcFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
  const enc = (value) => value === null ? '~' : Buffer.from(value, 'utf8').toString('base64');
  const stdout = execFileSync('java', ['-cp', outDir, 'AndroidDownloadNameProbe', ...cases.map(([raw]) => enc(raw))], {
    encoding: 'utf8',
    timeout: 120000,
  });
  const got = new Map(stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [index, payload] = line.split('\t');
    return [Number(index), payload === 'N' ? null : Buffer.from(payload.slice(1), 'base64').toString('utf8')];
  }));
  for (let i = 0; i < cases.length; i += 1) {
    const [raw, expected] = cases[i];
    test(`sanitize(${JSON.stringify(raw)})`, () => {
      assert.equal(got.get(i), expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(got.get(i))}`);
    });
  }
  console.log(`JVM 探针产物保留在：${outDir}`);
} catch (err) {
  failures += 1;
  const detail = String(err.stderr || err.stdout || err.message || err);
  console.log(`FAIL  javac/java 文件名探针\n      ${detail.split('\n').slice(0, 16).join('\n      ')}`);
}

if (failures > 0) {
  console.log(`\n${failures} TESTS FAILED`);
  process.exit(1);
}
console.log('\nALL PASS');
