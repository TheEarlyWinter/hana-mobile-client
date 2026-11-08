/* 目录选择器测试（新建 Code 会话要 cwd）
 *
 * 跑法：node tests/code_folder_picker.test.mjs
 *
 * 假 DOM 复用 tests/support/app_harness.mjs。listRoots 是注入的依赖，所以整条
 * 「读取 → 渲染 → 选择 → resolve → 拆 DOM」都能在 Node 里跑，不用真实网络。
 *
 * 覆盖：列表与选中、过滤（rootAvailable / nativeRootPath）、取消 / 点背景 / Esc、
 * 空态与手动输入、trim 与空输入、重复 open 不叠 DOM、listRoots 抛错的可读提示与
 * 无未处理拒绝、错误态重试、无障碍属性、纯函数判定表。
 */

import { createHarness } from './support/app_harness.mjs';
import {
  createCodeFolderPicker,
  pickUsableRoots,
  shortenMiddle,
  MAX_PATH_CHARS,
} from '../web/code-folder-picker.js';

const h = createHarness();
const { doc } = h;

const rejections = [];
process.on('unhandledRejection', (err) => rejections.push(err));

let bad = 0;
const openPickers = [];

// 假 DOM 的 document.dispatchEvent 只传 type/target，不转发 key 字段；
// 所以 Esc 的监听挂点单独给一个节点（真装配时缺省就是 document）。
const keyHost = doc.createElement('div');

function makeMount() {
  const mount = doc.createElement('div');
  mount.className = 'cf-test-mount';
  doc.body.appendChild(mount);
  return mount;
}

function makePicker(mount, listRoots) {
  const picker = createCodeFolderPicker({ doc, mount, listRoots, keyTarget: keyHost });
  openPickers.push(picker);
  return picker;
}

/** 每个用例开跑前 / 结束后清场：别让上一例的遮罩和 keydown 监听影响下一例。 */
function cleanupDom() {
  for (const picker of openPickers.splice(0)) {
    try {
      picker.close();
    } catch {
      // 清理失败不掩盖真正的断言失败
    }
  }
  for (const node of doc.body.querySelectorAll('.code-folder-root')) node.remove();
  for (const node of doc.body.querySelectorAll('.cf-test-mount')) node.remove();
}

async function runCheck(name, fn) {
  cleanupDom();
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err && err.message ? err.message : err}`);
  }
  cleanupDom();
}

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || '值'}不相等\n      期望 ${e}\n      实际 ${a}`);
}

function assertIncludes(text, part, label) {
  const haystack = String(text == null ? '' : text);
  if (!haystack.includes(part)) {
    throw new Error(`${label || '文本'}里没有「${part}」\n      实际 ${JSON.stringify(haystack)}`);
  }
}

const hasChinese = (value) => /[\u4e00-\u9fa5]/.test(String(value || ''));

/* ---------------------------- 夹具 ---------------------------- */

const ROOTS = [
  {
    mountId: 'mount_work',
    label: 'hanako-mobile',
    nativeRootPath: 'C:\\work\\hana-mobile',
    rootAvailable: true,
    access: 'read-write',
  },
  {
    mountId: 'mount_papers',
    label: '论文库',
    nativeRootPath: '/Users/wit/Documents/papers',
    rootAvailable: true,
    access: 'read',
  },
];

const rootsPayload = (list = ROOTS) => ({ ok: true, studioId: 's1', workspaces: list });

const itemOf = (mount, index = 0) => mount.querySelectorAll('.code-folder-item')[index];

/* ---------------------------- 用例 ---------------------------- */

