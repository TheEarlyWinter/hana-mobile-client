// 把「一条命令怎么找到设备的 WebView 调试口」这件事收在一处，ui-probe / js-eval 共用。
//
// 顺序是固定的：设备 → 应用 pid → webview_devtools_remote_<pid> 套接字 → adb forward
// → /json/list → 挑一个 page。每一步失败都给出不同的中文说明，因为它们长得像但原因完全不同。

import { DevtoolsError } from './errors.mjs';
import { ensureForward, findPid, readDevtoolsSockets, removeForward, resolveSerial } from './adb.mjs';
import { isWebViewUserAgent, listTargets, pickTarget } from './cdp.mjs';

/**
 * 拿到可连的 CDP 端点。
 * 返回 { wsUrl, target, serial, pid, forward, socketName }；serial/pid/forward 在 --cdp-url 直连时为 null。
 */
export async function openEndpoint(opts, log = () => {}) {
  if (opts.cdpUrl) {
    const url = opts.cdpUrl.trim();
    if (/^wss?:\/\//i.test(url)) {
      return {
        wsUrl: url,
        target: { url: '(由 --cdp-url 指定)', title: '', type: 'page' },
        serial: null,
        pid: null,
        forward: null,
        socketName: '(直连)',
      };
    }
    if (/^https?:\/\//i.test(url)) {
      const parsed = new URL(url);
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
      const targets = await listTargets(port, { baseUrl: `${parsed.protocol}//${parsed.host}`, timeout: opts.timeout });
      const target = pickTarget(targets, { match: opts.match, log });
      return { wsUrl: target.webSocketDebuggerUrl, target, serial: null, pid: null, forward: null, socketName: '(直连)' };
    }
    throw new DevtoolsError(
      `--cdp-url 只认 ws:// 或 http:// 开头的地址，收到的是「${url}」`,
      '例：--cdp-url ws://127.0.0.1:9222/devtools/page/ABC',
    );
  }

  const serial = await resolveSerial(opts.device);
  const pid = await findPid(serial);
  const socketName = `webview_devtools_remote_${pid}`;

  // 先确认设备上真有这个套接字。没有就是「WebView 调试没开」，这时 adb forward 照样会成功
  // （abstract socket 是延迟连接的），但接上去一定被拒——那种报错会把人带到完全错误的方向。
  // /proc/net/unix 读不到（极少数机型）就跳过这步，交给后面连接时报错。
  const sockets = await readDevtoolsSockets(serial);
  if (sockets.readable && !sockets.names.includes(socketName)) {
    const known = sockets.names.length ? sockets.names.join('、') : '（一个都没有）';
    throw new DevtoolsError(
      `设备上找不到 ${socketName}，WebView 调试没开`,
      '装 debuggable 构建：pwsh android/build.ps1 -Debuggable，然后重装 APK'
        + `；设备上现有的 devtools 套接字：${known}`,
    );
  }

  const forward = await ensureForward(serial, socketName, opts.port);
  log(`转发 ${socketName} → 本机 tcp:${forward.port}${forward.owned ? '' : '（复用已有转发）'}`);

  // 转发已经建好之后才失败（没有页面 / 端口打到别的服务）：自己建的那条要撤掉，
  // 否则 forward 表里会留一条指向已死 pid 的 tcp 端口。复用的转发是别人的，不能动。
  // 撤销本身的错误不能盖掉主错误。
  let targets;
  let target;
  try {
    targets = await listTargets(forward.port, { timeout: opts.timeout });
    target = pickTarget(targets, { match: opts.match, log });
  } catch (err) {
    if (forward.owned) {
      try {
        await removeForward(serial, forward.port);
      } catch {
        // 撤销失败就留着，调用方会在错误文案里看到原始问题
      }
    }
    throw err;
  }

  return { wsUrl: target.webSocketDebuggerUrl, target, serial, pid, forward, socketName };
}

/** 页面 UA 不带 "; wv)" 基本就不是 Android WebView（多半是 Chrome 或别的调试端口）。 */
export function assertWebView(viewport, opts) {
  if (opts.noWebviewCheck) return;
  const ua = String((viewport && viewport.ua) || '');
  if (isWebViewUserAgent(ua)) return;
  throw new DevtoolsError(
    '这个 target 不是 Android WebView（页面 UA 里没有 "; wv)"）',
    `UA 是：${ua.slice(0, 160) || '(空)'}；确认转发的是 webview_devtools_remote_<pid> 而不是别的调试端口。`
      + '确实要连非 WebView 的目标时加 --no-webview-check',
  );
}
