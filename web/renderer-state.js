/* 流式渲染状态：chat-renderer 私有那份 state 的初始值。
 *
 * 以前这 14 个字段和 principal/session/ws 那些应用级状态一起挤在 app.js 的 S 上，
 * 于是「一轮消息画到哪儿了」这种纯渲染进度成了全局可见量：事件路由、会话控制、
 * 输入区都能顺手改，谁也说不清谁在写。现在它单独成一份，只在 app.js 装配时创建
 * 一次、交给 createChatRenderer 注入，外部要读要写一律走渲染器的访问器。
 *
 * 纯数据、无逻辑：工厂只负责给每个实例一份互不相干的初值（moodEl 这类必须每次
 * 新对象，单测里两个实例不能共享引用）。
 */
export function createRendererState() {
  return {
    // 当前这一轮（实时流）的 DOM 指针
    turn: null,
    turnBody: null,
    turnFootEl: null,
    turnMeta: null,
    textEl: null,
    // 本轮已经上屏的原始正文：流式重绘与对账比对都以它为准
    streamingRaw: '',
    thinkAt: 0,
    // 历史回放期间为 true：此时 delta 走一次性渲染，不写实时轮的指针
    replaying: false,
    // mood（嘀咕条）容器与已上屏原文
    moodEl: null,
    moodRaw: '',
    // 本轮计时（写到消息尾注里）
    turnStart: 0,
    firstTokenMs: 0,
    charCount: 0,
    speed: 0,
  };
}
