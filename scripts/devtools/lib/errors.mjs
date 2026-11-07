// 统一的错误类型：message 是「出了什么事」，hint 是「下一步怎么办」。
//
// 两个命令行工具都只往外抛这一种错误，入口处统一渲染成中文两行，
// 原始 stderr 塞在 details 里（只有 --verbose 才打印），避免把栈直接糊到用户脸上。

export class DevtoolsError extends Error {
  constructor(message, hint = '', details = '') {
    super(message);
    this.name = 'DevtoolsError';
    this.hint = hint;
    this.details = details;
  }
}

/** 把任意 thrown 收敛成 DevtoolsError；已经是的就原样返回。 */
export function asDevtoolsError(err, fallbackMessage) {
  if (err instanceof DevtoolsError) return err;
  const message = err && err.message ? err.message : String(err);
  return new DevtoolsError(fallbackMessage || '出错了', '', message);
}

/** 入口统一渲染：错误、提示、可选细节。 */
export function renderError(err, { verbose = false } = {}) {
  const e = asDevtoolsError(err);
  const lines = [`错误：${e.message}`];
  if (e.hint) lines.push(`  → ${e.hint}`);
  if (verbose && e.details) lines.push(`  细节：${e.details}`);
  return lines.join('\n');
}
