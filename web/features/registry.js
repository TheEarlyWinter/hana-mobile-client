/**
 * 特性注册表。
 *
 * 目的：让 `app.js` 只做装配，不再承载业务。每个功能是一个独立单元，
 * 自己声明名字、自己拿上下文、自己挂 DOM；`app.js` 只负责「按顺序登记」
 * 和「统一启动 / 统一销毁」。
 *
 * 三条约束（也是这个模块存在的理由）：
 *
 * 1. **特性之间不互相 import**。要拿别人的能力，走 `context.expose()` /
 *    `context.require()`，由注册表在启动时按顺序解析。谁依赖谁写在
 *    `dependsOn` 里，启动顺序由注册表算，不靠 import 顺序。
 * 2. **启动失败要能定位**。报错必须带上特性名，否则十几个特性一起启动时
 *    根本不知道是谁炸的。
 * 3. **销毁要干净**。特性可以返回 `dispose`，退出登录 / 换助手时统一收尾，
 *    避免上一个身份的定时器和回调活到下一个身份里。
 */

/** 特性名只允许小写字母、数字和短横线，便于日志与依赖声明。 */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export function createFeatureRegistry(options = {}) {
  const features = new Map(); // name -> feature
  const order = []; // 登记顺序，仅用于报告
  const services = new Map(); // name -> 特性暴露的能力
  const started = []; // 已启动记录，倒序销毁
  const log = typeof options.log === 'function' ? options.log : () => {};

  function assertName(name) {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      throw new TypeError(`特性名不合法：${String(name)}（只允许小写字母、数字、短横线，且以字母开头）`);
    }
  }

  /**
   * 登记一个特性。
   *
   * @param {object} feature
   * @param {string} feature.name 唯一名字
   * @param {string[]} [feature.dependsOn] 依赖的其他特性名
   * @param {(ctx: object) => (void | { dispose?: () => void })} feature.register
   *        启动时调用；返回值里的 dispose 会在销毁时倒序调用。
   */
  function register(feature) {
    if (!feature || typeof feature !== 'object') {
      throw new TypeError('特性必须是一个对象');
    }
    assertName(feature.name);
    if (features.has(feature.name)) {
      throw new Error(`特性重名：${feature.name}`);
    }
    if (typeof feature.register !== 'function') {
      throw new TypeError(`特性 ${feature.name} 缺少 register 函数`);
    }
    if (feature.dependsOn != null) {
      if (!Array.isArray(feature.dependsOn)) {
        throw new TypeError(`特性 ${feature.name} 的 dependsOn 必须是数组`);
      }
      for (const dep of feature.dependsOn) {
        assertName(dep);
      }
    }

    features.set(feature.name, feature);
    order.push(feature.name);
    log('register', feature.name);
    return feature;
  }

  /**
   * 拓扑排序：依赖先启动。
   *
   * 同层内保持登记顺序，保证每次运行结果一致（否则测试会随机红）。
   * 成环或缺依赖都在启动前抛错，而不是跑到一半才发现。
   */
  function resolveOrder() {
    const result = [];
    const state = new Map(); // name -> 'visiting' | 'done'

    function visit(name, trail) {
      if (state.get(name) === 'done') return;
      if (state.get(name) === 'visiting') {
        throw new Error(`特性依赖成环：${[...trail, name].join(' -> ')}`);
      }
      const feature = features.get(name);
      if (!feature) {
        throw new Error(`特性 ${trail[trail.length - 1] || '(根)'} 依赖了未登记的特性：${name}`);
      }
      state.set(name, 'visiting');
      for (const dep of feature.dependsOn || []) {
        visit(dep, [...trail, name]);
      }
      state.set(name, 'done');
      result.push(feature);
    }

    for (const name of order) {
      visit(name, []);
    }
    return result;
  }

  /** 倒序销毁已启动的特性；单个收尾失败只记日志，不拦住其他收尾。 */
  function disposeStarted() {
    for (let i = started.length - 1; i >= 0; i -= 1) {
      const item = started[i];
      if (!item.dispose) continue;
      try {
        item.dispose();
      } catch (err) {
        log('dispose-failed', `${item.name}: ${err && err.message ? err.message : err}`);
      }
    }
    started.length = 0;
  }

  /**
   * 按依赖顺序启动全部特性。
   *
   * @param {object} baseContext 所有特性共享的上下文（状态、DOM 取值器、请求函数等）。
   * @returns {{ order: string[], get: (name: string) => any, dispose: () => void }}
   */
  function start(baseContext = {}) {
    if (started.length) {
      throw new Error('注册表已经启动过，不能重复启动');
    }
    const plan = resolveOrder();

    const context = {
      ...baseContext,
      /** 暴露能力给自己之外的特性的用；重名直接报错，避免静默覆盖。 */
      expose(name, api) {
        if (services.has(name)) {
          throw new Error(`能力重名：${name}`);
        }
        services.set(name, api);
      },
      /** 取用别人暴露的能力；没登记就报错，并指出调用方是谁。 */
      require(name) {
        if (!services.has(name)) {
          throw new Error(`能力 ${name} 还不存在（可能依赖声明漏了 dependsOn）`);
        }
        return services.get(name);
      },
      has(name) {
        return services.has(name);
      },
    };

    for (const feature of plan) {
      log('start', feature.name);
      // 这个特性启动前已经有哪些能力：它半路抛错时，只撤掉它自己新加的那些。
      const exposedBefore = new Set(services.keys());
      let handle;
      try {
        handle = feature.register(context);
      } catch (err) {
        // 启动失败不能留下半成品：已经启动的倒序收尾，失败特性已经 expose 的能力也撤掉，
        // 否则下一次 start 会被「已经启动过 / 能力重名」挡住，永远重试不了。
        for (const name of [...services.keys()]) {
          if (!exposedBefore.has(name)) services.delete(name);
        }
        disposeStarted();
        services.clear();
        const wrapped = new Error(`特性 ${feature.name} 启动失败：${err && err.message ? err.message : err}`);
        wrapped.cause = err;
        wrapped.feature = feature.name;
        throw wrapped;
      }
      started.push({
        name: feature.name,
        dispose: handle && typeof handle.dispose === 'function' ? handle.dispose : null,
      });
    }

    return {
      order: plan.map((f) => f.name),
      /** 取特性暴露出来的能力；没有就返回 null，不抛（启动后再取是常见用法）。 */
      get(name) {
        return services.has(name) ? services.get(name) : null;
      },
      dispose() {
        disposeStarted();
        services.clear();
      },
    };
  }

  return {
    register,
    start,
    /** 已登记的名字（按登记顺序），测试与调试用。 */
    names: () => [...order],
    /** 是否登记过某个名字。 */
    has: (name) => features.has(name),
    /** 只算启动顺序，不真的启动；用于测试依赖解析。 */
    plan: () => resolveOrder().map((f) => f.name),
  };
}
