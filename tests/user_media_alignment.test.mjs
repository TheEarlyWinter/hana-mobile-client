import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 浏览器位置不写死：CI 容器和各人的开发机装的地方不一样，先认 CHROME_PATH，
// 再按 Chrome / Edge 的常见安装路径找。找不到时分两种：CI 有开关就整文件跳过，
// 本机则直接失败——缺浏览器不能静默算通过。
function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

if (process.env.HANA_SKIP_BROWSER_TESTS === '1') {
  console.log('SKIP  因 HANA_SKIP_BROWSER_TESTS 跳过浏览器验收');
  process.exit(0);
}

// 找到的可能是 Chrome 也可能是 Edge，名字不能再叫 edge。
const browserPath = findBrowser();
if (!browserPath) {
  console.error('FAIL  找不到 Chrome/Edge：请设 CHROME_PATH 或把 Chrome/Edge 装到常见安装路径；'
    + 'CI 上要跳过请设 HANA_SKIP_BROWSER_TESTS=1');
  process.exit(1);
}

const webRoot = resolve(fileURLToPath(new URL('../web/', import.meta.url)));
const sharedCardRuntime = resolve(webRoot, '../shared/card-runtime.mjs');
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const failures = [];

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolveListen, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = probe.address();
  await new Promise((resolveClose, reject) => probe.close((err) => err ? reject(err) : resolveClose()));
  return port;
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS  ${name}`);
    return;
  }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}\n      ${detail}`);
}

