/* web/settings-controller.js
 *
 * 设置面板状态与请求协调控制器。
 *
 * 管什么：
 * 1. 协调模型列表接口（GET /api/models）与思考级别接口（GET /api/session-thinking-level）的数据拉取与状态聚合。
 * 2. 执行模型切换：区分有活跃会话（POST /api/models/switch）与新会话（POST /api/models/set），同步联动更新模型与思考级别。
 * 3. 执行思考级别调整：严格限定于接口返回的 thinkingLevels 可选集合中，向 POST /api/session-thinking-level 发起更新。
 * 4. 协调外观配置（聊天正文字号）：提供标准化档位切换（14px/15px/17px/19px），持久化到 storage，影响 CSS 变量 --chat-message-font-size。
 * 5. 处理请求竞态收敛（后发先至保证只有最新请求生效）、错误兜底与 retry 重试，提供 dispose 销毁以清理生命周期。
 *
 * 不管什么：
 * 1. 不碰任何 DOM，不操作界面元素。
 * 2. 不读取 window、document 或全局状态 S，不直接调用 fetch，所有网络请求经由依赖注入的 request 函数完成。
 * 3. 不编造不存在的主题切换（当前仅一套 warm-paper 主题）。
 */

export const STORAGE_KEY_FONT_SIZE = 'hana-mobile:chat-font-size';
export const DEFAULT_FONT_SIZE = '15px';

export const FONT_SIZE_OPTIONS = Object.freeze([
  { id: 'small', label: '小', value: '14px' },
  { id: 'medium', label: '标准', value: '15px' },
  { id: 'large', label: '大', value: '17px' },
  { id: 'xlarge', label: '特大', value: '19px' },
]);

const VALID_FONT_SIZES = new Set(FONT_SIZE_OPTIONS.map((o) => o.value));

/** 安全的 storage 包装（防降级异常） */
function resolveStorage(customStorage) {
  if (customStorage && typeof customStorage.getItem === 'function') {
    return customStorage;
  }
  if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
    try {
      return window.localStorage;
    } catch {
      // 降级
    }
  }
  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

/**
 * 从模型列表中解析模型引用。
 * 只有能明确确认时才返回结果：同 id 多 provider 无法确认时返回 null，不擅自挑一个。
 *
 * @param {{ id?: string, provider?: string } | string | null} ref
 * @param {Array<object>} models
 * @returns {{ id: string, provider: string|null } | null}
 */
function resolveModelRef(ref, models) {
  if (!ref) return null;
  const list = Array.isArray(models) ? models : [];

  let id = null;
  let provider = null;
  let providerExplicit = false;

  if (typeof ref === 'string') {
    id = ref.trim();
  } else if (typeof ref === 'object') {
    id = typeof ref.id === 'string' ? ref.id.trim() : null;
    if (typeof ref.provider === 'string' && ref.provider) {
      provider = ref.provider;
      providerExplicit = true;
    }
  }
  if (!id) return null;

  // 调用方已给出 id + provider：这是明确引用，直接采用
  if (providerExplicit) return { id, provider };

  const matches = list.filter((m) => m && m.id === id);
  if (matches.length === 0) return null;

  const providers = new Set(matches.map((m) => m.provider || ''));
  if (providers.size > 1) return null; // 同 id 多 provider，无法确认
  return { id, provider: matches[0].provider || null };
}

/**
 * 解析 host 返回的 activeModel（会话真实绑定的模型引用）。
 * id 来自 activeModel 本身；provider 缺失时仅在列表内能唯一确认时才补齐。
 *
 * @param {{ id?: string, provider?: string } | null} activeModel
 * @param {Array<object>} models
 * @returns {{ id: string, provider: string|null } | null}
 */
