// 调试脚本：使用 Edge Headless 测量聊天页布局尺寸
import http from 'node:http';
import { spawn } from 'node:child_process';

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function main() {
  // 1. 启动 msedge headless，开启 remote debugging port 9223
  const browser = spawn(edgePath, [
    '--headless=new',
    '--remote-debugging-port=9223',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ]);

  await new Promise(r => setTimeout(r, 1000));

  try {
    // 获取 websocket 调试地址
    const versionRes = await fetch('http://127.0.0.1:9223/json/version').then(r => r.json());
    console.log('Browser connected:', versionRes.Browser);

    const pages = await fetch('http://127.0.0.1:9223/json/list').then(r => r.json());
    const page = pages.find(p => p.type === 'page') || pages[0];
    const wsUrl = page.webSocketDebuggerUrl;

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.onopen = resolve);

    let id = 1;
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const curId = id++;
        const handler = (evt) => {
          const data = JSON.parse(evt.data);
          if (data.id === curId) {
            ws.removeEventListener('message', handler);
            if (data.error) reject(data.error);
            else resolve(data.result);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id: curId, method, params }));
      });
    }

    await send('Page.enable');
    await send('Page.navigate', { url: 'http://127.0.0.1:24000/' });
    await new Promise(r => setTimeout(r, 2000));

    await send('Emulation.setDeviceMetricsOverride', {
      width: 411,
      height: 817,
      deviceScaleFactor: 2.625,
      mobile: true,
    });
    await new Promise(r => setTimeout(r, 500));

    // 测试不同安全区和滚动场景
    const evalWithParams = async (desc, prepFn) => {
      await send('Runtime.evaluate', { expression: `(${prepFn.toString()})()` });
      const res = await send('Runtime.evaluate', {
        expression: `(() => {
          const btnAttach = document.getElementById('btnAttach');
          const composer = document.getElementById('composer');
          const transcript = document.getElementById('transcript');
          const chatPage = document.querySelector('.chat-page');
          const chatHead = document.querySelector('.chat-head');
          const r = (el) => {
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return {
              top: Math.round(b.top), bottom: Math.round(b.bottom),
              height: Math.round(b.height),
              physTop: Math.round(b.top * window.devicePixelRatio),
              physBottom: Math.round(b.bottom * window.devicePixelRatio),
              physHeight: Math.round(b.height * window.devicePixelRatio),
            };
          };
          return {
            desc: ${JSON.stringify(desc)},
            scrollY: window.scrollY,
            docScrollTop: document.documentElement.scrollTop,
            bodyScrollTop: document.body.scrollTop,
            chatHead: r(chatHead),
            chatPage: r(chatPage),
            transcript: r(transcript),
            composer: r(composer),
            btnAttach: r(btnAttach),
          };
        })()`,
        returnByValue: true
      });
      console.log(desc, JSON.stringify(res.result.value, null, 2));
    };

    // 场景 A: 原状（空白聊天）
    await evalWithParams('场景A: 初始空白聊天', () => {
      for (const v of ['view-login', 'view-list', 'view-chat']) {
        const el = document.getElementById(v);
        if (el) el.hidden = (v !== 'view-chat');
      }
    });

    // 场景 B: 注入许多长消息（模拟真实聊天）
    await evalWithParams('场景B: 很多聊天消息并触发滚动', () => {
      const t = document.getElementById('transcript');
      t.innerHTML = '';
      for (let i = 0; i < 30; i++) {
        const div = document.createElement('div');
        div.className = 'turn';
        div.innerHTML = `<div class="turn-head"><span class="turn-name">Agent</span></div><div class="turn-main"><div class="bubble">这是第 \${i} 条消息，包含很多文字测试排版和滚动问题，看看是否会撑开容器。</div></div>`;
        t.appendChild(div);
      }
      t.scrollTop = t.scrollHeight;
    });

    // 场景 C: 模拟 Android 13 的 safe-area-inset
    // 在 Android 13 上状态栏高度约 107px (40.76 CSS px)，手势导航条约 148px (56.38 CSS px)
    await evalWithParams('场景C: 设置 CSS 变量模拟 safe-top=41px, safe-bottom=56px', () => {
      document.documentElement.style.setProperty('--safe-top', '40.76px');
      document.documentElement.style.setProperty('--safe-bottom', '56.38px');
    });

    // 场景 D: 仅 safe-top = 40.76px, safe-bottom = 0
    await evalWithParams('场景D: 仅 safe-top=40.76px, safe-bottom=0', () => {
      document.documentElement.style.setProperty('--safe-top', '40.76px');
      document.documentElement.style.setProperty('--safe-bottom', '0px');
    });

    // 场景 H: 修复验证 —— 在 858 视口下，应用 bottom: var(--kb, 0px) 与 --kb=41px
    await evalWithParams('场景H: 修复方案验证 (bottom: var(--kb) + --kb=41px)', () => {
      const v = document.getElementById('view-chat');
      if (v) v.style.bottom = 'var(--kb, 0px)';
      document.documentElement.style.setProperty('--kb', '41px');
    });

    ws.close();
  } finally {
    browser.kill();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