await runCheck('有可用根时列出可选项，点击某项 resolve 该根的绝对路径', async () => {
  const mount = makeMount();
  const picker = makePicker(mount, async () => rootsPayload());
  const promise = picker.open({ title: '选择代码目录' });

  // 请求还没回来时先是加载态，不是空白框
  assertEqual(
    mount.querySelector('.code-folder-status').textContent,
    '正在读取工作区目录…',
    '加载态文案'
  );

  await h.settle();

  const items = mount.querySelectorAll('.code-folder-item');
  assertEqual(items.length, 2, '可选项数量');
  assertEqual(mount.querySelectorAll('.code-folder-name')[0].textContent, 'hanako-mobile', '第一项名称');
  assertEqual(mount.querySelectorAll('.code-folder-name')[1].textContent, '论文库', '第二项名称');
  assertEqual(
    mount.querySelectorAll('.code-folder-path')[0].textContent,
    'C:\\work\\hana-mobile',
    '短路径原样显示'
  );
  assertEqual(itemOf(mount, 0).getAttribute('title'), 'C:\\work\\hana-mobile', 'title 给全路径');
  assertEqual(itemOf(mount, 1).getAttribute('title'), '/Users/wit/Documents/papers', 'title 给全路径');
  assertEqual(mount.querySelector('.code-folder-list').hidden, false, '有根时列表可见');

  itemOf(mount, 1).click();
  assertEqual(await promise, '/Users/wit/Documents/papers', '返回选中根的 nativeRootPath');
  assertEqual(picker.isOpen(), false, '选完应关闭');
  assertEqual(mount.querySelectorAll('.code-folder-root').length, 0, '选完 DOM 应清理');
});

await runCheck('rootAvailable 不为 true 或没有 nativeRootPath 的根不出现', async () => {
  const mount = makeMount();
  const picker = makePicker(mount, async () => rootsPayload([
    { mountId: 'a', label: '可用', nativeRootPath: 'C:\\ok', rootAvailable: true },
    { mountId: 'b', label: '目录丢了', nativeRootPath: 'C:\\gone', rootAvailable: false },
    { mountId: 'c', label: '远端根', nativeRootPath: '', rootAvailable: true },
    { mountId: 'd', label: '缺字段', rootAvailable: true },
    { mountId: 'e', label: '只有空格', nativeRootPath: '   ', rootAvailable: true },
    { mountId: 'f', label: '不是字符串', nativeRootPath: 42, rootAvailable: true },
  ]));
  const promise = picker.open();
  await h.settle();

  const names = mount.querySelectorAll('.code-folder-name').map((n) => n.textContent);
  assertEqual(names, ['可用'], '只列能用的根');

  itemOf(mount, 0).click();
  assertEqual(await promise, 'C:\\ok');
});

await runCheck('只有会话历史目录时：列表带「最近」标签、提示说明原因、点击可用', async () => {
  const mount = makeMount();
  // 手机经网关时宿主的真实回应：工作区在，但没有 nativeRootPath
  const picker = makePicker(mount, async () => ({
    workspaces: [{ mountId: 'm1', label: 'hana-mobile', rootAvailable: true }],
    recent: [{ path: 'C:\\Users\\\\example\\Desktop\\workspace\\hana-mobile' }],
  }));
  const promise = picker.open();
  await h.settle();

  const names = mount.querySelectorAll('.code-folder-name').map((n) => n.textContent);
  assertEqual(names.length, 1, '应列出 1 个候选');
  assertIncludes(names[0], '最近', '名字后面带「最近」标签');

  const hint = mount.querySelector('.code-folder-hint');
  assert(hint && hint.hidden === false, '提示应可见');
  assertIncludes(hint.textContent, '最近 Code 会话', '提示要说清楚这些目录的来源');

  itemOf(mount, 0).click();
  assertEqual(await promise, 'C:\\Users\\\\example\\Desktop\\workspace\\hana-mobile', '点一下就能选');
});

await runCheck('工作区列表读失败但有历史目录：仍可选用，并说明降级', async () => {
  const mount = makeMount();
  const picker = makePicker(mount, async () => ({
    workspaces: [],
    recent: [{ path: 'C:\\work\\demo' }],
    degraded: true,
  }));
  const promise = picker.open();
  await h.settle();

  assertEqual(mount.querySelectorAll('.code-folder-item').length, 1, '历史目录仍列出');
  assertIncludes(mount.querySelector('.code-folder-hint').textContent, '读取失败', '要告诉用户工作区没读到');

  itemOf(mount, 0).click();
  assertEqual(await promise, 'C:\\work\\demo');
});

