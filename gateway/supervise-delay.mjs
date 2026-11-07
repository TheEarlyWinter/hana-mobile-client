/* 守护重启退避计算（gateway/supervise.cmd 调用）。
 *
 * 为什么单独一个文件：cmd 里做时间算术既难写又会随区域设置漂移，
 * 把“这次跑了多久 + 下次等多久”拆成纯函数后可以直接测。
 *
 * 规则：
 *   连续崩溃（上次跑不满 30 秒）→ 2 / 4 / 8 / 16 / 32 / 60 秒 指数退避；
 *   跑满 30 秒以上 → 视为成功启动，计数归零，回到 2 秒。
 * 计数写在 --state 指向的文件里，进程重启也不会丢。
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BASE_DELAY_SECONDS = 2;
export const MAX_DELAY_SECONDS = 60;
export const RESET_AFTER_SECONDS = 30;

/**
 * 解析 cmd 的 %TIME%：`14:07:33.45`、` 9:07:33,45`（小数分隔符随区域设置）。
 * 解析不了返回 null —— 12 小时制带 AM/PM 的机器会走到这里。
 */
export function parseClock(text) {
  const match = String(text ?? '')
    .trim()
    .match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!match) return null;
  const [, h, m, s, frac] = match;
  const hours = Number(h);
  const minutes = Number(m);
  const seconds = Number(s);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const fraction = frac ? Number(`0.${frac.padEnd(3, '0')}`) : 0;
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

/** 两次 %TIME% 的间隔秒数；跨午夜按 +24h 处理；解析不了返回 null。 */
export function elapsedSeconds(startText, endText) {
  const start = parseClock(startText);
  const end = parseClock(endText);
  if (start === null || end === null) return null;
  const delta = end - start;
  return delta < 0 ? delta + 86_400 : delta;
}

/**
 * 下一次重启前等多久（秒）。
 * runSeconds 为 null（时间读不出来）时按“快速失败”处理：宁可多等，也不要在崩溃循环里疯转。
 */
export function nextDelay({ streak = 0, runSeconds = 0 } = {}) {
  const ran = Number(runSeconds);
  if (Number.isFinite(ran) && ran >= RESET_AFTER_SECONDS) {
    return { delaySeconds: BASE_DELAY_SECONDS, streak: 0 };
  }
  const previous = Math.max(0, Math.floor(Number(streak) || 0));
  const next = previous + 1;
  const delaySeconds = Math.min(BASE_DELAY_SECONDS * 2 ** Math.min(next - 1, 5), MAX_DELAY_SECONDS);
  return { delaySeconds, streak: next };
}

function readStreak(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const streak = Number(parsed?.streak);
    return Number.isFinite(streak) && streak >= 0 ? Math.floor(streak) : 0;
  } catch {
    return 0;
  }
}

function writeFileSafe(file, text) {
  if (!file) return;
  try {
    fs.writeFileSync(file, text);
  } catch {
    // 写不了就退化成默认值，守护不能因为记账失败停摆
  }
}

/**
 * CLI：`node gateway/supervise-delay.mjs --start "<%TIME%>" --end "<%TIME%>"
 *        [--state <文件>] [--out <文件>]`
 * 输出两行 `DELAY=<秒>` / `STREAK=<次数>`（同时写进 --out，给 cmd 用 for /f 读）。
 */
export function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length - 1; i += 1) {
    const key = argv[i];
    if (typeof key === 'string' && key.startsWith('--')) args.set(key.slice(2), argv[i + 1]);
  }

  const stateFile = args.get('state') || '';
  const outFile = args.get('out') || '';
  const streak = readStreak(stateFile);
  const runSeconds = elapsedSeconds(args.get('start'), args.get('end'));
  const { delaySeconds, streak: nextStreak } = nextDelay({ streak, runSeconds });

  writeFileSafe(stateFile, `${JSON.stringify({ streak: nextStreak, runSeconds })}\n`);
  const lines = `DELAY=${delaySeconds}\nSTREAK=${nextStreak}\n`;
  writeFileSafe(outFile, lines);
  process.stdout.write(lines);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
