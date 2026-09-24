// DOM 与 SVG 小工具。避免在每个视图里重复造轮子。

type AttrValue = string | number | boolean | EventListener | undefined;
type Child = Node | string | null | undefined | Child[];

function appendChildren(node: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined) continue;
    if (Array.isArray(c)) appendChildren(node, c);
    else node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
}

function applyAttrs(node: Element, attrs: Record<string, AttrValue>): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    // class 一律走 setAttribute：SVG 元素的 className 是只读的 SVGAnimatedString
    if (k === "class") node.setAttribute("class", String(v));
    else if (k === "text") node.textContent = String(v);
    else if (k === "html") node.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else node.setAttribute(k, String(v));
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 受控的样式表，用于按数据驱动生成颜色 */
export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: number | undefined;
  return ((...args: never[]) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  }) as T;
}

/** 稳定的字符串哈希，用于给模块分配颜色 */
export function hashColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 62% 58%)`;
}

/** 可拖拽平移与滚轮缩放的容器 */
export interface PanZoom {
  node: SVGSVGElement;
  /** 当前视图变换，视图可读取以做坐标换算 */
  transform(): { x: number; y: number; k: number };
  fit(bounds: { x: number; y: number; w: number; h: number }): void;
  centerOn(x: number, y: number): void;
  setTransform(x: number, y: number, k: number): void;
}

export function makePanZoom(width: number, height: number): PanZoom {
  const root = svg("svg", {
    width: "100%",
    height: "100%",
    viewBox: `0 0 ${width} ${height}`,
    class: "canvas",
  });
  const layer = svg("g", { class: "panzoom-layer" });
  root.append(layer);
  let x = 0;
  let y = 0;
  let k = 1;
  const apply = () => layer.setAttribute("transform", `translate(${x} ${y}) scale(${k})`);
  apply();

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  root.addEventListener("pointerdown", (e) => {
    if ((e.target as Element).closest(".node")) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    root.setPointerCapture(e.pointerId);
  });
  root.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    x += e.clientX - lastX;
    y += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    apply();
  });
  const stop = () => {
    dragging = false;
  };
  root.addEventListener("pointerup", stop);
  root.addEventListener("pointercancel", stop);
  root.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * width;
      const py = ((e.clientY - rect.top) / rect.height) * height;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nk = Math.min(4, Math.max(0.15, k * factor));
      // 以光标位置为不动点缩放
      x = px - ((px - x) * nk) / k;
      y = py - ((py - y) * nk) / k;
      k = nk;
      apply();
    },
    { passive: false },
  );

  return {
    node: root,
    transform: () => ({ x, y, k }),
    setTransform(nx, ny, nk) {
      x = nx;
      y = ny;
      k = nk;
      apply();
    },
    fit(bounds) {
      const pad = 24;
      const kk = Math.min((width - pad * 2) / bounds.w, (height - pad * 2) / bounds.h, 1.6);
      k = Math.max(0.15, kk);
      x = (width - bounds.w * k) / 2 - bounds.x * k;
      y = (height - bounds.h * k) / 2 - bounds.y * k;
      apply();
    },
    centerOn(cx, cy) {
      x = width / 2 - cx * k;
      y = height / 2 - cy * k;
      apply();
    },
  };
}

/** 把 SVG 内容挂到平移缩放层上，返回清空函数 */
export function contentLayer(pz: PanZoom, width: number, height: number): SVGGElement {
  const g = svg("g");
  pz.node.querySelector(".panzoom-layer")?.append(g);
  void width;
  void height;
  return g;
}