await runCheck('取消按钮 resolve null 并清掉 DOM', async () => {
  const mount = makeMount();
  const picker = makePicker(mount, async () => rootsPayload());
  const promise = picker.open();
  await h.settle();

  mount.querySelector('.code-folder-cancel').click();
  assertEqual(await promise, null, '取消应返回 null');
  assertEqual(picker.isOpen(), false, '取消后不再处于打开态');
  assertEqual(mount.querySelectorAll('.code-folder-root').length, 0, '取消后 DOM 应清理');
  assertEqual(mount.children.length, 0, '挂载容器不应留下残骸');
});

await runCheck('点背景关闭，点面板内部不关闭', async () => {
  const mount = makeMount();
  const picker = makePicker(mount, async () => rootsPayload());
  const promise = picker.open();
  await h.settle();

  mount.querySelector('.code-folder-sheet').click();
  await h.settle();
  assertEqual(picker.isOpen(), true, '点面板内部不应关闭');
  assert(mount.querySelector('.code-folder-root') != null, '面板还在');

  mount.querySelector('.code-folder-root').click();
  assertEqual(await promise, null, '点背景应返回 null');
  assertEqual(mount.querySelectorAll('.code-folder-root').length, 0, '点背景后 DOM 应清理');
});

await runCheck('Esc 关闭并返回 null', async () => {
  const mount = makeMount();
  const picker = makePicker(mount, async () => rootsPayload());
  const promise = picker.open();
  await h.settle();

  keyHost.dispatchEvent('keydown', { key: 'Escape' });
  assertEqual(await promise, null, 'Esc 应返回 null');
  assertEqual(mount.querySelectorAll('.code-folder-root').length, 0, 'Esc 后 DOM 应清理');

  // 关掉之后 Esc 不应再动任何东西（监听已解绑，且不抛错）
  keyHost.dispatchEvent('keydown', { key: 'Escape' });
  assertEqual(picker.isOpen(), false);
});

await runCheck('没有任何可用根时显示空态文案，手动输入仍可用', async () => {
  const mount = makeMount();
  const picker = makePicker(mount, async () => rootsPayload([]));
  const promise = picker.open();
  await h.settle();

  assertEqual(
    mount.querySelector('.code-folder-status').textContent,
    '没有可用的工作区目录',
    '空态文案'
  );
  assertIncludes(mount.querySelector('.code-folder-hint').textContent, '手动输入', '空态提示');
  assertEqual(mount.querySelector('.code-folder-hint').hidden, false, '空态提示应可见');
  assertEqual(mount.querySelectorAll('.code-folder-item').length, 0, '不应有道选项');
  assertEqual(mount.querySelector('.code-folder-list').hidden, true, '空态列表隐藏');
  assertEqual(mount.querySelector('.code-folder-input').hidden, false, '手动输入入口仍在');

  const input = mount.querySelector('.code-folder-input');
  input.value = 'C:\\novel\\project';
  mount.querySelector('.code-folder-submit').click();
  assertEqual(await promise, 'C:\\novel\\project', '空态下手动输入可用');
});

await runCheck('手动输入首尾空格被 trim；空输入不能提交', async () => {
  const mount = makeMount();
  const picker = makePicker(mount, async () => rootsPayload());

  const first = picker.open();
  await h.settle();
  let input = mount.querySelector('.code-folder-input');
  input.value = '  D:\\work\\proj  ';
  mount.querySelector('.code-folder-submit').click();
  assertEqual(await first, 'D:\\work\\proj', '手动输入应 trim');

  // 只输空格：不 resolve、给出可读错误
  const second = picker.open();
  await h.settle();
  input = mount.querySelector('.code-folder-input');
  let settledValue = '还没结束';
  void second.then((value) => { settledValue = value; });
  input.value = '   ';
  mount.querySelector('.code-folder-submit').click();
  await h.settle();

  assertEqual(settledValue, '还没结束', '空输入不应提交');
  const manualError = mount.querySelector('.code-folder-manual-error');
  assertEqual(manualError.hidden, false, '空输入应显示错误');
  assertEqual(manualError.textContent, '请输入目录路径', '错误文案');

  // 重新输入时错误提示自动收起
  input.value = 'C:\\a';
  input.dispatchEvent('input');
  assertEqual(manualError.hidden, true, '重新输入后错误提示收起');

  picker.close();
  assertEqual(await second, null, '关闭返回 null');
});

