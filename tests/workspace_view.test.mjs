/* tests/workspace_view.test.mjs
 *
 * 工作区视图层（workspace-view）单元与契约测试
 * 覆盖：
 * 1. 构造隔离：不创建 DOM，不调用 service
 * 2. 换 root 与 close->reopen 旧回包彻底丢弃（currentSnapshot 身份 + reqSeq 比对）
 * 3. 上传写操作强制确认、缺省 fail-closed、重名默认拦截拒绝
 * 4. confirm 挂起期间换 root / close 拦截（不向失效 target 发 POST）
 * 5. 并发上传锁与上传完成上下文校验
 * 6. 顺序单文件流式处理，change 异常 finally 清空 input.value
 * 7. previewFile 携带 previewSeq，换 root / 导航关闭预览，旧预览晚回包不创建 Blob
 * 8. 文本预览使用 readTextPreview (<=64KiB)，超限截断提示；未知二进制引导下载
 * 9. 真实根选择器：去重、默认根 agentId、切换取消旧 snapshot/预览/待上传
 * 10. 返回层级 back()：预览打开时只关预览、再返回才关面板；close() 仍彻底关闭
 */

import assert from 'node:assert/strict';
import { createWorkspaceView } from '../web/workspace-view.js';

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

function createMockDocument() {
  const bodyChildren = [];
  function createMockElement(tag, cls = '') {
    const listeners = new Map();
    const children = [];
    const classListSet = new Set(cls ? cls.split(/\s+/).filter(Boolean) : []);

    const el = {
      tagName: tag.toUpperCase(),
      nodeType: 1,
      style: {},
      attributes: new Map(),
      children,
      get className() {
        return Array.from(classListSet).join(' ');
      },
      set className(val) {
        classListSet.clear();
        if (val) val.split(/\s+/).filter(Boolean).forEach(c => classListSet.add(c));
      },
      classList: {
        add: (...args) => args.forEach(c => classListSet.add(c)),
        remove: (...args) => args.forEach(c => classListSet.delete(c)),
        contains: (c) => classListSet.has(c),
      },
      _text: '',
      get textContent() {
        return this._text;
      },
      set textContent(val) {
        this._text = String(val == null ? '' : val);
        children.length = 0;
      },
      _html: '',
      get innerHTML() {
        return this._html;
      },
      set innerHTML(val) {
        this._html = String(val == null ? '' : val);
        if (val === '') {
          children.length = 0;
          this._text = '';
        }
      },
      appendChild(child) {
        child.parentNode = this;
        children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = children.indexOf(child);
        if (idx !== -1) {
          children.splice(idx, 1);
          child.parentNode = null;
        }
        return child;
      },
      remove() {
        if (this.parentNode) {
          this.parentNode.removeChild(this);
        }
      },
      addEventListener(type, fn, options = {}) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push({ fn, once: !!options.once });
      },
      dispatchEvent(event) {
        const type = typeof event === 'string' ? event : event.type;
        const list = listeners.get(type) ? [...listeners.get(type)] : [];
        for (const item of list) {
          item.fn.call(this, typeof event === 'string' ? { type } : event);
          if (item.once) {
            const arr = listeners.get(type);
            const idx = arr.indexOf(item);
            if (idx !== -1) arr.splice(idx, 1);
          }
        }
      },
      setAttribute(k, v) { this.attributes.set(k, String(v)); },
      getAttribute(k) { return this.attributes.get(k) || null; },
      querySelector(sel) {
        return findFirst(this, sel);
      },
      querySelectorAll(sel) {
        const res = [];
        findAll(this, sel, res);
        return res;
      },
    };
    return el;
  }

  function matches(node, sel) {
    if (sel.startsWith('.')) {
      const classes = sel.split('.').filter(Boolean);
      return classes.every(c => node.classList.contains(c));
    }
    return node.tagName.toLowerCase() === sel.toLowerCase();
  }

  function findFirst(parent, sel) {
    for (const child of parent.children) {
      if (matches(child, sel)) return child;
      const found = findFirst(child, sel);
      if (found) return found;
    }
    return null;
  }

  function findAll(parent, sel, res) {
    for (const child of parent.children) {
      if (matches(child, sel)) res.push(child);
      findAll(child, sel, res);
    }
  }

  const doc = {
    createElement: (tag) => createMockElement(tag),
    body: {
      tagName: 'BODY',
      children: bodyChildren,
      appendChild(child) {
        child.parentNode = this;
        bodyChildren.push(child);
        return child;
      },
      removeChild(child) {
        const idx = bodyChildren.indexOf(child);
        if (idx !== -1) {
          bodyChildren.splice(idx, 1);
          child.parentNode = null;
        }
        return child;
      },
      querySelector: (sel) => findFirst({ children: bodyChildren }, sel),
      querySelectorAll: (sel) => {
        const res = [];
        findAll({ children: bodyChildren }, sel, res);
        return res;
      },
    },
  };
  return doc;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 1000, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`waitFor timeout: ${label}`);
}

function nativeFile(name, size, base64 = 'MQ==') {
  return { name, size, base64 };
}

/** 可控 FileReader：记录 read 开始/结束，可被 gate 卡住。 */
function installFakeFileReader({ events, gates = new Map() }) {
  const Original = globalThis.FileReader;
  class FakeFileReader {
    constructor() {
      this.result = null;
      this.error = null;
      this.onload = null;
      this.onerror = null;
    }
    readAsDataURL(file) {
      events.push(`read:start:${file.name}`);
      const gate = gates.get(file.name);
      Promise.resolve(gate || null).then(() => {
        this.result = `data:application/octet-stream;base64,${file.base64}`;
        events.push(`read:end:${file.name}`);
        if (this.onload) this.onload();
      }, (err) => {
        this.error = err;
        if (this.onerror) this.onerror();
      });
    }
  }
  globalThis.FileReader = FakeFileReader;
  return () => { globalThis.FileReader = Original; };
}

function triggerFileInput(doc, files) {
  const input = doc.body.querySelector('input');
  assert.ok(input, '应存在隐藏 file input');
  input.files = files;
  input.value = 'C:\\fakepath\\selected';
  input.dispatchEvent({ type: 'change', target: input });
  return input;
}

/* ------------------------------------------------------------------ */
/* 1. 构造隔离测试 (Lazy open)                                         */
/* ------------------------------------------------------------------ */

