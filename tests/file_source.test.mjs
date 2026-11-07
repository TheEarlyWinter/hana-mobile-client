/* tests/file_source.test.mjs — 路径 → 工作区地址的纯函数测试
 *
 * 这段逻辑决定「手机能不能真的下载/预览一个文件」：
 * 映射错了，卡片就是死的。所以按纯函数单测，不拉 DOM、不发请求。
 */

import assert from 'node:assert/strict';
import {
  normalizePath,
  matchWorkspaceRoot,
  buildWorkspaceContentUrl,
  workspaceUrlForFile,
  matchWorkspaceByLabel,
} from '../web/file-source.js';

let bad = 0;
function ok(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

const ROOTS = [
  { mountId: 'mount_work', path: 'C:\\Users\\Me\\Desktop\\OH-WorkSpace' },
  { mountId: 'mount_nested', path: 'C:\\Users\\Me\\Desktop\\OH-WorkSpace\\hana-mobile' },
  { mountId: 'mount_d', path: 'D:\\111\\工作总结' },
];

ok('normalizePath：反斜杠转正斜杠并去掉尾部斜杠', () => {
  assert.equal(normalizePath('C:\\a\\b\\'), 'C:/a/b');
  assert.equal(normalizePath('  /a/b//  '), '/a/b');
  assert.equal(normalizePath(null), '');
  assert.equal(normalizePath(42), '');
});

ok('matchWorkspaceRoot：根目录下的文件', () => {
  const hit = matchWorkspaceRoot('C:\\Users\\Me\\Desktop\\OH-WorkSpace\\mobile_preview_test.docx', ROOTS);
  assert.deepEqual(hit, { mountId: 'mount_work', subdir: '', name: 'mobile_preview_test.docx' });
});

ok('matchWorkspaceRoot：子目录里的文件保留 subdir', () => {
  const hit = matchWorkspaceRoot('C:\\Users\\Me\\Desktop\\OH-WorkSpace\\docs\\a\\报告.docx', ROOTS);
  assert.deepEqual(hit, { mountId: 'mount_work', subdir: 'docs/a', name: '报告.docx' });
});

ok('matchWorkspaceRoot：嵌套工作区取最长前缀，不被外层吞掉', () => {
  const hit = matchWorkspaceRoot('C:\\Users\\Me\\Desktop\\OH-WorkSpace\\hana-mobile\\web\\app.js', ROOTS);
  assert.deepEqual(hit, { mountId: 'mount_nested', subdir: 'web', name: 'app.js' });
});

ok('matchWorkspaceRoot：Windows 路径大小写不敏感', () => {
  const hit = matchWorkspaceRoot('c:\\users\\me\\desktop\\oh-workspace\\x.md', ROOTS);
  assert.equal(hit?.mountId, 'mount_work');
  assert.equal(hit?.name, 'x.md');
});

ok('matchWorkspaceRoot：不同盘符不误判', () => {
  assert.equal(matchWorkspaceRoot('E:\\111\\工作总结\\a.docx', ROOTS), null);
  assert.equal(matchWorkspaceRoot('D:\\111\\工作总结\\年报.docx', ROOTS)?.mountId, 'mount_d');
});

ok('matchWorkspaceRoot：只是前缀相同、不构成目录关系的不算', () => {
  // ...OH-WorkSpace-other 不能命中 ...OH-WorkSpace
  assert.equal(matchWorkspaceRoot('C:\\Users\\Me\\Desktop\\OH-WorkSpace-other\\a.txt', ROOTS), null);
});

ok('matchWorkspaceRoot：根目录本身、空路径、坏输入都返回 null', () => {
  assert.equal(matchWorkspaceRoot('C:\\Users\\Me\\Desktop\\OH-WorkSpace', ROOTS), null);
  assert.equal(matchWorkspaceRoot('', ROOTS), null);
  assert.equal(matchWorkspaceRoot('C:\\a\\b', null), null);
  assert.equal(matchWorkspaceRoot('C:\\a\\b', [{ path: 'C:\\a' }]), null); // 没有 mountId
});

ok('buildWorkspaceContentUrl：参数顺序与编码稳定', () => {
  const url = buildWorkspaceContentUrl({ mountId: 'm1', agentId: 'hakimi', subdir: 'docs/a b', name: '报告 v2.docx' });
  assert.equal(
    url,
    '/api/mobile/workspace/content?mountId=m1&agentId=hakimi&subdir=docs%2Fa%20b&name=%E6%8A%A5%E5%91%8A%20v2.docx',
  );
  assert.ok(!url.includes('+'), '空格必须是 %20，不能是表单编码的 +');
});

ok('buildWorkspaceContentUrl：缺 mountId 或 name 返回 null', () => {
  assert.equal(buildWorkspaceContentUrl({ name: 'a.docx' }), null);
  assert.equal(buildWorkspaceContentUrl({ mountId: 'm1' }), null);
  assert.equal(buildWorkspaceContentUrl(), null);
});

ok('workspaceUrlForFile：工作区命中就给出 content 地址', () => {
  const url = workspaceUrlForFile(
    { filePath: 'C:\\Users\\Me\\Desktop\\OH-WorkSpace\\mobile_preview_test.docx', fileId: 'sf_1' },
    ROOTS,
    'hakimi',
  );
  assert.equal(
    url,
    '/api/mobile/workspace/content?mountId=mount_work&agentId=hakimi&name=mobile_preview_test.docx',
  );
});

ok('workspaceUrlForFile：工作区外的文件返回 null（调用方退回资源地址）', () => {
  assert.equal(workspaceUrlForFile({ filePath: 'C:\\Windows\\win.ini' }, ROOTS, 'hakimi'), null);
  assert.equal(workspaceUrlForFile({ fileId: 'sf_only' }, ROOTS, 'hakimi'), null);
});

ok('matchWorkspaceByLabel：按工作区目录名反推相对路径', () => {
  const rel = matchWorkspaceByLabel('C:\\Users\\Me\\Desktop\\OH-WorkSpace\\mobile_preview_test.docx', 'OH-WorkSpace');
  assert.deepEqual(rel, { subdir: '', name: 'mobile_preview_test.docx' });
});

ok('matchWorkspaceByLabel：子目录与大小写', () => {
  const rel = matchWorkspaceByLabel('c:\\users\\me\\desktop\\oh-workspace\\docs\\a\\b.docx', 'OH-WorkSpace');
  assert.deepEqual(rel, { subdir: 'docs/a', name: 'b.docx' });
});

ok('matchWorkspaceByLabel：路径里没这个目录就返回 null，不瞎猜', () => {
  assert.equal(matchWorkspaceByLabel('C:\\Temp\\x.docx', 'OH-WorkSpace'), null);
  assert.equal(matchWorkspaceByLabel('', 'OH-WorkSpace'), null);
  assert.equal(matchWorkspaceByLabel('C:\\a\\b.docx', 'a/b'), null);
});

if (bad) {
  console.log(`\n${bad} 项失败`);
  process.exit(1);
}
console.log('\nALL PASS');