await runCheck('回车提交手动输入', async () => {
  const mount = makeMount();
  const picker = makePicker(mount, async () => rootsPayload());
  const promise = picker.open();
  await h.settle();

  const input = mount.querySelector('.code-folder-input');
  input.value = ' /srv/repo ';
  input.dispatchEvent('keydown', { key: 'Enter' });
  assertEqual(await promise, '/srv/repo', '回车应提交');
});

await runCheck('重复 open 只有一层 DOM，上一次以 null 收尾', async () => {
  const mount = makeMount();
  const picker = makePicker(mount, async () => rootsPayload());

  const first = picker.open({ title: '第一次' });
  await h.settle();
  assertEqual(mount.querySelectorAll('.code-folder-root').length, 1, '第一次只有一层');

  const second = picker.open({ title: '第二次' });
  await h.settle();

  assertEqual(mount.querySelectorAll('.code-folder-root').length, 1, '重复 open 不应叠加 DOM');
  assertEqual(await first, null, '上一次 open 应以 null 收尾');
  assertEqual(mount.querySelectorAll('.code-folder-title').length, 1, '只有一个标题');
  assertEqual(mount.querySelector('.code-folder-title').textContent, '第二次', '标题跟着最新的 open');
  assertEqual(picker.isOpen(), true, '新的一层仍然打开');

  picker.close();
  assertEqual(await second, null);
});

await runCheck('listRoots 抛错时给出可读提示，不产生未处理拒绝', async () => {
  const mount = makeMount();
  const picker = makePicker(mount, async () => {
    throw new Error('网络不可用');
  });
  const promise = picker.open();
  await h.settle();

  const status = mount.querySelector('.code-folder-status');
  assertIncludes(status.textContent, '无法读取工作区目录', '错误提示');
  assertIncludes(status.textContent, '网络不可用', '错误详情');
  assertEqual(status.classList.contains('is-error'), true, '错误态样式');
  assertEqual(mount.querySelector('.code-folder-list').hidden, true, '错误态没有列表');
  assertEqual(mount.querySelector('.code-folder-retry').hidden, false, '错误态给出重试');
  assertEqual(mount.querySelector('.code-folder-input').hidden, false, '错误态仍可手动输入');
  assertEqual(picker.getState().error, '网络不可用', '错误可被装配层观察');

  // 兜底路径：用户直接取消 → null；此时请求的失败已经被吃掉，不再是未处理拒绝
  picker.close();
  assertEqual(await promise, null, '错误态取消返回 null');
  await h.settle();
  assertEqual(rejections.length, 0, `不应出现未处理的 Promise 拒绝：${rejections.map(String).join('; ')}`);
});

await runCheck('错误态可以重试，重试成功后能正常选择', async () => {
  const mount = makeMount();
  let attempt = 0;
  const picker = makePicker(mount, async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('第一次失败');
    return rootsPayload();
  });
  const promise = picker.open();
  await h.settle();

  assertIncludes(mount.querySelector('.code-folder-status').textContent, '第一次失败', '先看到失败');

  mount.querySelector('.code-folder-retry').click();
  await h.settle();

  assertEqual(mount.querySelectorAll('.code-folder-item').length, 2, '重试后列出根');
  assertEqual(mount.querySelector('.code-folder-retry').hidden, true, '成功后重试按钮收起');
  itemOf(mount, 0).click();
  assertEqual(await promise, 'C:\\work\\hana-mobile', '重试后仍能选择');
});

await runCheck('关闭时还在路上的请求不会把结果画回已关闭的面板', async () => {
  const mount = makeMount();
  let release = null;
  const picker = makePicker(mount, () => new Promise((resolve) => { release = resolve; }));
  const promise = picker.open();
  await h.settle();

  picker.close();
  assertEqual(await promise, null, '关闭返回 null');
  release(rootsPayload());
  await h.settle();

  assertEqual(mount.querySelectorAll('.code-folder-root').length, 0, '迟到的结果不应重建 DOM');
  assertEqual(mount.children.length, 0, '挂载容器保持干净');
});