await t('createWorkspaceView: 构造时不创建 DOM，不调用 service', () => {
  const doc = createMockDocument();
  let listCalled = false;
  const mockService = {
    list: async () => { listCalled = true; return { ok: true, files: [] }; },
  };

  const view = createWorkspaceView({
    service: mockService,
    document: doc,
  });

  assert.equal(doc.body.children.length, 0);
  assert.equal(listCalled, false);
  assert.equal(view.isOpen(), false);
});

await t('根选择器: setRoots 不创建 DOM，不隐式 open', () => {
  const doc = createMockDocument();
  let listCalled = false;
  const view = createWorkspaceView({
    service: {
      list: async () => { listCalled = true; return { ok: true, files: [] }; },
      downloadUrl: () => '/download',
    },
    document: doc,
  });

  view.setRoots([
    { mountId: 'default', agentId: 'agent-1', label: 'Agent默认工作区' },
    { mountId: 'mount-alpha', label: '项目 Alpha' },
  ]);

  assert.equal(doc.body.children.length, 0, '构造与 setRoots 都必须保持 lazy');
  assert.equal(listCalled, false, 'setRoots 不得隐式打开或拉取');
});

await t('根选择器: 直传 listRoots() 的 {workspaces} 结果必须展开具名根（真机具名根就是这样丢的）', async () => {
  const doc = createMockDocument();
  const service = {
    async list() {
      return { ok: true, files: [] };
    },
  };
  const view = createWorkspaceView({ service, document: doc });

  // workspaceService.listRoots() 的真实返回形状（见 workspace-service.js listRoots）
  view.setRoots({
    ok: true,
    studioId: 'studio-1',
    localDeviceName: 'pc',
    workspaces: [
      { mountId: 'default', agentId: 'agent-1', label: 'Agent 默认工作区' },
      { mountId: 'mount-alpha', workspaceId: 'ws-1', label: '项目 Alpha' },
    ],
  });

  await view.open({ mountId: 'default', agentId: 'agent-1', label: 'Agent 默认工作区' });

  const select = doc.body.querySelector('.workspace-root-select');
  assert.ok(select, '应创建根选择器');
  assert.equal(select.hidden, false, '有根时必须显示选择器');
  const options = select.children.filter((c) => c.tagName === 'OPTION').map((o) => o.textContent);
  assert.deepEqual(
    options,
    ['Agent 默认工作区', '项目 Alpha'],
    `具名根被静默丢弃：${JSON.stringify(options)}`
  );
});

await t('根选择器: 入参形状不认识时明确提示，不静默当空成功', async () => {
  const doc = createMockDocument();
  let toastMsg = '';
  const view = createWorkspaceView({
    service: {
      async list() {
        return { ok: true, files: [] };
      },
    },
    document: doc,
    toast: (msg) => {
      toastMsg = String(msg);
    },
  });

  view.setRoots({ roots: [] }); // 既不是数组，也没有 workspaces 字段
  assert.match(toastMsg, /工作区根列表格式异常/);

  toastMsg = '';
  view.setRoots([]); // 合法的空数组：不该报错
  assert.equal(toastMsg, '');
  assert.equal(doc.body.children.length, 0, 'setRoots 仍然保持 lazy');
});

