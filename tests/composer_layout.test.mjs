/*
 * Android WebView 聊天输入区视口回归。
 *
 * 设备记录：WebView 可见 bounds 为 [0,107][1080,2252]，其 CSS 可视高度约 817px；
 * 截断按钮只露 19px。旧测试把 Chromium 布局视口和可视边界都设为 817px，
 * 因此没有重现布局视口比 WebView 可视区域高约 41px 的裁切。
 *
 * 此测试在真实 Edge/Chromium 页面中保留 858px CSS 布局视口，模拟 WebView
 * 上报的 innerHeight/VisualViewport 高度 817px，再要求页面主视图按可视高度收缩。
 * 它不证明 Android WebView 的运行时数值；设备 JS 运行时不可由本测试读取。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const dpr = 2.625;
const layoutHeightCss = 858;
const initialVisibleHeightCss = 817;

// 这条要靠真实浏览器 + CDP，CI 里没有稳定环境（也刻意不把它绑在 CI 上）。
if (process.env.HANA_SKIP_BROWSER_TESTS === '1') {
  console.log('SKIP  需要真实浏览器，CI 里跳过（本地跑时不要设 HANA_SKIP_BROWSER_TESTS）');
  process.exit(0);
}
if (!existsSync(edgePath)) {
  console.log(`SKIP  找不到 Edge：${edgePath}`);
  process.exit(0);
}
let bad = 0;

function pass(name) {
  console.log(`PASS  ${name}`);
}

function fail(name, detail) {
  bad += 1;
  console.log(`FAIL  ${name}\n      ${detail}`);
}

async function runBrowserTests() {
  const browser = spawn(edgePath, [
    '--headless=new',
    '--remote-debugging-port=9225',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]);

  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    const pages = await fetch('http://127.0.0.1:9225/json/list').then((r) => r.json());
    const page = pages.find((p) => p.type === 'page') || pages[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve) => { ws.onopen = resolve; });

    let id = 1;
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const curId = id++;
        const handler = (evt) => {
          const data = JSON.parse(evt.data);
          if (data.id !== curId) return;
          ws.removeEventListener('message', handler);
          if (data.error) reject(data.error);
          else resolve(data.result);
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id: curId, method, params }));
      });
    }

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 411,
      height: layoutHeightCss,
      deviceScaleFactor: dpr,
      mobile: true,
    });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const callbacks = new Map();
        const viewport = {
          height: ${initialVisibleHeightCss},
          offsetTop: 0,
          addEventListener(type, callback) {
            const list = callbacks.get(type) || [];
            list.push(callback);
            callbacks.set(type, list);
          },
          removeEventListener(type, callback) {
            callbacks.set(type, (callbacks.get(type) || []).filter((item) => item !== callback));
          },
          resizeTo(height) {
            this.height = height;
            for (const callback of callbacks.get('resize') || []) callback.call(this, new Event('resize'));
          },
        };
        Object.defineProperty(window, 'innerHeight', {
          configurable: true,
          get: () => ${initialVisibleHeightCss},
        });
        Object.defineProperty(window, 'visualViewport', {
          configurable: true,
          value: viewport,
        });
        window.__testViewport = viewport;
      })();`,
    });
    await send('Page.navigate', { url: 'http://127.0.0.1:24000/' });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const inspect = async () => {
      const response = await send('Runtime.evaluate', {
        expression: `(() => {
          for (const id of ['view-login', 'view-list', 'view-chat']) {
            const view = document.getElementById(id);
            if (view) view.hidden = id !== 'view-chat';
          }
          const button = document.getElementById('btnAttach');
          const bounds = button.getBoundingClientRect();
          const visibleTop = window.visualViewport.offsetTop;
          const visibleBottom = visibleTop + window.visualViewport.height;
          const top = Math.max(bounds.top, visibleTop);
          const bottom = Math.min(bounds.bottom, visibleBottom);
          return {
            layoutHeight: document.documentElement.clientHeight,
            innerHeight: window.innerHeight,
            visualHeight: window.visualViewport.height,
            visualTop: visibleTop,
            cssKb: getComputedStyle(document.documentElement).getPropertyValue('--kb').trim(),
            buttonTop: bounds.top,
            buttonBottom: bounds.bottom,
            buttonHeight: bounds.height,
            visibleButtonHeight: Math.max(0, bottom - top) * window.devicePixelRatio,
            visibleBottomPx: visibleBottom * window.devicePixelRatio,
            buttonBottomPx: bounds.bottom * window.devicePixelRatio,
          };
        })()`,
        returnByValue: true,
      });
      return response.result.value;
    };

    const idle = await inspect();
    const fixtureName = '回归夹具保留 858px CSS 布局视口、模拟 817px WebView 可视高度';
    if (idle.layoutHeight === layoutHeightCss && idle.innerHeight === initialVisibleHeightCss && idle.visualHeight === initialVisibleHeightCss) {
      pass(fixtureName);
    } else {
      fail(fixtureName, JSON.stringify(idle));
    }

    const idleName = '未弹键盘时附件按钮完整落在 WebView 可视边界内';
    if (idle.visibleButtonHeight >= 78 && idle.buttonBottomPx <= idle.visibleBottomPx - 30) {
      pass(idleName);
    } else {
      fail(idleName, `可见高度 ${idle.visibleButtonHeight.toFixed(1)}px；按钮 bottom=${idle.buttonBottomPx.toFixed(1)}px，可视 bottom=${idle.visibleBottomPx.toFixed(1)}px；--kb=${idle.cssKb}`);
    }

    await send('Runtime.evaluate', {
      expression: 'window.__testViewport.resizeTo(480)',
      returnByValue: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const keyboard = await inspect();
    const keyboardName = '可视视口缩小到 480px 时输入区按 VisualViewport 高度收缩';
    if (keyboard.visualHeight === 480 && keyboard.visibleButtonHeight >= 78 && keyboard.buttonBottomPx <= keyboard.visibleBottomPx - 30) {
      pass(keyboardName);
    } else {
      fail(keyboardName, `可见高度 ${keyboard.visibleButtonHeight.toFixed(1)}px；按钮 bottom=${keyboard.buttonBottomPx.toFixed(1)}px，可视 bottom=${keyboard.visibleBottomPx.toFixed(1)}px；CSS 布局高=${keyboard.layoutHeight}px，--kb=${keyboard.cssKb}`);
    }

    ws.close();
  } finally {
    browser.kill();
  }

  console.log(`\n${bad === 0 ? 'ALL PASS' : `${bad} TEST(S) FAILED`}`);
  process.exit(bad === 0 ? 0 : 1);
}

runBrowserTests().catch((error) => {
  console.error('测试运行异常:', error);
  process.exit(1);
});