await runCheck('对话框无障碍属性与中文 aria-label', async () => {
  const mount = makeMount();
  const picker = makePicker(mount, async () => rootsPayload());
  const promise = picker.open({ title: '选择代码目录' });
  await h.settle();

  const root = mount.querySelector('.code-folder-root');
  assertEqual(root.getAttribute('role'), 'dialog', 'role');
  assertEqual(root.getAttribute('aria-modal'), 'true', 'aria-modal');

  const title = mount.querySelector('.code-folder-title');
  assertEqual(title.textContent, '选择代码目录', '标题文案');
  assert(title.id && title.id.length > 0, '标题需要 id 才能被 aria-labelledby 指到');
  assertEqual(root.getAttribute('aria-labelledby'), title.id, 'aria-labelledby 指向标题');

  for (const selector of ['.code-folder-close', '.code-folder-cancel', '.code-folder-submit', '.code-folder-retry']) {
    const label = mount.querySelector(selector).getAttribute('aria-label');
    assert(hasChinese(label), `${selector} 应有中文 aria-label，实际：${JSON.stringify(label)}`);
  }
  const itemLabel = itemOf(mount, 0).getAttribute('aria-label');
  assert(hasChinese(itemLabel), `可选项应有中文 aria-label，实际：${JSON.stringify(itemLabel)}`);
  assertIncludes(itemLabel, 'C:\\work\\hana-mobile', '可选项 aria-label 带路径');

  const status = mount.querySelector('.code-folder-status');
  assertEqual(status.getAttribute('role'), 'status', '状态区应可被朗读');
  assertEqual(status.getAttribute('aria-live'), 'polite', '状态区 aria-live');

  mount.querySelector('.code-folder-cancel').click();
  await promise;
});

await runCheck('长路径中间省略，title 仍是全路径', async () => {
  const longPath = 'C:\\Users\\\\example\\Desktop\\workspace\\hana-mobile\\src\\renderer\\widgets';
  assert(longPath.length > MAX_PATH_CHARS, '夹具路径必须超过上限');

  const mount = makeMount();
  const picker = makePicker(mount, async () => rootsPayload([
    { mountId: 'long', label: '很深的目录', nativeRootPath: longPath, rootAvailable: true },
  ]));
  const promise = picker.open();
  await h.settle();

  const pathEl = mount.querySelector('.code-folder-path');
  const shown = pathEl.textContent;
  assert(shown.includes('…'), `长路径应中间省略，实际：${shown}`);
  assert(shown.length <= MAX_PATH_CHARS, `省略后不应超过 ${MAX_PATH_CHARS} 字符，实际 ${shown.length}`);
  assert(longPath.startsWith(shown.split('…')[0]), '省略后应保留开头');
  assert(longPath.endsWith(shown.split('…')[1]), '省略后应保留结尾');
  assertEqual(pathEl.getAttribute('title'), longPath, 'title 给全路径');
  assertEqual(itemOf(mount, 0).getAttribute('title'), longPath, '按钮 title 也给全路径');

  picker.close();
  await promise;
});

await runCheck('缺少 listRoots 时给出明确错误', async () => {
  const mount = makeMount();
  let message = '';
  try {
    createCodeFolderPicker({ doc, mount });
  } catch (err) {
    message = String(err && err.message);
  }
  assert(message.includes('listRoots'), `错误信息应说明缺少 listRoots，实际：${message}`);
});

await runCheck('pickUsableRoots 判定表', async () => {
  const picked = pickUsableRoots({
    workspaces: [
      { mountId: 'm1', label: '项目', nativeRootPath: ' C:\\p1 ', rootAvailable: true },
      { mountId: 'm2', label: '', nativeRootPath: 'C:\\work\\demo', rootAvailable: true },
      { mountId: 'm3', label: '重复', nativeRootPath: 'C:\\p1', rootAvailable: true },
      { mountId: 'm4', label: '不可用', nativeRootPath: 'C:\\p2', rootAvailable: false },
      { mountId: 'm5', label: '无路径', rootAvailable: true },
      null,
      'junk',
    ],
  });
  assertEqual(picked.map((item) => item.path), ['C:\\p1', 'C:\\work\\demo'], '只留可用根并去重');
  assertEqual(picked[0].label, '项目', 'label 原样保留');
  assertEqual(picked[1].label, 'demo', '没有 label 时用目录名');
  assertEqual(picked[0].mountId, 'm1', 'mountId 透传');

  assertEqual(pickUsableRoots(null), [], 'null 输入');
  assertEqual(pickUsableRoots({ workspaces: 'not-an-array' }), [], 'workspaces 不是数组');
  assertEqual(pickUsableRoots([{ nativeRootPath: '/srv/a', rootAvailable: true }]).length, 1, '直接给数组也认');
  assertEqual(picked[0].source, 'workspace', '工作区根标记来源');
});

