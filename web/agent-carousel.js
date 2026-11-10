/* web/agent-carousel.js
 *
 * 首页 Agent 横向滑轨 + 陪伴大屏（hero）（D1 第二步：从 app.js 整块迁出）。
 *
 * 职责：
 *   - 滑轨：清空 #agentCarousel，按 agents 建 .agent-pill（.agent-pill-avatar +
 *     .agent-pill-name）；agents 为空时只给 #companionHero 加 no-carousel；
 *   - 选中态：记住建出来的 pill 节点，切 active 时遍历这份清单，不 querySelectorAll、
 *     也不重建 DOM；
 *   - 陪伴大屏：写 #heroAgentAvatar（交给 paintAvatar）、#homeModelName、
 *     #homeWorkspaceName 三个节点；
 *   - 按 id 取头像地址：头像包 → bootstrap 的 agents → 按 id 的兜底地址。
 *
 * 不负责：哪个 Agent 是当前 Agent（宿主状态）、切换后的业务（闲聊频道、角标）。
 * pill 点击只回传 onSelect(agent)，宿主拿它接 selectAgent。
 *
 * 依赖注入：document 建节点，getElement 取节点，paintAvatar / agentAvatarUrl 由宿主
 * 注入（头像的 DOM 细节不在这里复制）。模块不读全局、不 import app。
 *
 * XML/HTML 只走 createElement + className/textContent：这里从不拼 innerHTML 字符串
 * （bugs_regression 有一条 DOM XSS 用例盯着 hero 头像这条路径）。
 */

/** 滑轨里一个 Agent 的展示名：app 里两处（pill 与 hero 兜底）都用这套。 */
function pillNameOf(agent) {
  return agent.name || agent.agentName || '助手';
}

/**
 * 创建首页滑轨 + 陪伴大屏。
 *
 * @param {object} [options]
 * @param {Document} [options.document] DOM 工厂，杜绝全局隐式读取
 * @param {(id: string) => (Element|null|undefined)} [options.getElement] 按 id 取节点（app 传 `$`）
 * @param {(host: Element, opts: object) => void} [options.paintAvatar] 头像渲染（app 传 avatar-view 的）
 * @param {(agent: object|null) => (string|null)} [options.agentAvatarUrl] 单个 Agent 的头像地址
 * @param {(model: any) => string} [options.modelLabel] 模型展示名（空模型返回 ''）
 * @param {string} [options.fallbackModelName] 模型名缺失时的兜底文案
 * @param {string} [options.fallbackWorkspaceName] 工作区名缺失时的兜底文案
 * @param {(agent: object) => void} [options.onSelect] pill 点击回调（宿主传 selectAgent）
 * @param {(id: string) => (string|null)} [options.packedAvatarUrlOf] 头像包命中地址（宿主包 avatarPack.urlFor）
 * @param {() => object[]} [options.agentsOf] 取 bootstrap 的 agents 列表（宿主传 `() => S.agents`）
 * @returns {{
 *   render: (state: {agents?: object[], currentAgent?: object|null, agentName?: string, homeFolder?: string}) => void,
 *   setActive: (agent: object, extra?: {agentName?: string, homeFolder?: string}) => void,
 *   updateHero: (state?: {currentAgent?: object|null, agentName?: string, homeFolder?: string}) => void,
 *   avatarUrlFor: (id: string) => (string|null),
 *   dispose: () => void,
 * }}
 */
