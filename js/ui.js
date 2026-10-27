/* ============ Мелкие UI-утилиты ============ */

export function fmtTime(sec, withTenths = true) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return withTenths ? `${base}.${Math.floor((sec % 1) * 10)}` : base;
}

let toastsEl = null;
export function toast(msg, { type = '', timeout = 4200, html = false } = {}) {
  if (!toastsEl) {
    toastsEl = document.createElement('div');
    toastsEl.id = 'toasts';
    document.body.appendChild(toastsEl);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  if (html) el.innerHTML = msg; else el.textContent = msg;
  toastsEl.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, timeout);
  return el;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  children.flat().forEach((c) => node.append(c?.nodeType ? c : document.createTextNode(c ?? '')));
  return node;
}
