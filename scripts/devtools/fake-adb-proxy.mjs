// fake-adb-proxy —— 假 adb forward 的替身，只给离线自检用。
//
// 真实的 `adb forward tcp:N localabstract:...` 会在本机 N 上开一个监听，转到设备里的套接字。
// 自检里没有设备，于是：fake-adb 收到 forward 就 detached 起这个进程，在 N 上监听、
// 把连接原样转给假 CDP 端点所在的端口——ui-probe 走的还是「转发 → 连本机端口」那条路。
//
// 参数：<监听端口> <上游端口> <就绪标记文件>
// 就绪标记文件是给 fake-adb 用的：等它出现再返回，避免调用方马上连过去砸在「还没 listen」上。
// 最后一个连接断开 600ms 后自己退出，不留常驻进程。

import net from 'node:net';
import { writeFileSync } from 'node:fs';

const port = Number(process.argv[2]);
const upstream = Number(process.argv[3]);
const readyFile = process.argv[4];

if (!Number.isInteger(port) || !Number.isInteger(upstream)) {
  process.stderr.write('fake-adb-proxy: 需要 <监听端口> <上游端口> [就绪标记文件]\n');
  process.exit(2);
}

let active = 0;
let idleTimer = null;

const server = net.createServer((client) => {
  active += 1;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const target = net.connect(upstream, '127.0.0.1');
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    client.destroy();
    target.destroy();
    active -= 1;
    if (active === 0) {
      idleTimer = setTimeout(() => {
        if (active === 0) server.close(() => process.exit(0));
      }, 600);
    }
  };
  client.on('error', finish);
  target.on('error', finish);
  client.on('close', finish);
  target.on('close', finish);
  client.pipe(target);
  target.pipe(client);
});

server.on('error', () => process.exit(1));
server.listen(port, '127.0.0.1', () => {
  if (readyFile) {
    try {
      writeFileSync(readyFile, String(port));
    } catch {
      /* 标记写不出来就让 fake-adb 走到超时分支 */
    }
  }
});

// 兜底：没人来连也别赖着不走
setTimeout(() => process.exit(0), 30000).unref();
