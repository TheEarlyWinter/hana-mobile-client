/* 临时布局探针契约：仅带 ?debug=1 时显示，并报告当前执行脚本与真实布局读数。 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const probeBuild = 'layout-probe-20261102-a';

// 这条是集成测试：它要访问**本机正在跑的真实网关**（127.0.0.1:24000），
// 再用浏览器 CDP 读布局读数。CI 上没有网关，也没必要为它起一个。
async function shouldSkip() {
  if (process.env.HANA_SKIP_BROWSER_TESTS === '1') return '设置 HANA_SKIP_BROWSER_TESTS=1';
  if (!existsSync(edgePath)) return `找不到 Edge：${edgePath}`;
  try {
    const res = await fetch('http://127.0.0.1:24000/', { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return `本机网关返回 ${res.status}`;
    return null;
  } catch {
    return '本机网关没在跑（127.0.0.1:24000）';
  }
}

const skipReason = await shouldSkip();
if (skipReason) {
  console.log(`SKIP  需要本机网关 + 真实浏览器：${skipReason}`);
  process.exit(0);
}

async function main() {
  const browser = spawn(edgePath, [
    '--headless=new',
    '--remote-debugging-port=9226',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]);

  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    const pages = await fetch('http://127.0.0.1:9226/json/list').then((response) => response.json());
    const page = pages.find((item) => item.type === 'page') || pages[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve) => { ws.onopen = resolve; });

    let id = 1;
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const currentId = id++;
        const listener = (event) => {
          const data = JSON.parse(event.data);
          if (data.id !== currentId) return;
          ws.removeEventListener('message', listener);
          if (data.error) reject(data.error);
          else resolve(data.result);
        };
        ws.addEventListener('message', listener);
        ws.send(JSON.stringify({ id: currentId, method, params }));
      });
    }

    await send('Page.enable');
    async function navigate(url) {
      await send('Page.navigate', { url });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const response = await send('Runtime.evaluate', {
        expression: `(() => {
          const panel = document.getElementById('layoutDebugProbe');
          return {
            panelText: panel?.textContent || '',
            probe: window.__hanaLayoutProbe || null,
          };
        })()`,
        returnByValue: true,
      });
      return response.result.value;
    }

    const ordinary = await navigate('http://127.0.0.1:24000/');
    assert.equal(ordinary.panelText, '', '布局诊断面板不得在普通页面出现');
    assert.equal(ordinary.probe, null, '普通页面不得暴露诊断对象');

    await navigate('http://127.0.0.1:24000/?debug=1');
    await send('Runtime.evaluate', {
      expression: `(() => {
        for (const id of ['view-login', 'view-list', 'view-chat']) {
          const view = document.getElementById(id);
          if (view) view.hidden = id !== 'view-chat';
        }
      })()`,
      returnByValue: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const debug = await send('Runtime.evaluate', {
      expression: `(() => ({
        panelText: document.getElementById('layoutDebugProbe')?.textContent || '',
        probe: window.__hanaLayoutProbe || null,
      }))()`,
      returnByValue: true,
    }).then((response) => response.result.value);
    assert.ok(debug.panelText.includes(probeBuild), '面板必须显示本次探针构建标记');
    assert.ok(debug.probe, 'debug 参数下必须导出当前几何读数');
    // 打包后入口是 /dist/app.<hash>.js，未打包是 /app.js，两种都算对。
  assert.match(debug.probe.moduleUrl, /\/app(\.[0-9a-f]{8})?\.js$/, '必须报告实际执行的 app 入口 URL');
    assert.ok(Number.isFinite(debug.probe.innerHeight), '必须报告 window.innerHeight');
    assert.ok(Number.isFinite(debug.probe.documentClientHeight), '必须报告 documentElement.clientHeight');
    assert.ok(debug.probe.visualViewport, '必须报告 VisualViewport 高度与偏移');
    assert.ok(debug.probe.viewChatRect && debug.probe.btnAttachRect, '必须报告聊天视图和附件按钮矩形');
    assert.ok(debug.probe.btnAttachRect.height > 0, '聊天视图显示后附件按钮矩形必须非零');
    assert.ok(debug.panelText.includes('VisualViewport') && debug.panelText.includes('btnAttach'), '面板文字必须包含可人工读取的视口和按钮数据');

    ws.close();
    console.log('PASS  普通页面不注入布局诊断面板或全局读数');
    console.log('PASS  ?debug=1 显示构建标记、脚本 URL 与布局几何读数');
    console.log('\nALL PASS');
  } finally {
    browser.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
