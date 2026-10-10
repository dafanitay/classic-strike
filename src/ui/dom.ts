/** Tiny DOM helpers. Text always goes through textContent (never innerHTML). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

export function button(label: string, cls: string, onClick: () => void, parent?: HTMLElement): HTMLButtonElement {
  const b = el('button', cls, label, parent);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** Segmented control. */
export function segmented<T extends string | number>(
  parent: HTMLElement,
  options: { value: T; label: string; disabled?: boolean; title?: string }[],
  value: T,
  onChange: (v: T) => void,
): void {
  const wrap = el('div', 'seg', undefined, parent);
  const btns: HTMLButtonElement[] = [];
  for (const o of options) {
    const b = button(o.label, o.value === value ? 'on' : '', () => {
      if (o.disabled) return;
      btns.forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      onChange(o.value);
    }, wrap);
    if (o.disabled) b.disabled = true;
    if (o.title) b.title = o.title;
    btns.push(b);
  }
}

export function row(parent: HTMLElement, label: string): HTMLDivElement {
  const r = el('div', 'row', undefined, parent);
  el('label', '', label, r);
  return el('div', '', undefined, r);
}

export function slider(parent: HTMLElement, label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onChange: (v: number) => void): void {
  const r = el('div', 'row', undefined, parent);
  const lab = el('label', '', label, r);
  const right = el('div', '', undefined, r);
  right.style.display = 'grid';
  right.style.gridTemplateColumns = '1fr 54px';
  right.style.gap = '8px';
  const input = el('input', '', undefined, right);
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute('aria-label', label);
  const val = el('span', 'val', fmt(value), right);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = fmt(v);
    onChange(v);
  });
  void lab;
}