function resolveActiveModelRef(activeModel, models) {
  if (!activeModel || !activeModel.id) return null;
  const id = activeModel.id;
  if (activeModel.provider) return { id, provider: activeModel.provider };

  const matches = (Array.isArray(models) ? models : []).filter((m) => m && m.id === id);
  const providers = new Set(matches.map((m) => m.provider || ''));
  return {
    id,
    provider: providers.size === 1 ? (matches[0].provider || null) : null,
  };
}

/**
 * 创建设置控制器
 *
 * @param {object} [options]
 * @param {Function} [options.request] 注入的网络请求函数：(pathname: string, init?: object) => Promise<any>
 * @param {object} [options.storage] 存储适配器
 * @param {Function} [options.onStateChange] 状态改变回调：(state) => void
 * @param {string|null} [options.initialSessionPath]
 * @param {string|null} [options.initialAgentId]
 */
export function createSettingsController({
  request,
  storage: customStorage,
  onStateChange = () => {},
  initialSessionPath = null,
  initialAgentId = null,
} = {}) {
  if (typeof request !== 'function') {
    throw new TypeError('createSettingsController 需要传入 request 函数');
  }

  const storage = resolveStorage(customStorage);
  let disposed = false;
  let activeSeq = 0;

  // 写操作代次：新 load / dispose 都会推进代次，使在途写结果失效
  let writeGeneration = 0;
  let pendingSwitch = null;
  let pendingThinking = null;
  let lastFallbackModel = null;

  // 初始读取 storage 中的字号
  let initialFontSize = DEFAULT_FONT_SIZE;
  try {
    const saved = storage.getItem(STORAGE_KEY_FONT_SIZE);
    if (saved && VALID_FONT_SIZES.has(saved)) {
      initialFontSize = saved;
    }
  } catch {
    // 忽略私密模式或存储异常
  }

  const state = {
    status: 'idle', // 'idle' | 'loading' | 'loaded' | 'error'
    error: null,
    sessionPath: initialSessionPath,
    agentId: initialAgentId,

    // 模型数据
    models: [],
    providerDisplayNames: {},
    currentModelId: null,
    currentProvider: null,
    savingModel: false,

    // 思考级别数据
    thinkingLevel: null,
    requestedThinkingLevel: null,
    thinkingLevels: null,
    // 'idle' | 'loading' | 'ready' | 'unsupported' | 'inconsistent' | 'error'
    // 切换模型后必须重拉一次档位，否则会留下「上家的集合 + 这家的值」这种配对错误
    thinkingStatus: 'idle',
    thinkingError: null,
    savingThinkingLevel: false,

    // 外观
    fontSize: initialFontSize,

    // 流式状态
    streaming: false,
  };

  function notify() {
    if (disposed) return;
    try {
      onStateChange({ ...state });
    } catch (err) {
      console.error('[SettingsController] onStateChange 回调异常', err);
    }
  }

  /**
   * 由宿主返回的「集合 + 值」推出界面该表达什么状态。
   *
   * 宿主本身会把非法档位归一化掉，所以 inconsistent 是防御性的：
   * 真出现就说明契约变了，宁可显式报出来，也不要静默当作正常。
   */
  function thinkingStatusFor(levels, level) {
    if (!Array.isArray(levels) || levels.length === 0) return 'unsupported';
    if (level && !levels.includes(level)) return 'inconsistent';
    return 'ready';
  }

  /**
   * 思考级别的查询串：有会话看这个会话，没会话看「待定的新会话」。
   * 跟 load() 用同一套规则，不另立一套。
   */
  function thinkingQuery({ sessionPath, agentId }) {
    const params = new URLSearchParams();
    if (sessionPath) {
      params.set('sessionPath', sessionPath);
    } else {
      params.set('pendingNewSession', '1');
      if (agentId) params.set('agentId', agentId);
    }
    return `/api/session-thinking-level?${params.toString()}`;
  }

  /**
   * 只重拉思考级别，不动模型列表、不重置写代次。
   *
   * 与 load() 分开是有意的：load() 会推进 writeGeneration，
   * 等于顺手把在途的写全部作废，还会把整个面板打进加载态。
   * 这里要的只是「把档位集合换成当前模型的那一套」。
   */
  async function refreshThinking({ sessionPath = state.sessionPath, agentId = state.agentId } = {}) {
    if (disposed) return null;

    const generation = writeGeneration;
    const contextSessionPath = sessionPath;
    const contextAgentId = agentId;

    state.thinkingStatus = 'loading';
    state.thinkingError = null;
    state.thinkingLevels = null;
    state.thinkingLevel = null;
    state.requestedThinkingLevel = null;
    notify();

    try {
      const res = await request(thinkingQuery({ sessionPath: contextSessionPath, agentId: contextAgentId }));
      // 代次或上下文变了（又切了模型、换了会话、登出）：这份结果已经不属于当前界面
      if (disposed || generation !== writeGeneration
        || state.sessionPath !== contextSessionPath
        || state.agentId !== contextAgentId) {
        return null;
      }

      state.thinkingLevel = res?.thinkingLevel || null;
      state.requestedThinkingLevel = res?.requestedThinkingLevel || null;
      state.thinkingLevels = Array.isArray(res?.thinkingLevels) ? res.thinkingLevels : null;
      state.thinkingStatus = thinkingStatusFor(state.thinkingLevels, state.thinkingLevel);
      notify();
      return res;
    } catch (err) {
      if (disposed || generation !== writeGeneration
        || state.sessionPath !== contextSessionPath
        || state.agentId !== contextAgentId) {
        return null;
      }
      // 档位读取失败只影响思考区：模型已经切成功了，不许连带报错或回滚
      state.thinkingLevels = null;
      state.thinkingLevel = null;
      state.requestedThinkingLevel = null;
      state.thinkingStatus = 'error';
      state.thinkingError = (err && err.message) || String(err) || '档位读取失败';
      notify();
      return null;
    }
  }

  /**
   * 加载设置数据（模型列表 + 思考级别）
   *
   * @param {object} [options]
   * @param {string|null} [options.sessionPath]
   * @param {string|null} [options.agentId]
   * @param {boolean} [options.streaming]
   * @param {string|{ id: string, provider?: string }|null} [options.fallbackModel]
   *   目标 Agent 的 chatModel，仅在 activeModel / current 都缺失且能明确解析时采用
   */
  async function load({
    sessionPath = state.sessionPath,
    agentId = state.agentId,
    streaming = state.streaming,
    fallbackModel = null,
  } = {}) {
    if (disposed) return;

    // 新加载建立新上下文：作废在途写，旧写的 finally 不得再改动新状态
    writeGeneration++;
    pendingSwitch = null;
    pendingThinking = null;
    lastFallbackModel = fallbackModel;

    state.sessionPath = sessionPath || null;
    state.agentId = agentId || null;
    state.streaming = Boolean(streaming);
    state.savingModel = false;
    state.savingThinkingLevel = false;
    state.status = 'loading';
    state.error = null;
    const seq = ++activeSeq;
    notify();

    // 1. 构建 models 请求路径
    const modelsParams = new URLSearchParams();
    if (state.sessionPath) modelsParams.set('sessionPath', state.sessionPath);
    if (state.agentId) modelsParams.set('agentId', state.agentId);
    const modelsUrl = `/api/models${modelsParams.toString() ? `?${modelsParams.toString()}` : ''}`;

    // 2. 构建思考级别请求路径
    const thinkingParams = new URLSearchParams();
    if (state.sessionPath) {
      thinkingParams.set('sessionPath', state.sessionPath);
    } else {
      thinkingParams.set('pendingNewSession', '1');
      if (state.agentId) thinkingParams.set('agentId', state.agentId);
    }
    const thinkingUrl = `/api/session-thinking-level?${thinkingParams.toString()}`;

    try {
      const [modelsRes, thinkingRes] = await Promise.all([
        request(modelsUrl),
        request(thinkingUrl),
      ]);

      if (disposed || seq !== activeSeq) return;

      // 解析模型信息
      const rawModels = Array.isArray(modelsRes?.models) ? modelsRes.models : [];
      state.models = rawModels;
      state.providerDisplayNames = modelsRes?.providerDisplayNames || {};

      // 决定当前选中的模型：
      // - 有 sessionPath 时：只认 activeModel（该会话真实绑定的模型）；缺失时仅接受可明确解析的 fallbackModel
      // - 无 sessionPath（新会话）时：只认宿主的 current（新会话会沿用的模型），缺失时才退到 fallbackModel；
      //   不得取桌面端 activeModel、列表首项，也不得用 isCurrent：isCurrent 是宿主的「全局当前」
      //   焦点标记，不代表「新会话会用的模型」，拿它会把别的 Agent 的模型显示成自己的
      // - 任何来源无法明确确认时保持 null，不猜
      let selected = null;
      if (state.sessionPath) {
        selected = resolveActiveModelRef(modelsRes?.activeModel, rawModels)
          || resolveModelRef(fallbackModel, rawModels);
      } else {
        if (modelsRes?.current) {
          selected = resolveModelRef({ id: modelsRes.current }, rawModels);
        }
        if (!selected) selected = resolveModelRef(fallbackModel, rawModels);
      }

      state.currentModelId = selected ? selected.id : null;
      state.currentProvider = selected ? selected.provider || null : null;

      // 解析思考级别信息
      state.thinkingLevel = thinkingRes?.thinkingLevel || null;
      state.requestedThinkingLevel = thinkingRes?.requestedThinkingLevel || null;
      state.thinkingLevels = Array.isArray(thinkingRes?.thinkingLevels)
        ? thinkingRes.thinkingLevels
        : null;
      state.thinkingStatus = thinkingStatusFor(state.thinkingLevels, state.thinkingLevel);
      state.thinkingError = null;

      state.status = 'loaded';
      state.error = null;
      notify();
    } catch (err) {
      if (disposed || seq !== activeSeq) return;
      state.status = 'error';
      state.error = (err && err.message) || String(err) || '加载设置失败';
      notify();
    }
  }

  /**
   * 设置外部流式状态
   *
   * @param {boolean} bool
   */
  function setStreaming(bool) {
    if (disposed) return;
    const next = Boolean(bool);
    if (state.streaming !== next) {
      state.streaming = next;
      notify();
    }
  }

  let sessionModelSeq = 0;
  let currentFetchSessionPath = null;

  /**
   * 独立查询指定会话生效的模型
   *
   * 只返回 activeModel 对应的引用；缺失时返回 null，由 app 用会话所属 Agent 兜底。
   *
   * @param {string} sessionPath 会话路径
   * @returns {Promise<{ modelId: string, provider: string, name: string } | null>}
   */
  async function fetchSessionModel(sessionPath) {
    if (disposed || !sessionPath || typeof sessionPath !== 'string') return null;
    const seq = ++sessionModelSeq;
    currentFetchSessionPath = sessionPath;

    const url = `/api/models?sessionPath=${encodeURIComponent(sessionPath)}`;
    try {
      const res = await request(url);
      if (disposed || seq !== sessionModelSeq || currentFetchSessionPath !== sessionPath) {
        return null;
      }

      const list = Array.isArray(res?.models) ? res.models : [];
      const active = resolveActiveModelRef(res?.activeModel, list);
      if (!active) return null;

      const matched = active.provider
        ? list.find((m) => m && m.id === active.id && m.provider === active.provider)
        : null;
      return {
        modelId: active.id,
        provider: active.provider || '',
        name: matched?.name || res.activeModel.name || active.id,
      };
    } catch {
      if (disposed || seq !== sessionModelSeq || currentFetchSessionPath !== sessionPath) {
        return null;
      }
      return null;
    }
  }

  /**
   * 切换当前模型
   *
   * - 单飞：已有写在途时直接返回 null，不重复发 POST
   * - 代次：新 load / dispose 后，旧写晚到（成功或失败）均返回 null，不回写新上下文
   * - 成功时保留原响应对象；已发出的服务端操作不回滚
   *
   * @param {string} modelId
   * @param {string} provider
   */
  async function switchModel(modelId, provider) {
    if (disposed) return null;
    if (state.streaming) {
      throw new Error('正在生成，结束后再切');
    }
    if (!modelId || !provider) {
      throw new TypeError('switchModel 需要传入非空的 modelId 和 provider');
    }
    // 短暂互斥：思考写还没落地时切模型，两个写会互相覆盖
    if (pendingThinking) {
      throw new Error('正在保存思考级别，稍后再切模型');
    }
    // 单飞：同一时刻只允许一个写操作在途
    if (pendingSwitch) return null;

    const generation = writeGeneration;
    const contextSessionPath = state.sessionPath;
    const contextAgentId = state.agentId;
    pendingSwitch = { generation, modelId, provider };
    state.savingModel = true;
    notify();

    // 写完/失败后先核代次与上下文，避免过期结果污染新会话
    const isStale = () =>
      disposed
      || generation !== writeGeneration
      || state.sessionPath !== contextSessionPath
      || state.agentId !== contextAgentId;

    try {
      let res;
      if (contextSessionPath) {
        res = await request('/api/models/switch', {
          method: 'POST',
          body: JSON.stringify({
            sessionPath: contextSessionPath,
            modelId,
            provider,
          }),
        });
      } else {
        res = await request('/api/models/set', {
          method: 'POST',
          body: JSON.stringify({
            modelId,
            provider,
          }),
        });
      }

      if (isStale()) return null;

      state.currentModelId = modelId;
      state.currentProvider = provider;

      // 模型换了，档位集合也换了。响应里只有新值、没有新集合，
      // 所以这里推进代次作废旧读取，再把档位整块重拉一次。
      // activeSeq 也要推进：load() 的在途响应同样是「切换前的快照」，
      // 只推 writeGeneration 拦不住它把旧集合盖回来。
      writeGeneration++;
      activeSeq++;
      if (res && res.thinkingLevel) {
        state.thinkingLevel = res.thinkingLevel;
      }
      // 重拉失败不影响这次切换的结果：模型已提交，只有思考区进失败态。
      await refreshThinking({ sessionPath: contextSessionPath, agentId: contextAgentId });
      return res;
    } catch (err) {
      // 过期的失败不得冒泡污染新上下文
      if (isStale()) return null;
      throw err;
    } finally {
      // 只有仍属于当前代次的写才能清理 saving 状态；旧写的 finally 不得碰新写
      if (pendingSwitch && pendingSwitch.generation === generation) {
        pendingSwitch = null;
        state.savingModel = false;
        notify();
      }
    }
  }

  /**
   * 设定思考级别（仅允许可用集合内）
   *
   * - 单飞：已有思考写在途时直接返回 null，不重复发 POST；与模型写互不阻塞
   * - 代次：新 load / dispose 后，旧思考写晚到（成功或失败）均返回 null，不回写新上下文
   * - 成功时保留原响应对象；流式生成中仍允许修改
   *
   * @param {string} level
   */
  async function setThinkingLevel(level) {
    if (disposed) return null;

    if (!Array.isArray(state.thinkingLevels) || state.thinkingLevels.includes(level) === false) {
      const validDesc = state.thinkingLevels ? state.thinkingLevels.join(', ') : '无可用级别';
      throw new TypeError(`不支持的思考级别："${level}"。当前可用级别集合为：[${validDesc}]`);
    }
    // 短暂互斥：模型写或档位同步没完成时，不要发一个注定被覆盖的写
    if (pendingSwitch || state.thinkingStatus === 'loading') {
      throw new Error('正在切换模型或读取档位，稍后再设置思考级别');
    }
    // 单飞：思考写独立于模型写，不共用 pendingSwitch
    if (pendingThinking) return null;

    const generation = writeGeneration;
    const contextSessionPath = state.sessionPath;
    const contextAgentId = state.agentId;
    pendingThinking = { generation, level };
    state.savingThinkingLevel = true;
    notify();

    const isStale = () =>
      disposed
      || generation !== writeGeneration
      || state.sessionPath !== contextSessionPath
      || state.agentId !== contextAgentId;

    try {
      const payload = {
        level,
        ...(contextSessionPath ? { sessionPath: contextSessionPath } : {}),
        ...(!contextSessionPath && contextAgentId ? { agentId: contextAgentId } : {}),
      };

      const res = await request('/api/session-thinking-level', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      if (isStale()) return null;

      state.thinkingLevel = res?.thinkingLevel || level;
      if (Array.isArray(res?.thinkingLevels)) {
        state.thinkingLevels = res.thinkingLevels;
      }
      state.requestedThinkingLevel = res?.requestedThinkingLevel || state.requestedThinkingLevel;
      state.thinkingStatus = thinkingStatusFor(state.thinkingLevels, state.thinkingLevel);
      state.thinkingError = null;
      return res;
    } catch (err) {
      // 过期的失败不得冒泡污染新上下文
      if (isStale()) return null;
      throw err;
    } finally {
      // 只有仍属于当前代次的思考写才能清理 saving 状态
      if (pendingThinking && pendingThinking.generation === generation) {
        pendingThinking = null;
        state.savingThinkingLevel = false;
        notify();
      }
    }
  }

  /**
   * 设定外观正文字号
   *
   * @param {string} size
   */
  function setFontSize(size) {
    if (!VALID_FONT_SIZES.has(size)) {
      throw new TypeError(`不支持的字号设置："${size}"。支持的值为：${Array.from(VALID_FONT_SIZES).join(', ')}`);
    }
    state.fontSize = size;
    try {
      storage.setItem(STORAGE_KEY_FONT_SIZE, size);
    } catch {
      // 忽略存储失败
    }
    notify();
  }

  /** 重试上一次的加载 */
  async function retry() {
    return load({
      sessionPath: state.sessionPath,
      agentId: state.agentId,
      fallbackModel: lastFallbackModel,
    });
  }

  /** 只重拉思考级别（档位读取失败、或数据不一致时的重试） */
  async function retryThinking() {
    return refreshThinking({ sessionPath: state.sessionPath, agentId: state.agentId });
  }

  /**
   * 退出登录 / 身份切换后的可复用复位：作废在途 load / write / fetchSessionModel，
   * 清空会话相关状态，但保留字号偏好且不把控制器永久标记为 disposed。
   */
  function reset() {
    if (disposed) return;
    activeSeq++;
    writeGeneration++;
    sessionModelSeq++;
    currentFetchSessionPath = null;
    pendingSwitch = null;
    pendingThinking = null;
    lastFallbackModel = null;

    state.status = 'idle';
    state.error = null;
    state.sessionPath = null;
    state.agentId = null;
    state.models = [];
    state.providerDisplayNames = {};
    state.currentModelId = null;
    state.currentProvider = null;
    state.savingModel = false;
    state.savingThinkingLevel = false;
    state.thinkingLevel = null;
    state.requestedThinkingLevel = null;
    state.thinkingLevels = null;
    state.thinkingStatus = 'idle';
    state.thinkingError = null;
    state.streaming = false;
    notify();
  }

  /** 销毁控制器 */
  function dispose() {
    disposed = true;
    activeSeq++;
    writeGeneration++;
    pendingSwitch = null;
    pendingThinking = null;
    state.savingModel = false;
    state.savingThinkingLevel = false;
  }

  return {
    load,
    retry,
    setStreaming,
    fetchSessionModel,
    switchModel,
    setThinkingLevel,
    retryThinking,
    setFontSize,
    reset,
    getState: () => ({ ...state }),
    isDisposed: () => disposed,
    dispose,
  };
}
