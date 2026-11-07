/* Hana 宿主闲聊表情选择面板。数据由调用方注入，本模块不访问网络。 */

const EMPTY_COPY = '还没有表情包。可以在桌面端的闲聊设置里导入。';

function makeImage(doc, sticker, className) {
  const image = doc.createElement('img');
  image.className = className;
  const note = sticker?.note == null ? '' : String(sticker.note);
  image.setAttribute('alt', note || '表情');
  image.setAttribute('loading', 'lazy');
  if (note) {
    image.setAttribute('title', note);
    image.setAttribute('aria-label', note);
  }
  if (typeof sticker?.url === 'string' && sticker.url) {
    image.setAttribute('src', sticker.url);
  }
  return image;
}

/** 渲染闲聊消息中的表情图片。 */
export function renderStickerItem(doc, item) {
  if (!item || item.kind !== 'sticker') return null;
  return makeImage(doc, item, 'casual-sticker');
}

/** 渲染表情面板里的缩略图。 */
export function renderStickerThumb(doc, sticker) {
  return makeImage(doc, sticker, 'casual-sticker-thumb');
}

/** 创建表情选择抽屉。loadPacks 由宿主注入；本模块不发请求。 */
export function createStickerPanel({ document: doc, loadPacks, onPick, onClose } = {}) {
  const getPacks = typeof loadPacks === 'function' ? loadPacks : async () => [];
  const pick = typeof onPick === 'function' ? onPick : () => {};
  const closeCallback = typeof onClose === 'function' ? onClose : () => {};

  let packs = [];
  let selectedPackId = null;
  let state = 'idle';
  let opened = false;
  let destroyed = false;
  let loaded = false;
  let requestId = 0;
  let requestPromise = null;

  const overlay = doc.createElement('div');
  overlay.className = 'casual-sticker-overlay';
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');

  const mask = doc.createElement('button');
  mask.className = 'casual-sticker-mask';
  mask.type = 'button';
  mask.setAttribute('aria-label', '关闭表情面板');
  mask.addEventListener('click', close);

  const panel = doc.createElement('section');
  panel.className = 'casual-sticker-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', '选择表情');
  panel.addEventListener('click', (event) => event.stopPropagation());

  const header = doc.createElement('div');
  header.className = 'casual-sticker-header';
  const heading = doc.createElement('h2');
  heading.className = 'casual-sticker-title';
  heading.textContent = '选择表情';
  const closeButton = doc.createElement('button');
  closeButton.className = 'casual-sticker-close';
  closeButton.type = 'button';
  closeButton.textContent = '关闭';
  closeButton.setAttribute('aria-label', '关闭表情面板');
  closeButton.addEventListener('click', close);
  header.appendChild(heading);
  header.appendChild(closeButton);

  const packBar = doc.createElement('div');
  packBar.className = 'casual-sticker-packs';
  packBar.setAttribute('role', 'tablist');
  packBar.setAttribute('aria-label', '表情包');

  const content = doc.createElement('div');
  content.className = 'casual-sticker-content';
  content.setAttribute('aria-live', 'polite');

  panel.appendChild(header);
  panel.appendChild(packBar);
  panel.appendChild(content);
  overlay.appendChild(mask);
  overlay.appendChild(panel);

  // 建实例时不往 body 上挂：有些测试/宿主只给了最小 document，没有 body。
  // 真正常驻时机是第一次 open()，那时页面一定已经在。
  function mount() {
    if (overlay.parentNode) return true;
    const host = doc.body;
    if (!host || typeof host.appendChild !== 'function') return false;
    host.appendChild(overlay);
    return true;
  }

  function setVisible(isVisible) {
    overlay.hidden = !isVisible;
    overlay.setAttribute('aria-hidden', isVisible ? 'false' : 'true');
  }

  function renderPackBar() {
    packBar.replaceChildren();
    packBar.hidden = packs.length <= 1;
    if (packBar.hidden) return;

    for (const pack of packs) {
      const chip = doc.createElement('button');
      chip.className = 'casual-sticker-pack';
      chip.type = 'button';
      chip.textContent = pack.name || '表情包';
      const active = pack.id === selectedPackId;
      chip.classList.toggle('casual-sticker-pack-active', active);
      chip.setAttribute('role', 'tab');
      chip.setAttribute('aria-selected', active ? 'true' : 'false');
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
      chip.addEventListener('click', () => {
        selectedPackId = pack.id;
        render();
      });
      packBar.appendChild(chip);
    }
  }

  function renderEmpty() {
    const empty = doc.createElement('div');
    empty.className = 'casual-sticker-empty';
    const message = doc.createElement('p');
    message.textContent = EMPTY_COPY;
    const reloadButton = doc.createElement('button');
    reloadButton.className = 'casual-sticker-reload';
    reloadButton.type = 'button';
    reloadButton.textContent = '重新加载';
    reloadButton.addEventListener('click', () => { reload(); });
    empty.appendChild(message);
    empty.appendChild(reloadButton);
    content.appendChild(empty);
  }

  function render() {
    renderPackBar();
    content.replaceChildren();

    if (state === 'loading') {
      const status = doc.createElement('p');
      status.className = 'casual-sticker-status';
      status.setAttribute('role', 'status');
      status.textContent = '加载中…';
      content.appendChild(status);
      return;
    }

    if (state === 'error') {
      const error = doc.createElement('div');
      error.className = 'casual-sticker-error';
      const message = doc.createElement('p');
      message.textContent = '表情包加载失败，请重试。';
      const retryButton = doc.createElement('button');
      retryButton.className = 'casual-sticker-retry';
      retryButton.type = 'button';
      retryButton.textContent = '重试';
      retryButton.addEventListener('click', () => { reload(); });
      error.appendChild(message);
      error.appendChild(retryButton);
      content.appendChild(error);
      return;
    }

    if (state !== 'ready') return;
    const pack = packs.find((entry) => entry.id === selectedPackId) || packs[0];
    const stickers = Array.isArray(pack?.stickers) ? pack.stickers : [];
    if (!pack || stickers.length === 0) {
      renderEmpty();
      return;
    }

    const grid = doc.createElement('div');
    grid.className = 'casual-sticker-grid';
    stickers.forEach((sticker, index) => {
      const cell = doc.createElement('button');
      cell.className = 'casual-sticker-cell';
      cell.type = 'button';
      const note = sticker?.note == null ? '' : String(sticker.note);
      cell.setAttribute('aria-label', note || `选择表情 ${index + 1}`);
      cell.appendChild(renderStickerThumb(doc, sticker));
      cell.addEventListener('click', () => {
        try {
          pick({ packId: pack.id, sticker });
        } finally {
          close();
        }
      });
      grid.appendChild(cell);
    });
    content.appendChild(grid);
  }

  function fetchPacks(force) {
    if (destroyed) return Promise.resolve(null);
    if (!force && loaded) return Promise.resolve(packs);
    if (!force && requestPromise) return requestPromise;

    const currentRequest = ++requestId;
    state = 'loading';
    render();
    requestPromise = Promise.resolve()
      .then(() => {
        if (destroyed || currentRequest !== requestId) return null;
        return getPacks();
      })
      .then((result) => {
        if (destroyed || currentRequest !== requestId) return null;
        packs = Array.isArray(result) ? result.filter((entry) => entry && typeof entry === 'object') : [];
        if (!packs.some((entry) => entry.id === selectedPackId)) {
          selectedPackId = packs[0]?.id ?? null;
        }
        loaded = true;
        state = 'ready';
        requestPromise = null;
        render();
        return packs;
      })
      .catch(() => {
        if (destroyed || currentRequest !== requestId) return null;
        loaded = false;
        state = 'error';
        requestPromise = null;
        render();
        return null;
      });
    return requestPromise;
  }

  function open() {
    if (destroyed) return Promise.resolve(null);
    if (!opened) {
      opened = true;
      mount();
      setVisible(true);
      const raf = doc.defaultView?.requestAnimationFrame || globalThis.requestAnimationFrame;
      if (typeof raf === 'function') {
        raf(() => {
          if (opened && !destroyed) panel.classList.add('casual-sticker-open');
        });
      } else {
        panel.classList.add('casual-sticker-open');
      }
    }
    return fetchPacks(false);
  }

  function close() {
    if (!opened) return;
    opened = false;
    panel.classList.remove('casual-sticker-open');
    setVisible(false);
    closeCallback();
  }

  /**
   * 退出登录 / 身份切换：关闭面板并丢弃 pack/选择/加载缓存与在途请求。
   * 复用 requestId 作废旧结果；不销毁面板，也不移除入口，后续 open 可重新加载。
   */
  function reset() {
    if (destroyed) return;
    if (opened) close();
    requestId += 1;
    requestPromise = null;
    packs = [];
    selectedPackId = null;
    loaded = false;
    state = 'idle';
    panel.classList.remove('casual-sticker-open');
    setVisible(false);
    render();
  }

  function reload() {
    return fetchPacks(true);
  }

  function destroy() {
    if (destroyed) return;
    if (opened) close();
    destroyed = true;
    requestId += 1;
    requestPromise = null;
    overlay.remove();
  }

  return { open, close, reset, isOpen: () => opened, destroy, reload };
}