await runCheck('pickUsableRoots：远端拿不到路径时用最近会话的 cwd 补位', async () => {
  // 手机经网关时宿主不给 nativeRootPath（只对 loopback 披露），工作区条目就全被滤掉
  const payload = {
    workspaces: [
      { mountId: 'm1', label: 'hana-mobile', rootAvailable: true },
      { mountId: 'm2', label: 'token', rootAvailable: true },
    ],
    recent: [
      { path: 'C:\\Users\\\\example\\Desktop\\workspace\\hana-mobile' },
      { path: ' C:\\Users\\\\example\\Desktop\\workspace\\hana-mobile ', label: '重复' },
      { path: 'C:\\Users\\\\example\\Desktop\\workspace\\token' },
      { path: '' },
      { nope: 1 },
      'C:\\plain\\string',
      null,
    ],
  };
  const picked = pickUsableRoots(payload);
  assertEqual(
    picked.map((item) => item.path),
    [
      'C:\\Users\\\\example\\Desktop\\workspace\\hana-mobile',
      'C:\\Users\\\\example\\Desktop\\workspace\\token',
      'C:\\plain\\string',
    ],
    '只留合法路径并去重（含纯字符串写法）',
  );
  assertEqual(picked[0].source, 'recent', '这些是会话历史目录，标 recent');
  assertEqual(picked[0].label, 'hana-mobile', '没有 label 时用目录名');
  assertEqual(picked[0].mountId, '', 'recent 条目没有 mountId');
});

await runCheck('pickUsableRoots：同一路径优先算工作区，不重复出现', async () => {
  const picked = pickUsableRoots({
    workspaces: [{ mountId: 'm1', label: '项目', nativeRootPath: 'C:\\p1', rootAvailable: true }],
    recent: [{ path: 'C:\\p1' }, { path: 'C:\\p2' }],
  });
  assertEqual(picked.map((item) => item.path), ['C:\\p1', 'C:\\p2'], '同路径只留一条');
  assertEqual(picked[0].source, 'workspace', '保留工作区来源');
  assertEqual(picked[0].label, '项目', '保留工作区 label');
  assertEqual(picked[1].source, 'recent', '另一条仍是 recent');
});

await runCheck('shortenMiddle 判定表', async () => {
  assertEqual(shortenMiddle(''), '', '空串');
  assertEqual(shortenMiddle(null), '', '非字符串');
  assertEqual(shortenMiddle('C:\\a'), 'C:\\a', '短路径不动');

  const exact = 'x'.repeat(MAX_PATH_CHARS);
  assertEqual(shortenMiddle(exact), exact, '正好等于上限不省略');

  const long = 'y'.repeat(MAX_PATH_CHARS + 20);
  const cut = shortenMiddle(long);
  assertEqual(cut.length, MAX_PATH_CHARS, '省略后长度等于上限');
  assertEqual(cut.split('…').length, 2, '只有一个省略号');
  assert(cut.startsWith('y') && cut.endsWith('y'), '头尾都保留');

  // 小长度也要可用，不能出现空片段
  const tiny = shortenMiddle('/very/long/path/here', 6);
  assert(tiny.length <= 6, `小上限也要守住，实际：${tiny}`);
  assert(tiny.includes('…'), '小上限也要有省略号');
});

await h.settle();
if (rejections.length) {
  bad += 1;
  console.log(`FAIL  出现未处理的 Promise 拒绝：${rejections.map((r) => String(r && r.message ? r.message : r)).join('; ')}`);
} else {
  console.log('PASS  没有未处理的 Promise 拒绝');
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
