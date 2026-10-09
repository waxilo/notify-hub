// 交互原语：视图层之外的可复用零件（DOM 助手 / 吐司 / 弹层 / 骨架屏 / 复制）
// 只依赖 DOM，不感知业务，也不引用 api.js —— 视图与网络层都跑在它上面。

/* ---------------- DOM 与文本 ---------------- */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 尝试把 JSON 字符串格式化为缩进形式，失败则原样返回
export function prettyJson(s) {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return String(s ?? ''); }
}

export function fmtTime(ms) {
  return ms ? new Date(ms).toLocaleString() : '—';
}

/* ---------------- 复制 ---------------- */
// 优先用异步剪贴板；http:// 与 file:// 属非安全上下文，没有 clipboard API，
// 此时退回 execCommand，否则整站唯一的「复制」入口会在本地调试时静默失效。
export async function copy(text, btn) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { ok = false; }

  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }

  if (btn) {
    const prev = btn.textContent;
    btn.textContent = ok ? '已复制 ✓' : '复制失败';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1200);
  }
  if (!ok) toast('复制失败，请手动选中文本复制', 'err');
  return ok;
}

/* ---------------- 吐司 ---------------- */

const ICON = { info: 'i', ok: '✓', err: '!' };

export function toast(msg, kind = 'info', ms = 2600) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.className = 'toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="ic" aria-hidden="true">${ICON[kind] || 'i'}</span><span class="body"></span>`;
  el.querySelector('.body').textContent = msg;
  box.appendChild(el);

  const kill = () => {
    if (!el.isConnected) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 240);
  };
  const timer = setTimeout(kill, ms);
  el.onclick = () => { clearTimeout(timer); kill(); };
}

/* ---------------- 弹层 ---------------- */
// 支持叠加：确认框需要能开在「发送历史」之上，所以每个弹层是 #modal-root 下
// 一个独立的 .modal-mask，而不是共用一块会被覆盖的容器。
// ESC 只作用于最上面那层；全部关闭后恢复页面滚动。

const modalStack = [];

function modalRoot() {
  let root = document.getElementById('modal-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'modal-root';
    document.body.appendChild(root);
  }
  return root;
}

function syncScrollLock() {
  document.body.style.overflow = modalStack.length ? 'hidden' : '';
}

export function closeModal() {
  const top = modalStack[modalStack.length - 1];
  if (top) top.close(undefined);
}

export function closeAllModals() {
  while (modalStack.length) modalStack[modalStack.length - 1].close(undefined);
}

// openModal(innerHtml, setup) → { root, panel, close }
// root 是遮罩层（内含 .modal），setup 收到同一对象；close(result) 幂等，
// 会摘掉监听与节点再回调 onClose(result) —— 这样 Promise 化的确认框不会重复 resolve。
export function openModal(innerHtml, setup) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal" role="dialog" aria-modal="true" tabindex="-1">${innerHtml}</div>`;
  modalRoot().appendChild(mask);

  const panel = mask.querySelector('.modal');
  const api = { root: mask, panel, mask, onClose: null, close };

  function close(result) {
    const i = modalStack.indexOf(api);
    if (i === -1) return;
    modalStack.splice(i, 1);
    document.removeEventListener('keydown', onKey, true);
    $$('.raw-pop').forEach((p) => p.remove());
    mask.remove();
    syncScrollLock();
    if (api.onClose) { const fn = api.onClose; api.onClose = null; fn(result); }
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (modalStack[modalStack.length - 1] !== api) return;   // 只关最上层
    e.stopPropagation();
    close(undefined);
  }

  document.addEventListener('keydown', onKey, true);
  // 点遮罩关闭（表单弹窗同样适用，「取消」是显式出口）
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(undefined); });
  panel.focus({ preventScroll: true });

  modalStack.push(api);
  syncScrollLock();
  if (setup) setup(api);
  return api;
}

// 二次确认：替换原生 confirm —— 可样式化、可键盘操作、返回 Promise<boolean>
export function confirmDialog({ title, bodyHtml, confirmText = '确认', cancelText = '取消', danger = false }) {
  const m = openModal(`
    <h2>${esc(title)}</h2>
    <p class="hint" style="margin-top:10px">${bodyHtml}</p>
    <div class="modal-actions">
      <button type="button" class="btn ghost" data-cancel>${esc(cancelText)}</button>
      <button type="button" class="btn primary${danger ? ' danger' : ''}" data-ok>${esc(confirmText)}</button>
    </div>`, (api) => {
    api.root.querySelector('[data-cancel]').onclick = () => api.close(false);
    api.root.querySelector('[data-ok]').onclick = () => api.close(true);
  });
  return new Promise((resolve) => { m.onClose = (r) => resolve(r === true); });
}

/* ---------------- 占位形态 ---------------- */

export function skeletonRows(n = 3) {
  return Array.from({ length: n }, () => '<div class="sk sk-row"></div>').join('');
}

export function emptyBox(text, hint = '') {
  return `<div class="empty"><div class="glyph" aria-hidden="true">[ ]</div><p>${esc(text)}</p>${
    hint ? `<p class="hint xs">${esc(hint)}</p>` : ''
  }</div>`;
}
