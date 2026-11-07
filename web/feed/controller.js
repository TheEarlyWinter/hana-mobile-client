/* 日报状态控制器：列表、分页、筛选、条目操作与 feed-changed 合并刷新。
 *
 * 只管理数据与请求代次，不碰 DOM、不直接调用全局 app。请求发出时捕获当前身份和
 * 代次，返回后复核一次；reset 会作废旧请求，迟到结果不能写进新身份。
 *
 * 操作失败保留原状态并把可读错误放进 snapshot.error；阅读信号失败只上抛给
 * read-tracker，由它决定不结算已读。feed-changed 的 onChanged() 返回的 Promise
 * 会等到合并刷新真正完成，供 feature 暂停/恢复阅读计时。
 */

const LANE_ALL = 'all';
const MERGE_ROUNDS_MAX = 5;

/**
 * @typedef {{ code:string, message:string }} FeedUiError
 * @typedef {import('./client.js').FeedItem} FeedItem
 * @typedef {object} FeedSnapshot
 * @property {boolean} open
 * @property {boolean} loading
 * @property {boolean} loadingMore
 * @property {FeedUiError|null} error
 * @property {FeedItem[]} items
 * @property {string|null} cursor
 * @property {string|null} slateId
 * @property {number} unreadTaskCount
 * @property {string|null} nextPatrolAt
 * @property {string} lane
 * @property {string[]} pendingIds
 */

function emptySnapshot() {
  return {
    open: false,
    loading: false,
    loadingMore: false,
    error: null,
    items: [],
    cursor: null,
    slateId: null,
    unreadTaskCount: 0,
    nextPatrolAt: null,
    lane: LANE_ALL,
    pendingIds: [],
  };
}

function toFeedError(err) {
  const code = err && typeof err.code === 'string' && err.code ? err.code : 'feed_error';
  const message =
    err && typeof err.message === 'string' && err.message ? err.message : '日报请求失败';
  return { code, message };
}

/** 稳定比较身份对象：登出/切走后即使内容相同也不再算同一个会话。 */
function identityKey(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeLane(value) {
  return value === 'task' || value === 'content' ? value : LANE_ALL;
}

function laneToLanes(lane) {
  return lane === LANE_ALL ? [] : [lane];
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item.itemId)) continue;
    seen.add(item.itemId);
    out.push(item);
  }
  return out;
}

function shouldReconcileTask(err) {
  if (!err) return false;
  if (err.code === 'feed_task_not_pending') return true;
  return err.status === 404 || err.status === 409 || err.status === 410 || err.status === 422;
}

/**
 * @param {object} options
 * @param {ReturnType<import('./client.js').createFeedClient>} options.client
 * @param {() => object|null} options.getIdentity 当前 principal
 * @param {(snapshot: FeedSnapshot) => void} [options.onChange]
 * @param {(err: Error) => void} [options.onError]
 * @param {number} [options.mergeDelayMs] feed-changed 短窗口，默认 250ms
 * @param {typeof setTimeout} [options.setTimeout]
 * @param {typeof clearTimeout} [options.clearTimeout]
 */