async function main() {
  // 产物名带内容哈希：页面里写的仍是稳定引用（网关也靠它做注入），
  // 夹具按 dist/manifest.json 映射到真实文件，不去猜文件名，也不在这里重新构建。
  const distManifest = JSON.parse(await readFile(resolve(webRoot, 'dist', 'manifest.json'), 'utf8'));
  const distFile = new Map([
    ['dist/app.js', `dist/${distManifest.js}`],
    ['dist/app.css', `dist/${distManifest.css}`],
  ]);
  const server = createHttpServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (pathname === '/api/web-auth/session') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"authenticated":false}');
      return;
    }
    if (pathname === '/shared/card-runtime.mjs') {
      try {
        const body = await readFile(sharedCardRuntime);
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(body);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('shared card runtime is not present in this checkout');
      }
      return;
    }
    if (pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"error":"fixture endpoint not found"}');
      return;
    }

    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = resolve(webRoot, distFile.get(relative) || relative);
    if (file !== webRoot && !file.startsWith(`${webRoot}${sep}`)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': mimeTypes[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const staticPort = server.address().port;
  const cdpPort = await freePort();
  const browser = spawn(browserPath, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });
  let ws = null;

  try {
    let pages;
    const cdpDeadline = Date.now() + 10000;
    while (Date.now() < cdpDeadline) {
      try {
        pages = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json());
        break;
      } catch {
        await wait(50);
      }
    }
    if (!pages) throw new Error('Edge DevTools endpoint did not start');
    const page = pages.find((item) => item.type === 'page') || pages[0];
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolveOpen, reject) => {
      ws.addEventListener('open', resolveOpen, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket failed to open')), { once: true });
    });

    let nextId = 1;
    function send(method, params = {}) {
      return new Promise((resolveResult, reject) => {
        const id = nextId++;
        const onMessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.id !== id) return;
          ws.removeEventListener('message', onMessage);
          if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
          else resolveResult(message.result);
        };
        ws.addEventListener('message', onMessage);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    async function evaluate(expression) {
      const response = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      }
      return response.result.value;
    }

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await send('Page.navigate', { url: `http://127.0.0.1:${staticPort}/?debug=1` });

    const appDeadline = Date.now() + 12000;
    let ready = false;
    while (Date.now() < appDeadline) {
      try {
        ready = await evaluate(`Boolean(window.__hana?.appendUser && document.querySelector('link[href="/dist/app.css"]')?.sheet)`);
        if (ready) break;
      } catch {}
      await wait(50);
    }
    if (!ready) throw new Error('真实 app 包 / dist/app.css 未在静态 fixture 页面加载完成');

    const setup = await evaluate(`(() => {
      document.getElementById('view-login').hidden = true;
      document.getElementById('view-list').hidden = true;
      document.getElementById('view-chat').hidden = false;
      window.__hana.S.boot = { hasUserAvatar: false };
      return {
        appRenderer: typeof window.__hana.appendUser,
        stylesheet: [...document.styleSheets].find((sheet) => sheet.href?.endsWith('/dist/app.css'))?.href || null,
        viewportWidth: window.innerWidth,
      };
    })()`);
    check('fixture 加载真实 app 渲染函数与打包样式表',
      setup.appRenderer === 'function' && setup.stylesheet === `http://127.0.0.1:${staticPort}/dist/app.css` && setup.viewportWidth === 1440,
      JSON.stringify(setup));

    const svg = (color) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="2880" height="1800"><rect width="2880" height="1800" fill="${color}"/></svg>`)}`;
    async function renderUser(width, height, count, text = '', deviceScaleFactor = width > 600 ? 2 : 1, pointer = 'coarse') {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile: true,
      });
      await send('Emulation.setTouchEmulationEnabled', {
        enabled: pointer === 'coarse',
        maxTouchPoints: pointer === 'coarse' ? 5 : 1,
      });
      await send('Emulation.setEmulatedMedia', {
        features: [
          { name: 'pointer', value: pointer },
          { name: 'hover', value: pointer === 'coarse' ? 'none' : 'hover' },
        ],
      });
      const fixtures = Array.from({ length: count }, (_, index) => ({
        name: `fixture-${index + 1}.svg`,
        src: svg(['#cf885d', '#668bb1', '#9285ac', '#6f9a7d', '#b78a57'][index % 5]),
      }));
      return evaluate(`(async () => {
        const transcript = document.getElementById('transcript');
        transcript.replaceChildren();
        const turn = window.__hana.appendUser(${JSON.stringify(text)}, ${JSON.stringify(fixtures)}, [], 0);
        const images = [...turn.querySelectorAll('.user-media img')];
        await Promise.all(images.map((image) => image.decode().catch(() => null)));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rect = (node) => {
          const r = node.getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom, height: r.height };
        };
        const media = turn.querySelector('.user-media');
        const avatar = turn.querySelector('.avatar-user');
        const bubble = turn.querySelector('.bubble-user');
        const imageRects = images.map((image) => {
          const bounds = rect(image);
          const style = getComputedStyle(image);
          let paintedRight = bounds.right;
          let objectPosition = '';
          if (style.objectFit === 'contain' && image.naturalWidth && image.naturalHeight) {
            const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
            const paintedWidth = image.naturalWidth * scale;
            const freeX = bounds.width - paintedWidth;
            objectPosition = style.objectPosition;
            const positionX = objectPosition.trim().split(/\\s+/)[0] || '50%';
            let offsetX;
            if (positionX === 'left') offsetX = 0;
            else if (positionX === 'right') offsetX = freeX;
            else if (positionX === 'center') offsetX = freeX / 2;
            else if (positionX.endsWith('%')) offsetX = freeX * Number.parseFloat(positionX) / 100;
            else offsetX = Number.parseFloat(positionX) || 0;
            paintedRight = bounds.left + offsetX + paintedWidth;
          }
          return { ...bounds, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, objectFit: style.objectFit, objectPosition, paintedRight };
        });
        return {
          viewport: window.innerWidth,
          turn: rect(turn),
          main: rect(turn.querySelector('.turn-main')),
          body: rect(turn.querySelector('.turn-body')),
          media: media ? rect(media) : null,
          imageRects,
          avatar: rect(avatar),
          bubble: bubble ? rect(bubble) : null,
          mediaAvatarGap: media ? avatar.getBoundingClientRect().left - media.getBoundingClientRect().right : null,
          imageAvatarGap: imageRects.length ? avatar.getBoundingClientRect().left - Math.max(...imageRects.map((image) => image.paintedRight)) : null,
          bubbleAvatarGap: bubble ? avatar.getBoundingClientRect().left - bubble.getBoundingClientRect().right : null,
          imageCount: images.length,
          mediaClass: media?.className || '',
          tabletQuery: matchMedia('(min-width: 1024px) and (hover: none) and (pointer: coarse)').matches,
          hoverQuery: matchMedia('(hover: none)').matches,
          pointerQuery: matchMedia('(pointer: coarse)').matches,
          gridColumns: media ? getComputedStyle(media).gridTemplateColumns : null,
          gridTrackCount: media ? getComputedStyle(media).gridTemplateColumns.split(' ').length : 0,
        };
      })()`);
    }

    const wideOne = await renderUser(1440, 900, 1);
    check('宽屏纯图片单图右缘贴近用户头像（≤24 CSS px）',
      wideOne.imageAvatarGap >= 0 && wideOne.imageAvatarGap <= 24 && wideOne.gridTrackCount === 1 && wideOne.tabletQuery && wideOne.viewport === 1440,
      JSON.stringify(wideOne));

    const wideText = await renderUser(1440, 900, 0, '文本对齐对照');
    check('宽屏纯文字气泡仍贴近用户头像（对照）',
      wideText.bubbleAvatarGap >= 0 && wideText.bubbleAvatarGap <= 24,
      JSON.stringify(wideText));

    const wideOneWithText = await renderUser(1440, 900, 1, '图文同条对照');
    check('宽屏图文同条的图片也贴近用户头像',
      wideOneWithText.imageAvatarGap >= 0 && wideOneWithText.imageAvatarGap <= 24 && wideOneWithText.gridTrackCount === 1,
      JSON.stringify(wideOneWithText));

    const wideMulti = await renderUser(1440, 900, 3);
    check('宽屏多图网格右缘贴近用户头像（≤24 CSS px）',
      wideMulti.imageAvatarGap >= 0 && wideMulti.imageAvatarGap <= 24 && wideMulti.gridTrackCount === 2 && wideMulti.imageCount === 3,
      JSON.stringify(wideMulti));

    const wideMany = await renderUser(1440, 900, 5);
    check('宽屏五图三列网格右缘贴近用户头像（≤24 CSS px）',
      wideMany.imageAvatarGap >= 0 && wideMany.imageAvatarGap <= 24 && wideMany.gridTrackCount === 3 && wideMany.imageCount === 5,
      JSON.stringify(wideMany));

    const nativeWide = await renderUser(2880, 1800, 1, '', 1);
    check('2880×1800 触屏视口单图右缘贴近用户头像（≤24 CSS px）',
      nativeWide.imageAvatarGap >= 0 && nativeWide.imageAvatarGap <= 24 && nativeWide.gridTrackCount === 1 && nativeWide.tabletQuery && nativeWide.viewport === 2880,
      JSON.stringify(nativeWide));

    const desktop = await renderUser(1440, 900, 1, '', 2, 'fine');
    check('桌面细指针下单图沿用 .one 单列并靠近头像',
      desktop.gridTrackCount === 1 && desktop.imageAvatarGap >= 0 && desktop.imageAvatarGap <= 24 && !desktop.tabletQuery && desktop.viewport === 1440,
      JSON.stringify(desktop));

    const narrow = await renderUser(390, 844, 1);
    check('窄屏单图沿用 .one 单列、靠近头像且不溢出视口',
      narrow.gridTrackCount === 1 && narrow.imageAvatarGap >= 0 && narrow.imageAvatarGap <= 24 && !narrow.tabletQuery && narrow.viewport === 390 && Math.max(...narrow.imageRects.map((image) => image.right)) <= narrow.avatar.left,
      JSON.stringify(narrow));

    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'pointer', value: 'coarse' },
        { name: 'hover', value: 'none' },
      ],
    });
    const assistant = await evaluate(`(async () => {
      const transcript = document.getElementById('transcript');
      transcript.replaceChildren();
      const src = ${JSON.stringify(svg('#668bb1'))};
      const turn = window.__hana.startAssistantTurn();
      window.__hana.addAssistantText('assistant text fixture\\n\\n![assistant image](' + src + ')', turn);
      window.__hana.finishTurn(0);
      const image = turn.querySelector('.md-img');
      image.loading = 'eager';
      await image.decode().catch(() => null);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = (node) => {
        const r = node.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      };
      return {
        turn: rect(turn),
        main: rect(turn.querySelector('.turn-main')),
        text: rect(turn.querySelector('.turn-assistant-text')),
        image: rect(image),
        textStart: turn.querySelector('.turn-assistant-text').textContent.includes('assistant text fixture'),
      };
    })()`);
    check('助手文字与 Markdown 图片继续左对齐',
      assistant.textStart && assistant.image.left >= assistant.text.left - 1 && assistant.image.left < (assistant.main.left + assistant.main.right) / 2,
      JSON.stringify(assistant));

    if (failures.length) process.exitCode = 1;
    else console.log('\nALL PASS');
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    browser.kill();
    await new Promise((resolveClose) => server.close(() => resolveClose()));
  }
}

await main();
