/*
 * web/types/globals.d.ts — 项目自己往 window / globalThis 上挂的东西，只在这里声明。
 *
 * 为什么需要：web/ 下的模块会写 `window.HanaMobile`（Android 壳用 evaluateJavascript 调的
 * 唯一入口）、`window.__hana` / `__hanaDebug` / `__hanaLayoutProbe`（调试与布局探针出口）、
 * `globalThis.pdfjsWorker`（pdf.js 主线程 worker 的约定挂点）。这些名字不在 lib.dom 里，
 * 不声明就会变成成百上千条无关的 TS2339 / TS2580，把真正的接口错配淹掉。
 *
 * 规矩：
 *  - 只声明「别人读得到」的形状，值仍然由各自的模块负责，这里不做运行时兜底；
 *  - 能写清楚的最小形状就写清楚（HanaMobile / __hanaDebug），纯调试袋子才用 any；
 *  - 新增全局挂点必须先在这里登记，否则 typecheck 会报错——这是故意的。
 */

/** Android 壳只认这一个入口，返回 true 表示「这次返回被页面消费了」。 */
interface HanaMobileBridge {
  back(): boolean | void;
}

/** app.js 在 DEBUG 下挂的调试出口；形状跟着 createDebugHooks 的实现走。 */
interface HanaDebugHooks {
  state(): {
    sessionId: string | null;
    sessionPath: string | null;
    wsReady: boolean;
    agent: string | null;
  };
  events(): string[];
  resumes(): number;
  clear(): void;
}

/** 布局探针快照（mobile-lifecycle.js 的 installLayoutProbe 写入）。 */
type HanaLayoutProbeMetrics = Record<string, unknown>;

interface Window {
  /** Android 壳的稳定入口；页面启动后由 app.js 冻结赋值。 */
  HanaMobile: HanaMobileBridge;
  /** DEBUG 下的手工调试袋子：内容多且只在开发时用，不逐个声明。 */
  __hana?: Record<string, any>;
  __hanaDebug?: HanaDebugHooks;
  __hanaLayoutProbe?: HanaLayoutProbeMetrics;
}

/** pdf.js 的 PDFWorker._mainThreadWorkerMessageHandler 只认这个全局。 */
declare var pdfjsWorker: { WorkerMessageHandler: any } | undefined;