export function createFeedController({
  client,
  getIdentity,
  onChange,
  onError,
  mergeDelayMs = 250,
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  if (!client || typeof client.slate !== 'function') {
    throw new TypeError('createFeedController 需要日报 client');
  }

  let state = emptySnapshot();
  let generation = 0;
  let listToken = 0;
  let firstLoad = null;
  let changedCycle = null;
  let mergeTimer = null;
  const ops = new Map();

  function report(err) {
    if (typeof onError !== 'function') return;
    try {
      onError(err);
    } catch {
      // 回调自身出错不能打断 controller 的收尾。
    }
  }

  function emit() {
    if (typeof onChange !== 'function') return;
    try {
      onChange(snapshot());
    } catch (err) {
      report(err);
    }
  }

  function snapshot() {
    return {
      open: state.open,
      loading: state.loading,
      loadingMore: state.loadingMore,
      error: state.error ? { ...state.error } : null,
      items: state.items.slice(),
      cursor: state.cursor,
      slateId: state.slateId,
      unreadTaskCount: state.unreadTaskCount,
      nextPatrolAt: state.nextPatrolAt,
      lane: state.lane,
      pendingIds: [...ops.keys()],
    };
  }

  function currentIdentity() {
    if (typeof getIdentity !== 'function') return null;
    try {
      return getIdentity();
    } catch (err) {
      report(err);
      return null;
    }
  }

  function capture() {
    return { generation, identity: identityKey(currentIdentity()) };
  }

  function isCurrent(captured) {
    if (captured.generation !== generation) return false;
    return identityKey(currentIdentity()) === captured.identity;
  }

  /** 身份换了但代次没换：清掉加载态，但绝不把旧数据写进新身份。 */
  function settleStale(captured, token) {
    if (token !== listToken || captured.generation !== generation) return;
    if (state.loading || state.loadingMore) {
      state.loading = false;
      state.loadingMore = false;
      emit();
    }
  }

  function loadFirstPage({ dedupe = false } = {}) {
    if (dedupe && firstLoad) return firstLoad.promise;

    const token = (listToken += 1);
    const captured = capture();
    const lanes = laneToLanes(state.lane);
    state.loading = true;
    state.loadingMore = false;
    emit();

    const promise = (async () => {
      try {
        const page = await client.slate({ cursor: null, lanes });
        if (!isCurrent(captured)) {
          settleStale(captured, token);
          return;
        }
        if (token !== listToken) return;
        state.items = dedupeItems(page.items);
        state.cursor = page.cursor;
        state.slateId = page.slateId;
        state.unreadTaskCount = page.unreadTaskCount;
        state.nextPatrolAt = page.nextPatrolAt;
        state.loading = false;
        state.error = null;
        emit();
      } catch (err) {
        if (!isCurrent(captured)) {
          settleStale(captured, token);
          return;
        }
        if (token !== listToken) return;
        state.loading = false;
        state.error = toFeedError(err);
        emit();
        report(err);
      }
    })();

    const record = { promise, token };
    firstLoad = record;
    promise.finally(() => {
      if (firstLoad === record) firstLoad = null;
    });
    return promise;
  }

  function loadMore() {
    if (!state.cursor || state.loading || state.loadingMore) return Promise.resolve(snapshot());

    const token = listToken;
    const captured = capture();
    const cursor = state.cursor;
    const lanes = laneToLanes(state.lane);
    state.loadingMore = true;
    emit();

    const promise = (async () => {
      try {
        const page = await client.slate({ cursor, lanes });
        if (!isCurrent(captured)) {
          settleStale(captured, token);
          return;
        }
        if (token !== listToken) return;
        const existing = new Set(state.items.map((item) => item.itemId));
        const merged = state.items.slice();
        for (const item of dedupeItems(page.items)) {
          if (existing.has(item.itemId)) continue;
          existing.add(item.itemId);
          merged.push(item);
        }
        state.items = merged;
        state.cursor = page.cursor;
        state.slateId = page.slateId;
        state.unreadTaskCount = page.unreadTaskCount;
        state.nextPatrolAt = page.nextPatrolAt;
        state.loadingMore = false;
        state.error = null;
        emit();
      } catch (err) {
        if (!isCurrent(captured)) {
          settleStale(captured, token);
          return;
        }
        if (token !== listToken) return;
        state.loadingMore = false;
        state.error = toFeedError(err);
        emit();
        report(err);
      }
    })();

    return promise;
  }

  function open() {
    if (!state.open) {
      state.open = true;
      emit();
    }
    if (firstLoad) return firstLoad.promise;
    return loadFirstPage({ dedupe: true });
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    emit();
  }

  function refresh() {
    return loadFirstPage({ dedupe: true });
  }

  function setLane(value) {
    const lane = normalizeLane(value);
    if (lane === state.lane) return Promise.resolve(snapshot());
    state.lane = lane;
    state.items = [];
    state.cursor = null;
    state.slateId = null;
    state.nextPatrolAt = null;
    state.error = null;
    state.loadingMore = false;
    emit();
    return loadFirstPage();
  }

  /**
   * 条目操作单飞：同一条目在请求完成前不会再次提交。work 返回一个 apply 闭包，
   * 只有请求成功且归属仍有效时才动状态。
   */
  function runItemOp(itemId, work, { onError } = {}) {
    if (typeof itemId !== 'string' || !itemId) return Promise.resolve();
    const existing = ops.get(itemId);
    if (existing) return existing.promise;

    const captured = capture();
    const op = { promise: null };
    ops.set(itemId, op);
    emit();

    // work 是 async 函数：同步调用能让请求立刻发出，pending 状态也已经在 ops 里。
    let result;
    try {
      result = work(captured);
    } catch (err) {
      result = Promise.reject(err);
    }

    op.promise = Promise.resolve(result)
      .then((apply) => {
        if (!isCurrent(captured)) return;
        if (typeof apply === 'function') apply();
      })
      .catch((err) => {
        if (!isCurrent(captured)) return undefined;
        state.error = toFeedError(err);
        report(err);
        emit();
        if (typeof onError !== 'function') return undefined;
        try {
          return onError(err);
        } catch (inner) {
          report(inner);
          return undefined;
        }
      })
      .finally(() => {
        if (ops.get(itemId) !== op) return;
        ops.delete(itemId);
        if (isCurrent(captured)) emit();
      });

    return op.promise;
  }

  function setFavorite(itemId, value) {
    return runItemOp(itemId, async () => {
      const result = await client.favorite(itemId, value);
      return () => {
        state.items = state.items.map((item) =>
          item.itemId === itemId ? { ...item, favorite: result.favorite } : item,
        );
      };
    });
  }

  function hide(itemId) {
    return runItemOp(itemId, async () => {
      await client.hide(itemId);
      return () => {
        state.items = state.items.filter((item) => item.itemId !== itemId);
      };
    });
  }

  function resolveTask(itemId, actionId) {
    const item = state.items.find((entry) => entry.itemId === itemId);
    if (!item) {
      state.error = { code: 'feed_unknown_item', message: '这条日报已经不在列表里，请刷新后再试' };
      emit();
      return Promise.resolve();
    }
    const task = item.task;
    const action = task ? task.actions.find((entry) => entry.id === actionId) : null;
    if (!action) {
      state.error = { code: 'feed_task_unsupported', message: '这个待办操作已经不可用，请刷新后再试' };
      emit();
      return Promise.resolve();
    }
    // edit 由 view 映射成本地问题编辑；controller 只提交真正会改任务状态的两种。
    if (action.kind !== 'confirm' && action.kind !== 'dismiss') {
      state.error = { code: 'feed_task_unsupported', message: '暂不支持这个待办操作' };
      emit();
      return Promise.resolve();
    }

    return runItemOp(
      itemId,
      async () => {
        const result = await client.task(itemId, actionId);
        return () => {
          state.items = state.items.map((entry) =>
            entry.itemId === itemId ? { ...entry, task: result.task } : entry,
          );
        };
      },
      {
        onError: (err) => (shouldReconcileTask(err) ? loadFirstPage() : undefined),
      },
    );
  }

  async function recordSignals(signals) {
    const captured = capture();
    try {
      const result = await client.signals(signals);
      if (!isCurrent(captured)) return result;
      state.unreadTaskCount = result.unreadTaskCount;
      if (Array.isArray(signals) && result.accepted === signals.length) {
        const readIds = new Set(
          signals
            .filter((signal) => signal && signal.type === 'dwell' && typeof signal.itemId === 'string')
            .map((signal) => signal.itemId),
        );
        if (readIds.size) {
          state.items = state.items.map((item) =>
            readIds.has(item.itemId) && item.unread ? { ...item, unread: false } : item,
          );
        }
      }
      emit();
      return result;
    } catch (err) {
      if (isCurrent(captured)) report(err);
      throw err;
    }
  }

  function onChanged() {
    if (changedCycle) {
      changedCycle.dirty = true;
      return changedCycle.promise;
    }

    const cycle = { dirty: false, promise: null, resolve: null };
    cycle.promise = new Promise((resolve) => {
      cycle.resolve = resolve;
    });
    changedCycle = cycle;

    const run = () => {
      mergeTimer = null;
      const cycleGeneration = generation;
      (async () => {
        let rounds = 0;
        do {
          cycle.dirty = false;
          await loadFirstPage();
          rounds += 1;
        } while (cycle.dirty && cycleGeneration === generation && rounds < MERGE_ROUNDS_MAX);
      })().finally(() => {
        if (changedCycle === cycle) changedCycle = null;
        cycle.resolve();
      });
    };

    if (mergeDelayMs <= 0) run();
    else mergeTimer = setTimeoutFn(run, mergeDelayMs);
    return cycle.promise;
  }

  function reset() {
    generation += 1;
    listToken += 1;
    firstLoad = null;
    ops.clear();
    if (mergeTimer !== null) {
      clearTimeoutFn(mergeTimer);
      mergeTimer = null;
    }
    if (changedCycle) {
      const cycle = changedCycle;
      changedCycle = null;
      cycle.resolve();
    }
    state = emptySnapshot();
    emit();
  }

  return {
    getState: () => snapshot(),
    open,
    close,
    refresh,
    loadMore,
    setLane,
    setFavorite,
    hide,
    resolveTask,
    recordSignals,
    onChanged,
    reset,
  };
}