export function createAgentCarousel({
  document: doc,
  getElement,
  paintAvatar,
  agentAvatarUrl,
  modelLabel,
  fallbackModelName = 'DeepSeek V4.1',
  fallbackWorkspaceName = '工作区',
  onSelect = () => {},
  packedAvatarUrlOf = () => null,
  agentsOf = () => [],
} = {}) {
  if (!doc) throw new TypeError('createAgentCarousel requires { document }');
  if (typeof getElement !== 'function') throw new TypeError('createAgentCarousel requires { getElement }');
  if (typeof paintAvatar !== 'function') throw new TypeError('createAgentCarousel requires { paintAvatar }');
  if (typeof agentAvatarUrl !== 'function') throw new TypeError('createAgentCarousel requires { agentAvatarUrl }');
  if (typeof modelLabel !== 'function') throw new TypeError('createAgentCarousel requires { modelLabel }');

  /* 建出来的 pill：[{ agent, pill, onClick }]。切 active 只遍历它，不重建、不查询。 */
  let entries = [];

  /*
   * hero 的三份输入（当前 Agent / 主 Agent 名 / 工作区名）。
   * 宿主每次 render / setActive / updateHero 都会喂最新的，这里只负责记住并重画；
   * 记住是为了「updateHeroCompanion() 无参调用」这类补画入口不必再传一遍。
   */
  const hero = { currentAgent: null, agentName: '', homeFolder: '' };

  /* ---------------------------------------------------------------- */
  /* 小工具                                                            */
  /* ---------------------------------------------------------------- */

  /** 把宿主给的 hero 字段并进本地快照：只有显式出现的键才覆盖（undefined 也算显式）。 */
  function mergeHero(next) {
    if (!next || typeof next !== 'object') return;
    if ('currentAgent' in next) hero.currentAgent = next.currentAgent;
    if ('agentName' in next) hero.agentName = next.agentName;
    if ('homeFolder' in next) hero.homeFolder = next.homeFolder;
  }

  /** 清空容器：逐个摘子节点。整段渲染只走 createElement，不拼 innerHTML。 */
  function clearPills(box) {
    for (const child of [...(box.children || [])]) {
      if (typeof box.removeChild === 'function') box.removeChild(child);
    }
  }

  /** 摘掉现有 pill 的 click 监听（重画与 dispose 共用）。 */
  function detachPills() {
    for (const entry of entries) {
      if (typeof entry.pill.removeEventListener === 'function') {
        entry.pill.removeEventListener('click', entry.onClick);
      }
    }
    entries = [];
  }

  /* ---------------------------------------------------------------- */
  /* 陪伴大屏                                                          */
  /* ---------------------------------------------------------------- */

  /** 只写三个节点；节点缺失（旧页面 / 测试夹具）就跳过，别的什么都不碰。 */
  function paintHero() {
    const { currentAgent, agentName, homeFolder } = hero;

    const avatarEl = getElement('heroAgentAvatar');
    if (avatarEl) {
      paintAvatar(avatarEl, {
        url: agentAvatarUrl(currentAgent),
        name: currentAgent?.name || agentName,
        fallback: currentAgent?.name || agentName,
      });
    }

    const modelEl = getElement('homeModelName');
    if (modelEl) {
      modelEl.textContent = modelLabel(currentAgent?.chatModel) || fallbackModelName;
    }

    const wsEl = getElement('homeWorkspaceName');
    if (wsEl) {
      wsEl.textContent = homeFolder || fallbackWorkspaceName;
    }
  }

  /* ---------------------------------------------------------------- */
  /* 滑轨                                                              */
  /* ---------------------------------------------------------------- */

  /** 建一个 pill；active 按当前 Agent 的 id 判断（与 app.js 原实现同口径）。 */
  function buildPill(agent) {
    const isActive = agent.id === hero.currentAgent?.id;

    const pill = doc.createElement('button');
    pill.className = 'agent-pill' + (isActive ? ' active' : '');
    pill.type = 'button';

    const avatarBox = doc.createElement('span');
    avatarBox.className = 'agent-pill-avatar';
    paintAvatar(avatarBox, { url: agentAvatarUrl(agent), name: pillNameOf(agent) });
    pill.appendChild(avatarBox);

    const nameSpan = doc.createElement('span');
    nameSpan.className = 'agent-pill-name';
    nameSpan.textContent = pillNameOf(agent);
    pill.appendChild(nameSpan);

    const onClick = () => onSelect(agent);
    if (typeof pill.addEventListener === 'function') pill.addEventListener('click', onClick);

    const entry = { agent, pill, onClick };
    entries.push(entry);
    return pill;
  }

  /**
   * 整轨重画：清空 → 按 agents 建 pill → 刷新 hero。
   * 没有 agents 时只给 hero 容器加 no-carousel（不加 pill，也不动 hero 内容）。
   */
  function render({ agents = [], currentAgent, agentName, homeFolder } = {}) {
    const box = getElement('agentCarousel');
    if (!box) return;

    const list = Array.isArray(agents) ? agents : [];
    detachPills();
    clearPills(box);
    mergeHero({ currentAgent, agentName, homeFolder });

    if (!list.length) {
      const heroEl = getElement('companionHero');
      if (heroEl && heroEl.classList) heroEl.classList.add('no-carousel');
      return;
    }

    for (const agent of list) box.appendChild(buildPill(agent));
    paintHero();
  }

  /**
   * 切选中态：只切已有 pill 的 active 与 hero，不重建 DOM。
   * extra 让宿主顺手带上新的 agentName / homeFolder（selectAgent 里 S 已经更新过）。
   */
  function setActive(agent, extra = {}) {
    mergeHero({ ...extra, currentAgent: agent });
    for (const entry of entries) {
      if (entry.pill.classList) entry.pill.classList.toggle('active', entry.agent.id === agent?.id);
    }
    paintHero();
  }

  /** hero 的刷新入口：显式字段并进快照后重画（不传参就是按现有快照重画）。 */
  function updateHero(next = {}) {
    mergeHero(next);
    paintHero();
  }

  /* ---------------------------------------------------------------- */
  /* 按 id 取头像                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * id → 头像地址：头像包优先，其次 bootstrap 的 agents，最后按 id 拼地址。
   * 子代理池里的成员（寻迹、Luna 这些）不一定出现在首页那排 Agent 里，
   * 但只要是个真 Agent 就能按 id 取头像；没有头像文件会 404，卡片自己降级成首字。
   */
  function avatarUrlFor(id) {
    if (!id) return null;
    const packed = packedAvatarUrlOf(id);
    if (packed) return packed;
    const agent = (agentsOf() || []).find((a) => a && (a.id === id || a.agentId === id));
    if (agent) return agentAvatarUrl(agent);
    return `/api/agents/${encodeURIComponent(id)}/avatar`;
  }

  /* ---------------------------------------------------------------- */
  /* 销毁                                                              */
  /* ---------------------------------------------------------------- */

  /** 摘掉 pill 上的 click 监听；幂等，摘完再点不会被当成换助手。 */
  function dispose() {
    detachPills();
  }

  return {
    render,
    setActive,
    updateHero,
    avatarUrlFor,
    dispose,
  };
}