await t('根选择器: 按 mountId+agentId 去重，label 用 textContent，default 无 agent 不出现', async () => {
  const doc = createMockDocument();
  const calls = [];
  const service = {
    list: async (ctx) => { calls.push(ctx); return { ok: true, files: [] }; },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({ service, document: doc });

  view.setRoots([
    { mountId: 'default', agentId: 'agent-1', label: '<b>默认</b>' },
    { mountId: 'default', agentId: 'agent-1', label: '重复的默认根' },
    { mountId: 'default', label: '缺少 agent 的默认根' },
    { workspaceId: 'ghost', label: '没有 mountId 的未知根' },
    { mountId: 'mount-alpha', label: '项目 Alpha' },
    { mountId: 'mount-alpha', agentId: '', label: '同名不同引用的 Alpha' },
  ]);

  await view.open({ mountId: 'default', agentId: 'agent-1', label: 'Agent默认工作区' });

  const select = doc.body.querySelector('.workspace-root-select');
  assert.ok(select, '应创建 namespaced workspace-root-select');
  assert.equal(select.hidden, false);

  const options = select.children.filter((child) => child.tagName === 'OPTION');
  assert.deepEqual(
    options.map((opt) => opt.textContent),
    ['<b>默认</b>', '项目 Alpha'],
    'label 必须原样作为 textContent，不能当 HTML；重复键只保留第一个'
  );
  assert.equal(options[0].innerHTML, '', 'label 不得写 innerHTML');

  const defaultKey = JSON.stringify(['default', 'agent-1']);
  const namedKey = JSON.stringify(['mount-alpha', '']);
  assert.deepEqual(options.map((opt) => opt.value), [defaultKey, namedKey]);
  assert.equal(select.value, defaultKey);

  // 默认根没有 agentId 时，open 直接拒绝且不发请求
  const before = calls.length;
  const res = await view.open({ mountId: 'default' });
  assert.equal(res.cancelled, true);
  assert.equal(calls.length, before);
});

await t('根选择器: change 用真实 mountId 打开 named root，不拼文件系统路径', async () => {
  const doc = createMockDocument();
  const calls = [];
  const service = {
    list: async (ctx, subdir) => {
      calls.push({ ...ctx, subdir });
      return { ok: true, files: [{ name: `${ctx.mountId}.txt`, isDir: false }] };
    },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({ service, document: doc });

  view.setRoots([
    { mountId: 'default', agentId: 'agent-1', label: 'Agent默认工作区' },
    { mountId: 'mount-alpha', label: '项目 Alpha' },
  ]);
  await view.open({ mountId: 'default', agentId: 'agent-1', label: 'Agent默认工作区' });

  const select = doc.body.querySelector('.workspace-root-select');
  const named = select.children.find((child) => child.textContent === '项目 Alpha');
  assert.ok(named);

  select.value = named.value;
  select.dispatchEvent({ type: 'change', target: select });
  await waitFor(() => calls.length === 2, { label: '选择器换 root 完成' });

  assert.equal(calls[1].mountId, 'mount-alpha');
  assert.ok(!calls[1].agentId, 'named root 可以不带 agentId');
  assert.equal(calls[1].subdir, '');
  assert.equal('path' in calls[1], false, '不得拼文件系统 path');
  assert.equal('rootPath' in calls[1], false, '不得伪造 rootPath');
  assert.equal(select.value, named.value);
  assert.equal(doc.body.querySelector('.workspace-title').textContent, '项目 Alpha');
  assert.equal(
    doc.body.querySelectorAll('.workspace-item-name')[0].textContent,
    'mount-alpha.txt',
    '列表必须来自 mountId 对应的 API 结果'
  );
});

await t('根选择器: 未知 root 被忽略，不 open、不伪造路径', async () => {
  const doc = createMockDocument();
  const calls = [];
  let toastMsg = '';
  const service = {
    list: async (ctx) => { calls.push(ctx); return { ok: true, files: [] }; },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({
    service,
    document: doc,
    toast: (msg) => { toastMsg = String(msg); },
  });

  view.setRoots([
    { mountId: 'default', agentId: 'agent-1', label: 'Agent默认工作区' },
    { mountId: 'mount-alpha', label: '项目 Alpha' },
  ]);
  await view.open({ mountId: 'default', agentId: 'agent-1', label: 'Agent默认工作区' });

  const select = doc.body.querySelector('.workspace-root-select');
  const before = calls.length;
  select.value = JSON.stringify(['ghost-root', 'ghost-agent']);
  select.dispatchEvent({ type: 'change', target: select });
  await delay(20);

  assert.equal(calls.length, before, '未知 root 不得调用 list');
  assert.ok(toastMsg.includes('未知工作区根'));
  assert.equal(doc.body.querySelector('.workspace-title').textContent, 'Agent默认工作区');
  assert.equal(select.value, JSON.stringify(['default', 'agent-1']), '选择器应回到当前 root');
});

await t('根选择器: setRoots 刷新 options 但不隐式切 root/发请求', async () => {
  const doc = createMockDocument();
  const calls = [];
  const service = {
    list: async (ctx) => { calls.push(ctx); return { ok: true, files: [] }; },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({ service, document: doc });

  view.setRoots([{ mountId: 'default', agentId: 'agent-1', label: 'Agent默认工作区' }]);
  await view.open({ mountId: 'default', agentId: 'agent-1', label: 'Agent默认工作区' });
  const before = calls.length;

  view.setRoots([
    { mountId: 'default', agentId: 'agent-1', label: 'Agent默认工作区' },
    { mountId: 'mount-alpha', label: '项目 Alpha' },
  ]);
  await delay(20);

  assert.equal(calls.length, before, 'setRoots 不得隐式 open');
  assert.equal(doc.body.querySelector('.workspace-title').textContent, 'Agent默认工作区');
  assert.equal(doc.body.querySelectorAll('.workspace-root-option').length, 2);

  // 当前 root 不在新列表时只显示占位，不自动选第一个/切 root
  view.setRoots([{ mountId: 'mount-alpha', label: '项目 Alpha' }]);
  await delay(20);
  assert.equal(calls.length, before, '仍然不得隐式 open');
  const select = doc.body.querySelector('.workspace-root-select');
  assert.equal(select.value, '');
  assert.equal(select.children[0].textContent, '选择工作区根');
  assert.equal(doc.body.querySelector('.workspace-title').textContent, 'Agent默认工作区');
});

await t('根选择器切换关闭旧预览，旧回包不渲染', async () => {
  const doc = createMockDocument();
  const listCalls = [];
  let resolveRead;
  const gate = new Promise((r) => { resolveRead = r; });

  const service = {
    list: async (ctx) => { listCalls.push(ctx); return { ok: true, files: [] }; },
    readTextPreview: async () => gate,
    downloadUrl: () => '/download/slow.txt',
  };
  const view = createWorkspaceView({ service, document: doc });

  view.setRoots([
    { mountId: 'default', agentId: 'agent-1', label: 'Agent默认工作区' },
    { mountId: 'mount-alpha', label: '项目 Alpha' },
  ]);
  await view.open({ mountId: 'default', agentId: 'agent-1', label: 'Agent默认工作区' });

  const previewing = view.previewFile('slow.txt');
  const select = doc.body.querySelector('.workspace-root-select');
  const named = select.children.find((child) => child.textContent === '项目 Alpha');
  select.value = named.value;
  select.dispatchEvent({ type: 'change', target: select });
  await waitFor(() => listCalls.length === 2, { label: '选择器已切 root' });

  resolveRead({ ok: true, text: 'secret', truncated: false, totalBytes: 6 });
  await previewing;

  assert.equal(doc.body.querySelector('.workspace-preview-modal').hidden, true);
  assert.equal(doc.body.querySelector('.workspace-preview-text'), null, '旧预览回包不得渲染');
});

await t('根选择器切换继续取消旧 snapshot 的待上传，不发 POST', async () => {
  const doc = createMockDocument();
  const listCalls = [];
  let postCalled = false;
  let resolveConfirm;
  const gate = new Promise((r) => { resolveConfirm = r; });

  const service = {
    list: async (ctx) => { listCalls.push(ctx); return { ok: true, files: [] }; },
    upload: async () => { postCalled = true; return { ok: true }; },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({
    service,
    document: doc,
    confirmAction: async () => gate,
  });

  view.setRoots([
    { mountId: 'default', agentId: 'agent-1', label: 'Agent默认工作区' },
    { mountId: 'mount-alpha', label: '项目 Alpha' },
  ]);
  await view.open({ mountId: 'default', agentId: 'agent-1', label: 'Agent默认工作区' });

  const pending = view.handleFilesSelected([{ name: 'x.txt', contentBase64: 'MQ==' }]);
  const select = doc.body.querySelector('.workspace-root-select');
  const named = select.children.find((child) => child.textContent === '项目 Alpha');
  select.value = named.value;
  select.dispatchEvent({ type: 'change', target: select });
  await waitFor(() => listCalls.length === 2, { label: '选择器已切 root' });

  resolveConfirm(true);
  const res = await pending;
  assert.equal(res.cancelled, true);
  assert.equal(postCalled, false, '旧 snapshot 的待上传必须取消');
});

/* ------------------------------------------------------------------ */
/* 2. 换 root 与 close->reopen 竞态测试                                  */
/* ------------------------------------------------------------------ */

await t('换 root 竞态: 旧 root 的延迟响应绝对不覆盖新 root 的 UI', async () => {
  const doc = createMockDocument();
  let resolveRoot1;
  const root1Promise = new Promise(r => { resolveRoot1 = r; });

  const mockService = {
    list: async (ctx) => {
      if (ctx.mountId === 'root1') {
        await root1Promise;
        return { ok: true, mountId: 'root1', files: [{ name: 'root1_file.txt', isDir: false }] };
      }
      return { ok: true, mountId: 'root2', files: [{ name: 'root2_file.txt', isDir: false }] };
    },
    downloadUrl: () => '/download',
  };

  const view = createWorkspaceView({ service: mockService, document: doc });
  
  // 先打开 root1 (挂起)
  const open1 = view.open({ mountId: 'root1', agentId: 'a1' });
  // 紧接着切换打开 root2 (快速返回)
  const open2 = view.open({ mountId: 'root2', agentId: 'a2' });
  await open2;

  // 放行 root1 的旧回包
  resolveRoot1();
  await open1;

  // 界面必须停留在 root2 的文件，不能被 root1 覆盖
  const items = doc.body.querySelectorAll('.workspace-item-name');
  assert.equal(items.length, 1);
  assert.equal(items[0].textContent, 'root2_file.txt');
});

await t('close 立即 reopen 新 root 时，旧回包彻底丢弃', async () => {
  const doc = createMockDocument();
  let resolveReq1;
  const req1Promise = new Promise(r => { resolveReq1 = r; });

  const mockService = {
    list: async (ctx) => {
      if (ctx.mountId === 'old') {
        await req1Promise;
        return { ok: true, mountId: 'old', files: [{ name: 'old.txt', isDir: false }] };
      }
      return { ok: true, mountId: 'new', files: [{ name: 'new.txt', isDir: false }] };
    },
    downloadUrl: () => '/download',
  };

  const view = createWorkspaceView({ service: mockService, document: doc });
  const pOld = view.open({ mountId: 'old', agentId: 'a' });
  view.close();
  const pNew = view.open({ mountId: 'new', agentId: 'b' });
  await pNew;

  resolveReq1();
  await pOld;

  const items = doc.body.querySelectorAll('.workspace-item-name');
  assert.equal(items.length, 1);
  assert.equal(items[0].textContent, 'new.txt');
});

/* ------------------------------------------------------------------ */
/* 3. 上传写操作确认与重名拦截测试                                        */
/* ------------------------------------------------------------------ */

await t('写操作确认: 缺省 confirmAction 默认 fail-closed (返回 false)，不发起 POST', async () => {
  const doc = createMockDocument();
  let postCalled = false;
  const mockService = {
    list: async () => ({ ok: true, files: [] }),
    upload: async () => { postCalled = true; return { ok: true }; },
    downloadUrl: () => '/download',
  };

  // 不传 confirmAction
  const view = createWorkspaceView({ service: mockService, document: doc });
  await view.open({ mountId: 'default', agentId: 'a' });

  const res = await view.handleFilesSelected([{ name: 'test.txt', contentBase64: 'MQ==' }]);
  assert.equal(res.cancelled, true);
  assert.equal(postCalled, false, '缺省确认器必须 fail-closed，不得发起 POST');
});

await t('重名拦截: 检测到已知重名默认拒绝覆盖，要求本地改名重选', async () => {
  const doc = createMockDocument();
  let postCalled = false;
  let toastMsg = '';
  const mockService = {
    list: async () => ({ ok: true, files: [{ name: 'dup.txt', isDir: false }] }),
    upload: async () => { postCalled = true; return { ok: true }; },
    downloadUrl: () => '/download',
  };

  const view = createWorkspaceView({
    service: mockService,
    document: doc,
    confirmAction: async () => true,
    toast: (msg) => { toastMsg = msg; },
  });
  await view.open({ mountId: 'default', agentId: 'a' });

  const res = await view.handleFilesSelected([{ name: 'dup.txt', contentBase64: 'MQ==' }]);
  assert.equal(res.cancelled, true);
  assert.equal(postCalled, false, '已知重名文件必须直接拒绝');
  assert.ok(toastMsg.includes('重名') || toastMsg.includes('已存在'));
});

await t('文件名: 首尾空白整体拒绝，查重/确认/POST 使用同一原名', async () => {
  const doc = createMockDocument();
  let confirmCalls = 0;
  let postedNames = null;
  const mockService = {
    list: async () => ({ ok: true, files: [{ name: 'foo.txt', isDir: false }] }),
    upload: async (ctx, { files }) => {
      postedNames = files.map((f) => f.name);
      return { ok: true, results: files.map((f) => ({ name: f.name, ok: true })) };
    },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({
    service: mockService,
    document: doc,
    confirmAction: async () => { confirmCalls += 1; return true; },
  });
  await view.open({ mountId: 'default', agentId: 'a' });

  const res = await view.handleFilesSelected([{ name: ' foo.txt', contentBase64: 'MQ==' }]);
  assert.equal(res.cancelled, true, '首尾空白不能 trim 后当成 foo.txt 上传');
  assert.equal(confirmCalls, 0, '非法文件名不得进入确认');
  assert.equal(postedNames, null, '非法文件名不得 POST');
});

await t('重名拦截: Windows 部署按大小写不敏感查重（FOO.TXT vs foo.txt）', async () => {
  const doc = createMockDocument();
  let confirmCalls = 0;
  let postCalled = false;
  const mockService = {
    list: async () => ({ ok: true, files: [{ name: 'foo.txt', isDir: false }] }),
    upload: async () => { postCalled = true; return { ok: true }; },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({
    service: mockService,
    document: doc,
    confirmAction: async () => { confirmCalls += 1; return true; },
  });
  await view.open({ mountId: 'default', agentId: 'a' });

  const res = await view.handleFilesSelected([{ name: 'FOO.TXT', contentBase64: 'MQ==' }]);
  assert.equal(res.cancelled, true);
  assert.equal(confirmCalls, 0);
  assert.equal(postCalled, false);
});

await t('重名拦截: 同一批内大小写重名也整体拒绝', async () => {
  const doc = createMockDocument();
  let confirmCalls = 0;
  let postCalled = false;
  const mockService = {
    list: async () => ({ ok: true, files: [] }),
    upload: async () => { postCalled = true; return { ok: true }; },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({
    service: mockService,
    document: doc,
    confirmAction: async () => { confirmCalls += 1; return true; },
  });
  await view.open({ mountId: 'default', agentId: 'a' });

  const res = await view.handleFilesSelected([
    { name: 'a.txt', contentBase64: 'MQ==' },
    { name: 'A.TXT', contentBase64: 'Mg==' },
  ]);
  assert.equal(res.cancelled, true);
  assert.equal(confirmCalls, 0);
  assert.equal(postCalled, false);
});

await t('合法文件名原样贯穿确认与 POST（不 trim、不 decode）', async () => {
  const doc = createMockDocument();
  let confirmedNames = null;
  let postedNames = null;
  const mockService = {
    list: async () => ({ ok: true, files: [] }),
    upload: async (ctx, { files }) => {
      postedNames = files.map((f) => f.name);
      return { ok: true, results: files.map((f) => ({ name: f.name, ok: true })) };
    },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({
    service: mockService,
    document: doc,
    confirmAction: async ({ fileNames }) => { confirmedNames = [...fileNames]; return true; },
  });
  await view.open({ mountId: 'default', agentId: 'a' });

  const res = await view.handleFilesSelected([{ name: 'my photo (1).png', contentBase64: 'MQ==' }]);
  assert.equal(res.ok, true);
  assert.deepEqual(confirmedNames, ['my photo (1).png']);
  assert.deepEqual(postedNames, ['my photo (1).png']);
});

await t('confirm 只接受严格 true：truthy 值或 throw 一律拒绝', async () => {
  for (const answer of ['yes', 1, {}, new Error('nope')]) {
    const doc = createMockDocument();
    let postCalled = false;
    const mockService = {
      list: async () => ({ ok: true, files: [] }),
      upload: async () => { postCalled = true; return { ok: true }; },
      downloadUrl: () => '/download',
    };
    const view = createWorkspaceView({
      service: mockService,
      document: doc,
      confirmAction: async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    await view.open({ mountId: 'default', agentId: 'a' });
    const res = await view.handleFilesSelected([{ name: 'x.txt', contentBase64: 'MQ==' }]);
    assert.equal(res.cancelled, true, `confirm 返回 ${String(answer)} 时必须拒绝`);
    assert.equal(postCalled, false);
  }
});

await t('confirm 挂起期间换 root 或 close，确认返回 true 后亦不发起 POST', async () => {
  const doc = createMockDocument();
  let postCalled = false;
  let resolveConfirm;
  const confirmPromise = new Promise(r => { resolveConfirm = r; });

  const mockService = {
    list: async () => ({ ok: true, files: [] }),
    upload: async () => { postCalled = true; return { ok: true }; },
    downloadUrl: () => '/download',
  };

  const view = createWorkspaceView({
    service: mockService,
    document: doc,
    confirmAction: async () => confirmPromise,
  });
  await view.open({ mountId: 'rootA', agentId: 'a' });

  const selectPromise = view.handleFilesSelected([{ name: 'f.txt', contentBase64: 'MQ==' }]);

  // 用户换到 rootB
  await view.open({ mountId: 'rootB', agentId: 'b' });

  // 此时之前挂起的确认返回 true
  resolveConfirm(true);
  const result = await selectPromise;

  assert.equal(result.cancelled, true);
  assert.equal(postCalled, false, '目标上下文失效时严禁继续发向旧 root 或新 root');
});

await t('并发上传锁: 上传中禁止并发重入', async () => {
  const doc = createMockDocument();
  let uploadStarted;
  const uploadStartedPromise = new Promise(r => { uploadStarted = r; });
  let resolveUpload;
  const uploadPromise = new Promise(r => { resolveUpload = r; });
  let uploadCallCount = 0;

  const mockService = {
    list: async () => ({ ok: true, files: [] }),
    upload: async () => {
      uploadCallCount += 1;
      if (uploadStarted) uploadStarted();
      await uploadPromise;
      return { ok: true, results: [{ name: 'f.txt', ok: true }] };
    },
    downloadUrl: () => '/download',
  };

  const view = createWorkspaceView({
    service: mockService,
    document: doc,
    confirmAction: async () => true,
  });
  await view.open({ mountId: 'default', agentId: 'a' });

  // 发起第 1 个上传
  const up1 = view.handleFilesSelected([{ name: 'f1.txt', contentBase64: 'MQ==' }]);

  // 等待第 1 个上传真正进入 upload (此时 isUploading = true)
  await uploadStartedPromise;

  // 此时并发发起第 2 个上传
  const res2 = await view.handleFilesSelected([{ name: 'f2.txt', contentBase64: 'Mg==' }]);
  assert.equal(res2.cancelled, true, '并发上传必须被锁拦截');

  // 放行第 1 个上传
  resolveUpload();
  await up1;
  assert.equal(uploadCallCount, 1);
});

await t('并发确认锁: 确认尚未返回时第二次选择立即拒绝，只确认一次、只 POST 一次', async () => {
  const doc = createMockDocument();
  let confirmCalls = 0;
  let uploadCalls = 0;
  let resolveConfirm;
  const gate = new Promise((r) => { resolveConfirm = r; });

  const mockService = {
    list: async () => ({ ok: true, files: [] }),
    upload: async (ctx, { files }) => {
      uploadCalls += 1;
      return { ok: true, results: files.map((f) => ({ name: f.name, ok: true })) };
    },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({
    service: mockService,
    document: doc,
    confirmAction: async () => { confirmCalls += 1; return gate; },
  });
  await view.open({ mountId: 'default', agentId: 'a' });

  const p1 = view.handleFilesSelected([{ name: 'f1.txt', contentBase64: 'MQ==' }]);
  const p2 = view.handleFilesSelected([{ name: 'f2.txt', contentBase64: 'Mg==' }]);

  try {
    const r2 = await Promise.race([
      p2,
      delay(100).then(() => ({ timedOut: true })),
    ]);
    assert.equal(r2.timedOut, undefined, '第二次选择不得卡在同一确认门上');
    assert.equal(r2.cancelled, true);
    assert.equal(confirmCalls, 1, '确认器只能被调用一次');
  } finally {
    resolveConfirm(true);
    await Promise.allSettled([p1, p2]);
  }

  assert.equal(uploadCalls, 1, '只能有一个上传 POST');
});

await t('原生 File: input change 严格 read1→POST1→read2→POST2，finally 清空 value', async () => {
  const doc = createMockDocument();
  const events = [];
  let uploaded = 0;
  let settle;
  const done = new Promise((r) => { settle = r; });

  const mockService = {
    list: async () => ({ ok: true, files: [] }),
    upload: async (ctx, { files }) => {
      uploaded += 1;
      events.push(`upload:${files.map((f) => f.name).join(',')}`);
      assert.equal(files.length, 1, '原生文件必须单文件 POST，不得批量累积');
      return { ok: true, results: files.map((f) => ({ name: f.name, ok: true })) };
    },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({
    service: mockService,
    document: doc,
    confirmAction: async () => true,
    toast: (msg) => {
      if (/上传成功|上传失败|部分文件上传失败/.test(msg)) settle(msg);
    },
  });
  await view.open({ mountId: 'default', agentId: 'a' });

  const restore = installFakeFileReader({ events });
  try {
    const input = triggerFileInput(doc, [
      nativeFile('f1.txt', 4),
      nativeFile('f2.txt', 5),
    ]);

    await Promise.race([
      done,
      delay(1000).then(() => { throw new Error('input change 上传未在 1s 内结束'); }),
    ]);
    await waitFor(() => input.value === '', { label: 'input.value 清空' });

    assert.deepEqual(events, [
      'read:start:f1.txt',
      'read:end:f1.txt',
      'upload:f1.txt',
      'read:start:f2.txt',
      'read:end:f2.txt',
      'upload:f2.txt',
    ]);
    assert.equal(uploaded, 2);
  } finally {
    restore();
  }
});

await t('原生 File: 超限在任何读取/确认/POST 之前拒绝', async () => {
  const doc = createMockDocument();
  const events = [];
  let confirmCalls = 0;
  let uploadCalls = 0;
  let lastToast = '';
  const mockService = {
    list: async () => ({ ok: true, files: [] }),
    upload: async () => { uploadCalls += 1; return { ok: true }; },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({
    service: mockService,
    document: doc,
    confirmAction: async () => { confirmCalls += 1; return true; },
    toast: (msg) => { lastToast = String(msg); },
  });
  await view.open({ mountId: 'default', agentId: 'a' });

  const restore = installFakeFileReader({ events });
  try {
    const tooMany = Array.from({ length: 11 }, (_, i) => nativeFile(`f${i}.txt`, 1));
    triggerFileInput(doc, tooMany);
    await waitFor(() => lastToast.includes('数量超过限制'), { label: '数量超限提示' });
    await delay(20);
    assert.equal(events.length, 0, '超限不得读取任何文件');
    assert.equal(confirmCalls, 0);
    assert.equal(uploadCalls, 0);

    lastToast = '';
    triggerFileInput(doc, [nativeFile('huge.bin', 10 * 1024 * 1024 + 1)]);
    await waitFor(() => lastToast.includes('超过单文件'), { label: '单文件超限提示' });
    await delay(20);
    assert.equal(events.length, 0, '单文件超限也不得读取');
    assert.equal(confirmCalls, 0);
    assert.equal(uploadCalls, 0);
  } finally {
    restore();
  }
});

await t('原生 File: 读取期间换 root 立即失效，不发 POST、不借用新 root', async () => {
  const doc = createMockDocument();
  const events = [];
  let uploadCalls = 0;
  let confirmTarget = null;
  let resolveRead;
  const gate = new Promise((r) => { resolveRead = r; });
  const gates = new Map([['f.txt', gate]]);

  const mockService = {
    list: async () => ({ ok: true, files: [] }),
    upload: async () => { uploadCalls += 1; return { ok: true }; },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({
    service: mockService,
    document: doc,
    confirmAction: async ({ target }) => { confirmTarget = target.mountId; return true; },
  });
  await view.open({ mountId: 'rootA', agentId: 'a' });

  const restore = installFakeFileReader({ events, gates });
  try {
    const input = triggerFileInput(doc, [nativeFile('f.txt', 4)]);
    await waitFor(() => events.includes('read:start:f.txt'), { label: 'read 已开始' });

    await view.open({ mountId: 'rootB', agentId: 'b' });
    resolveRead();

    await waitFor(() => input.value === '', { label: 'input.value 清空' });
    await delay(30);

    assert.equal(confirmTarget, 'rootA', '确认必须绑定进入时捕获的 root');
    assert.equal(uploadCalls, 0, '读取完成后不得向新 root 或旧 root 发 POST');
  } finally {
    restore();
  }
});

await t('原生 File: 中途失败保留已上传结果，不重试、不重复确认、不继续后续文件', async () => {
  const doc = createMockDocument();
  const events = [];
  let confirmCalls = 0;
  const uploadOrder = [];

  const mockService = {
    list: async () => ({ ok: true, files: [] }),
    upload: async (ctx, { files }) => {
      const name = files[0].name;
      uploadOrder.push(name);
      if (name === 'f2.txt') {
        return { ok: false, results: [{ name, ok: false, error: 'disk_full' }] };
      }
      return { ok: true, results: [{ name, ok: true }] };
    },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({
    service: mockService,
    document: doc,
    confirmAction: async () => { confirmCalls += 1; return true; },
  });
  await view.open({ mountId: 'default', agentId: 'a' });

  const restore = installFakeFileReader({ events });
  try {
    assert.equal(typeof view.handleFileInputFiles, 'function', '需要暴露原生 File 处理入口供集成与测试');
    const res = await view.handleFileInputFiles([
      nativeFile('f1.txt', 4),
      nativeFile('f2.txt', 4),
      nativeFile('f3.txt', 4),
    ]);

    assert.equal(res.ok, false);
    assert.deepEqual(uploadOrder, ['f1.txt', 'f2.txt'], '失败后必须停止，不重试已成功的文件');
    assert.equal(confirmCalls, 1, '同一 batch 只确认一次');
    assert.equal(res.results.length, 2, '已上传结果与失败项都必须保留');
    assert.equal(res.results[0].ok, true);
    assert.equal(res.results[1].ok, false);
    assert.equal(res.results[1].error, 'disk_full');
    assert.equal(events.includes('read:start:f3.txt'), false, '失败后不得继续读取后续文件');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ */
/* 4. previewFile 防乱序与安全文本预览                                   */
/* ------------------------------------------------------------------ */

await t('previewFile: 慢请求 A 晚于快请求 B 回包时不覆盖 UI 且不产生新 Blob', async () => {
  const doc = createMockDocument();
  let createdBlobs = 0;
  globalThis.URL = {
    createObjectURL: () => { createdBlobs += 1; return `blob:${createdBlobs}`; },
    revokeObjectURL: () => {},
  };

  let resolveA;
  const promiseA = new Promise(r => { resolveA = r; });

  const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const mockService = {
    list: async () => ({ ok: true, files: [] }),
    readFullBytes: async (ctx, { name }) => {
      if (name === 'slowA.png') {
        await promiseA;
        return { ok: true, filename: 'slowA.png', bytes: pngBytes };
      }
      return { ok: true, filename: 'fastB.png', bytes: pngBytes };
    },
    downloadUrl: () => '/download',
  };

  const view = createWorkspaceView({ service: mockService, document: doc });
  await view.open({ mountId: 'default', agentId: 'a' });

  const pA = view.previewFile('slowA.png');
  const pB = view.previewFile('fastB.png');
  await pB;

  assert.equal(createdBlobs, 1, '快速请求 B 创建 1 个 Blob');
  const previewTitle = doc.body.querySelector('.workspace-preview-title');
  assert.ok(previewTitle.textContent.includes('fastB.png'));

  // 放行慢请求 A
  resolveA();
  await pA;

  assert.equal(createdBlobs, 1, '慢请求 A 晚回包必须被 seq 丢弃，绝不能创建第 2 个 Blob');
  assert.ok(previewTitle.textContent.includes('fastB.png'), '标题仍然保持 fastB.png');
});

await t('文本预览: 走 readTextPreview 不拉取 8MiB，严格 textContent 截断', async () => {
  const doc = createMockDocument();
  let readTextCalled = false;
  let readFullCalled = false;

  const mockService = {
    list: async () => ({ ok: true, files: [] }),
    readTextPreview: async () => {
      readTextCalled = true;
      return { ok: true, text: 'console.log("hello");', truncated: true, totalBytes: 100000 };
    },
    readFullBytes: async () => {
      readFullCalled = true;
      return { ok: true, bytes: new Uint8Array(0) };
    },
    downloadUrl: () => '/download',
  };

  const view = createWorkspaceView({ service: mockService, document: doc });
  await view.open({ mountId: 'default', agentId: 'a' });

  await view.previewFile('code.js');

  assert.equal(readTextCalled, true, '文本预览必须调用有界 readTextPreview');
  assert.equal(readFullCalled, false, '文本预览不得调用全量 readFullBytes');

  const textNode = doc.body.querySelector('.workspace-preview-text');
  assert.equal(textNode.textContent, 'console.log("hello");');
  assert.equal(textNode.innerHTML, '');
});

await t('文本预览: 宿主 20MiB/413 时引导下载，不假装能截断大文本', async () => {
  const doc = createMockDocument();
  const mockService = {
    list: async () => ({ ok: true, files: [] }),
    readTextPreview: async () => {
      const err = new Error('HTTP 413 Payload Too Large: {"error":"file_too_large"}');
      err.status = 413;
      throw err;
    },
    downloadUrl: () => '/download/huge.txt',
  };

  const view = createWorkspaceView({ service: mockService, document: doc });
  await view.open({ mountId: 'default', agentId: 'a' });
  await view.previewFile('huge.txt');

  const box = doc.body.querySelector('.workspace-preview-unsupported');
  assert.ok(box, '413 应走不支持预览/下载提示');
  assert.ok(box.children[0].textContent.includes('20MiB'));
  assert.ok(box.children[0].textContent.includes('直接下载'));
  assert.equal(box.children[1].getAttribute('href'), '/download/huge.txt');
});

/* ------------------------------------------------------------------ */
/* 10. 返回层级：back() 一次只退一层（预览 -> 面板）                     */
/* ------------------------------------------------------------------ */

function makeNavigableService(overrides = {}) {
  const calls = [];
  const service = {
    async list(ctx, subdir) {
      calls.push({ mountId: ctx.mountId, subdir });
      return {
        ok: true,
        files: [
          { name: 'docs', isDir: true, size: 0 },
          { name: 'readme.txt', isDir: false, size: 12 },
        ],
      };
    },
    async readTextPreview() {
      return { ok: true, text: 'hello', truncated: false };
    },
    downloadUrl: () => '/download',
    ...overrides,
  };
  return { service, calls };
}

await t('back: 预览打开时只关预览，面板/目录/根保持可用', async () => {
  const doc = createMockDocument();
  const { service, calls } = makeNavigableService();
  const view = createWorkspaceView({ service, document: doc });
  view.setRoots([{ mountId: 'default', agentId: 'agent-1', label: 'Agent默认工作区' }]);

  await view.open({ mountId: 'default', agentId: 'agent-1', label: 'Agent默认工作区' });
  await view.previewFile('readme.txt');

  const drawer = doc.body.querySelector('.workspace-drawer');
  const modal = doc.body.querySelector('.workspace-preview-modal');
  assert.equal(modal.hidden, false, '前置：预览已打开');
  assert.equal(drawer.hidden, false, '前置：面板已打开');
  const titleBefore = doc.body.querySelector('.workspace-title').textContent;
  const rootValue = doc.body.querySelector('.workspace-root-select').value;
  assert.equal(calls.length, 1);

  const result = view.back();
  assert.equal(typeof result, 'boolean', 'back 必须同步返回布尔值');
  assert.equal(result, true);
  assert.equal(modal.hidden, true, '第一次返回只关预览');
  assert.equal(drawer.hidden, false, '面板必须仍然打开');
  assert.equal(view.isOpen(), true);
  assert.equal(doc.body.querySelector('.workspace-title').textContent, titleBefore);
  assert.equal(doc.body.querySelector('.workspace-root-select').value, rootValue);
  assert.equal(doc.body.querySelectorAll('.workspace-item').length, 2, '目录列表不能被清空');
  assert.equal(calls.length, 1, '关预览不得重新拉目录');

  // currentSnapshot 仍在：同一 root 下继续导航
  await view.navigateTo('docs');
  assert.deepEqual(calls[calls.length - 1], { mountId: 'default', subdir: 'docs' });
  assert.equal(doc.body.querySelectorAll('.workspace-item').length, 2);
});

await t('back: 第二次返回关面板，第三次返回 false', async () => {
  const doc = createMockDocument();
  const { service } = makeNavigableService();
  const view = createWorkspaceView({ service, document: doc });

  await view.open({ mountId: 'default', agentId: 'agent-1' });
  await view.previewFile('readme.txt');
  const drawer = doc.body.querySelector('.workspace-drawer');
  const modal = doc.body.querySelector('.workspace-preview-modal');

  assert.equal(view.back(), true);
  assert.equal(modal.hidden, true);
  assert.equal(drawer.hidden, false);

  assert.equal(view.back(), true);
  assert.equal(drawer.hidden, true, '第二次返回才关面板');
  assert.equal(modal.hidden, true);
  assert.equal(view.isOpen(), false);

  assert.equal(view.back(), false, '全关后返回必须交还给上层');
  assert.equal(drawer.hidden, true);
});

await t('back: 均未打开时返回 false 且不懒创建 DOM', () => {
  const doc = createMockDocument();
  const view = createWorkspaceView({
    service: { list: async () => ({ ok: true, files: [] }) },
    document: doc,
  });

  assert.equal(doc.body.children.length, 0);
  assert.equal(view.back(), false);
  assert.equal(doc.body.children.length, 0, 'back 全关时不得创建 DOM');
});

await t('close: 预览+面板时仍一次彻底关闭（切会话/退出语义不变）', async () => {
  const doc = createMockDocument();
  const { service } = makeNavigableService();
  const view = createWorkspaceView({ service, document: doc });

  await view.open({ mountId: 'default', agentId: 'agent-1' });
  await view.previewFile('readme.txt');
  const drawer = doc.body.querySelector('.workspace-drawer');
  const modal = doc.body.querySelector('.workspace-preview-modal');
  assert.equal(modal.hidden, false);

  view.close();
  assert.equal(drawer.hidden, true, 'close 必须同时关闭面板');
  assert.equal(modal.hidden, true, 'close 必须同时关闭预览');
  assert.equal(view.isOpen(), false);
  assert.equal(view.back(), false);
});

await t('back 关预览后，迟到预览回包不得复活预览层', async () => {
  const doc = createMockDocument();
  let resolveRead;
  const gate = new Promise((r) => { resolveRead = r; });
  const service = {
    list: async () => ({ ok: true, files: [{ name: 'late.txt', isDir: false, size: 3 }] }),
    readTextPreview: async () => {
      await gate;
      return { ok: true, text: 'LATE', truncated: false };
    },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({ service, document: doc });
  await view.open({ mountId: 'default', agentId: 'a' });

  const pending = view.previewFile('late.txt');
  const modal = doc.body.querySelector('.workspace-preview-modal');
  assert.equal(modal.hidden, false, '前置：预览占位已打开');

  assert.equal(view.back(), true);
  assert.equal(modal.hidden, true);

  resolveRead();
  await pending;
  assert.equal(modal.hidden, true, '迟到预览不得重新打开弹窗');
  assert.equal(doc.body.querySelector('.workspace-preview-text'), null, '迟到预览不得渲染');
});

await t('back 关面板后，迟到列表回包不得复活抽屉', async () => {
  const doc = createMockDocument();
  let resolveList;
  const gate = new Promise((r) => { resolveList = r; });
  let listStarted = false;
  const service = {
    list: async () => {
      listStarted = true;
      await gate;
      return { ok: true, files: [{ name: 'late.txt', isDir: false, size: 3 }] };
    },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({ service, document: doc });

  const opening = view.open({ mountId: 'default', agentId: 'a' });
  await waitFor(() => listStarted, { label: '列表请求已发出' });

  assert.equal(view.back(), true, '预览不在时应关闭面板');
  const drawer = doc.body.querySelector('.workspace-drawer');
  assert.equal(drawer.hidden, true);
  assert.equal(view.isOpen(), false);

  resolveList();
  await opening;
  assert.equal(drawer.hidden, true, '迟到列表不得重新打开抽屉');
  assert.equal(doc.body.querySelectorAll('.workspace-item').length, 0, '迟到列表不得渲染');
});

await t('back: 预览已手动关闭时，下一次返回关面板', async () => {
  const doc = createMockDocument();
  const { service } = makeNavigableService();
  const view = createWorkspaceView({ service, document: doc });

  await view.open({ mountId: 'default', agentId: 'agent-1' });
  await view.previewFile('readme.txt');
  view.closePreview();

  const drawer = doc.body.querySelector('.workspace-drawer');
  const modal = doc.body.querySelector('.workspace-preview-modal');
  assert.equal(modal.hidden, true);
  assert.equal(drawer.hidden, false);

  assert.equal(view.back(), true);
  assert.equal(drawer.hidden, true);
  assert.equal(view.isOpen(), false);
  assert.equal(view.back(), false);
});

await t('back 关预览不影响在途目录请求落地（不废弃 currentSnapshot）', async () => {
  const doc = createMockDocument();
  let resolveSecond;
  const gate = new Promise((r) => { resolveSecond = r; });
  const calls = [];
  const service = {
    async list(ctx, subdir) {
      calls.push(subdir);
      if (calls.length === 2) await gate;
      return { ok: true, files: [{ name: 'doc.txt', isDir: false, size: 1 }] };
    },
    async readTextPreview() {
      return { ok: true, text: 'x', truncated: false };
    },
    downloadUrl: () => '/download',
  };
  const view = createWorkspaceView({ service, document: doc });
  await view.open({ mountId: 'default', agentId: 'a' });

  const navigating = view.navigateTo('docs');
  await waitFor(() => calls.length === 2, { label: '子目录请求已发出' });
  await view.previewFile('doc.txt');
  assert.equal(doc.body.querySelector('.workspace-preview-modal').hidden, false);

  assert.equal(view.back(), true, '先关预览');
  assert.equal(doc.body.querySelector('.workspace-drawer').hidden, false);

  resolveSecond();
  await navigating;
  assert.equal(doc.body.querySelectorAll('.workspace-item').length, 1, '在途目录结果必须仍能落地');
  assert.equal(doc.body.querySelector('.workspace-item-name').textContent, 'doc.txt');
});

if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
