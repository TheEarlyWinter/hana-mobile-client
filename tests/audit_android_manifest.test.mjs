/* A3 回归：AndroidManifest 的 application 必须显式关闭 allowBackup。
 *
 * 用 JDK DOM 解析实际 AndroidManifest.xml（不是 grep 文本），读取
 * application@android:allowBackup；同时确认没有引入 dataExtractionRules /
 * fullBackupContent 之类的额外备份配置。
 * 临时源码与 class 保留在 tests/artifacts/audit-android-a3-*。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MANIFEST = fileURLToPath(new URL('../android/AndroidManifest.xml', import.meta.url));
const ARTIFACTS = fileURLToPath(new URL('./artifacts/', import.meta.url));

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

const outDir = path.join(ARTIFACTS, `audit-android-a3-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
fs.mkdirSync(outDir, { recursive: true });

const probe = [
  'import java.io.File;',
  'import javax.xml.parsers.DocumentBuilderFactory;',
  'import org.w3c.dom.Document;',
  'import org.w3c.dom.Element;',
  'import org.w3c.dom.NodeList;',
  '',
  'public final class AndroidManifestProbe {',
  '    private static final String ANDROID = "http://schemas.android.com/apk/res/android";',
  '    private static String attr(Element element, String name) {',
  '        String value = element.getAttributeNS(ANDROID, name);',
  '        return value == null || value.isEmpty() ? "<absent>" : value;',
  '    }',
  '    public static void main(String[] args) throws Exception {',
  '        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();',
  '        factory.setNamespaceAware(true);',
  '        Document document = factory.newDocumentBuilder().parse(new File(args[0]));',
  '        NodeList applications = document.getElementsByTagName("application");',
  '        System.out.println("applicationCount=" + applications.getLength());',
  '        Element application = (Element) applications.item(0);',
  '        System.out.println("allowBackup=" + attr(application, "allowBackup"));',
  '        System.out.println("dataExtractionRules=" + attr(application, "dataExtractionRules"));',
  '        System.out.println("fullBackupContent=" + attr(application, "fullBackupContent"));',
  '    }',
  '}',
  '',
].join('\n');
const srcFile = path.join(outDir, 'AndroidManifestProbe.java');
fs.writeFileSync(srcFile, probe, 'utf8');

let values = new Map();
try {
  execFileSync('javac', ['--release', '17', '-encoding', 'UTF-8', '-d', outDir, srcFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
  const stdout = execFileSync('java', ['-cp', outDir, 'AndroidManifestProbe', MANIFEST], {
    encoding: 'utf8',
    timeout: 120000,
  });
  values = new Map(stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  console.log(`JVM 探针产物保留在：${outDir}`);
} catch (err) {
  failures += 1;
  const detail = String(err.stderr || err.stdout || err.message || err);
  console.log(`FAIL  javac/java Manifest 探针\n      ${detail.split('\n').slice(0, 16).join('\n      ')}`);
}

test('A3 application 只有一个且能被 XML 解析', () => {
  assert.equal(values.get('applicationCount'), '1');
});

test('A3 application 显式声明 android:allowBackup=false', () => {
  assert.equal(values.get('allowBackup'), 'false');
});

test('A3 未引入额外的备份规则配置', () => {
  assert.equal(values.get('dataExtractionRules'), '<absent>');
  assert.equal(values.get('fullBackupContent'), '<absent>');
});

if (failures > 0) {
  console.log(`\n${failures} TESTS FAILED`);
  process.exit(1);
}
console.log('\nALL PASS');
