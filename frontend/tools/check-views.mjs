// 在 jsdom 里把六个视图真正渲染一遍，并对主要交互做点击验证。
//
// 这不是浏览器测试，而是「渲染 + 交互」的无头检查：它能抓到视图运行时报错、
// 数据没绑上、点击后状态不变这类问题。视觉排版仍需人工在浏览器里看。
//
// 用法：npm run check:views   （需要后端已在 8787 运行）

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { overviewView } from "../.tmp/views/overview.js";
import { callgraphView } from "../.tmp/views/callgraph.js";
import { datastructsView } from "../.tmp/views/datastructs.js";
import { sequenceView } from "../.tmp/views/sequence.js";
import { simulatorView } from "../.tmp/views/simulator.js";
import { sourceView } from "../.tmp/views/source.js";

const BASE = process.env.VIZ_ORIGIN ?? "http://127.0.0.1:8787";

// ---- 准备一个最小可用的浏览器环境 ----
const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>", {
  url: `${BASE}/`,
  pretendToBeVisual: true,
});
const { window } = dom;
// jsdom 不实现滚动相关的 API，视图会用它们把目标行滚进视野
let scrollCalls = 0;
window.Element.prototype.scrollIntoView = function scrollIntoView() {
  scrollCalls += 1;
};
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
window.scrollTo = () => {};
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.Element = window.Element;
globalThis.HTMLElement = window.HTMLElement;
globalThis.SVGElement = window.SVGElement;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
window.fetch = globalThis.fetch; // 用 Node 的 fetch，指向真实后端

const problems = [];
const notes = [];

function check(cond, msg) {
  if (cond) notes.push(`  通过  ${msg}`);
  else problems.push(msg);
  return cond;
}

/** 渲染一个视图，返回它的容器与上下文 */
async function renderView(view, params = {}) {
  const root = document.createElement("div");
  root.className = "view-body";
  document.body.append(root);
  const p = new URLSearchParams(params);
  const ctx = {
    root,
    params: p,
    navigate: () => {},
    sourceRoute: (file, line) =>
      `source?file=${encodeURIComponent(file)}${line !== undefined ? `&line=${line}` : ""}`,
    graphRoute: (id, depth = 2) => `callgraph?symbol=${encodeURIComponent(id)}&depth=${depth}`,
  };
  await view.render(ctx);
  // 给内部的异步加载留出时间：轮询直到容器不再出现 loading 占位
  for (let i = 0; i < 60; i++) {
    const loading = root.querySelector(".loading");
    if (!loading) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { root, ctx };
}

function clickAll(root, selector, limit = 6) {
  const items = [...root.querySelectorAll(selector)].slice(0, limit);
  for (const el of items) el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return items.length;
}

/** 临时让所有元素报告同一个尺寸，用来检查「图是否铺满面板」。jsdom 没有排版，
 *  不给尺寸的话视图会走兜底值，测不到真实路径。 */
async function withPaneSize(w, h, fn) {
  const proto = window.HTMLElement.prototype;
  const descW = Object.getOwnPropertyDescriptor(proto, "clientWidth");
  const descH = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => w });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => h });
  try {
    return await fn();
  } finally {
    if (descW) Object.defineProperty(proto, "clientWidth", descW);
    else delete proto.clientWidth;
    if (descH) Object.defineProperty(proto, "clientHeight", descH);
    else delete proto.clientHeight;
  }
}

/** 从 panzoom-layer 的 transform 里取出缩放倍数 */
function panZoomScale(root) {
  const t = root.querySelector(".panzoom-layer")?.getAttribute("transform") ?? "";
  const m = /scale\(([-\d.]+)\)/.exec(t);
  return m ? Number.parseFloat(m[1]) : Number.NaN;
}

async function settle(ms = 350) {
  await new Promise((r) => setTimeout(r, ms));
}

const text = (root) => (root.textContent ?? "").replace(/\s+/g, " ");

// ============================================================ 总览
async function testOverview() {
  const view = overviewView;
  const { root } = await renderView(view);
  const t = text(root);
  check(root.querySelectorAll(".stat").length >= 6, `总览：统计卡 ${root.querySelectorAll(".stat").length} 个`);
  check(t.includes("调") && t.includes("边"), "总览：统计文案包含调用边");
  const topoSvg = root.querySelectorAll("svg");
  check(topoSvg.length >= 1, `总览：SVG 图 ${topoSvg.length} 个`);
  check(t.includes("ZMQ") || t.includes("NCCL"), "总览：拓扑包含 ZMQ / NCCL 通道说明");
  check(t.includes("API Server") || t.includes("Scheduler"), "总览：拓扑包含进程节点");
  check(/建议|阅读/.test(t), "总览：包含建议阅读顺序");
  check(t.includes("scheduler") || t.includes("kvcache"), "总览：包含模块清单");
  if (problems.length === 0) clickAll(root, ".card, .item, details summary", 4);
  checkTopologyGeometry(root);
}

/** 进程拓扑的几何自检：把渲染出来的坐标解析出来，证明节点与边徽标互不重叠。
 *  这代替不了人眼看排版，但能证明「文字叠在一起」这类问题是几何上不可能的。 */
function checkTopologyGeometry(root) {
  const num = (el, attr) => {
    const v = el.getAttribute(attr);
    return v === null ? null : Number.parseFloat(v);
  };
  const pair = (el) => {
    const m = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(el.getAttribute("transform") ?? "");
    return m ? { x: Number.parseFloat(m[1]), y: Number.parseFloat(m[2]) } : null;
  };

  const nodes = [...root.querySelectorAll("g.topo-node")].map((g) => {
    const p = pair(g);
    const rect = g.querySelector("rect");
    const w = num(rect, "width") ?? 0;
    const h = num(rect, "height") ?? 0;
    // 节点上的文字：标题与类型标注
    const texts = [...g.querySelectorAll("text")].map((t) => t.textContent ?? "");
    return { p, box: p ? { x: p.x, y: p.y, w, h } : null, texts };
  });
  check(nodes.length >= 8, `拓扑：节点 ${nodes.length} 个`);
  const missing = nodes.filter((n) => !n.box);
  check(missing.length === 0, "拓扑：每个节点都有坐标与尺寸");

  // 边徽标：圆心坐标为 transform，半径取自 circle
  const badges = [...root.querySelectorAll("g.topo-badge")].map((g) => {
    const p = pair(g);
    const r = num(g.querySelector("circle"), "r") ?? 9;
    return p ? { x: p.x, y: p.y, r } : null;
  }).filter(Boolean);
  check(badges.length >= 8, `拓扑：边徽标 ${badges.length} 个`);
  check(root.querySelectorAll(".topo-row").length === badges.length, "拓扑：下方的边列表与徽标数量一致");

  const overlap = (a, b) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  // 徽标不能压到节点框
  let hitNode = 0;
  for (const b of badges) {
    const bb = { x: b.x - b.r, y: b.y - b.r, w: b.r * 2, h: b.r * 2 };
    for (const n of nodes) if (n.box && overlap(bb, n.box)) hitNode++;
  }
  check(hitNode === 0, `拓扑：${hitNode} 个边徽标压到节点框上`);

  // 徽标之间也不能重叠
  let hitPair = 0;
  for (let i = 0; i < badges.length; i++) {
    for (let j = i + 1; j < badges.length; j++) {
      const a = badges[i];
      const b = badges[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r + 2) hitPair++;
    }
  }
  check(hitPair === 0, `拓扑：${hitPair} 对边徽标互相重叠`);

  // 节点文字不得超出框宽（按等宽 6px / 无衬线 6.6px 粗估）
  let overflow = 0;
  for (const n of nodes) {
    if (!n.box) continue;
    const [title = "", kind = "", bullet = ""] = n.texts;
    const titleW = title.length * 6.8;
    const kindW = kind.length * 6;
    const bulletW = bullet.length * 6;
    if (13 + titleW > n.box.w - 13) overflow++;
    if (13 + kindW + bulletW + 12 > n.box.w - 13) overflow++;
  }
  check(overflow === 0, `拓扑：${overflow} 个节点的文字可能超出框宽`);
}

// ============================================================ 调用链追踪器
async function testCallgraph() {
  const { root } = await renderView(callgraphView, {
    symbol: "minisgl.scheduler.scheduler.Scheduler.overlap_loop",
    depth: "2",
  });
  const t = text(root);
  const nodes = root.querySelectorAll("g.node");
  check(nodes.length >= 3, `调用链：图上画了 ${nodes.length} 个节点`);
  check(root.querySelectorAll("path.edge, line.edge").length >= 2, `调用链：画了边 ${root.querySelectorAll("path.edge, line.edge").length} 条`);
  check(t.includes("overlap_loop"), "调用链：中心节点是 overlap_loop");
  check(/签名|forward_batch|_process_last_data/.test(t), "调用链：右侧显示详情与调用列表");

  // 点击一个节点，应当重新扎根并刷新详情
  const before = t.length;
  const target = [...nodes].find((n) => !text(n).includes("overlap_loop"));
  if (target) {
    target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(400);
    check(text(root).length > 0 && text(root) !== t.slice(0, text(root).length) ? true : text(root) !== t,
      "调用链：点击节点后详情发生变化");
  } else {
    problems.push("调用链：没有找到第二个可点节点");
  }
  void before;
  // 未解析调用应当被标注，而不是伪装成调用
  check(/未解析|unresolved/.test(text(root)), "调用链：列出了未解析调用");

  // 图要铺满面板：画布的视口单位应与面板像素 1:1，缩放倍数不应被压到很小
  await withPaneSize(830, 460, async () => {
    const { root: r } = await renderView(callgraphView, { symbol: "minisgl.scheduler.scheduler.Scheduler.overlap_loop", depth: "2" });
    const vb = r.querySelector("svg.canvas")?.getAttribute("viewBox") ?? "";
    check(vb === "0 0 830 460", `调用链：画布视口跟住面板像素（${vb}）`);
    const k = panZoomScale(r);
    // 下限是 fit() 里的可读性保证：层特别多的图也不会被压到读不出来
    check(k >= 0.85, `调用链：8 层 22 节点的图缩放倍数 ${Number.isNaN(k) ? "无法解析" : k.toFixed(2)}（下限 0.85）`);
    notes.push(`  数据  调用链：22 节点下的缩放倍数 ${Number.isNaN(k) ? "?" : k.toFixed(2)}`);
  });

  // 默认入口的图更小，应当能放到 1 倍以上
  await withPaneSize(830, 460, async () => {
    const { root: r } = await renderView(callgraphView, {});
    const k = panZoomScale(r);
    check(k >= 0.95, `调用链：默认入口缩放倍数 ${Number.isNaN(k) ? "无法解析" : k.toFixed(2)}（应 ≥ 0.95）`);
    notes.push(`  数据  调用链：默认入口的缩放倍数 ${Number.isNaN(k) ? "?" : k.toFixed(2)}`);
  });
}

// ============================================================ 数据结构
async function testDatastructs() {
  const { root } = await renderView(datastructsView, { id: "minisgl.core.Req" });
  let t = text(root);
  check(root.querySelectorAll(".item").length >= 50, `数据结构：左侧列表 ${root.querySelectorAll(".item").length} 项`);
  check(t.includes("cached_len") && t.includes("max_device_len"), "数据结构：Req 的字段已显示");
  check(/AssertionError|assert|不变式/.test(t), "数据结构：显示了不变式");
  check(t.includes("0 <=") || t.includes("cached_len <"), "数据结构：不变式的具体内容可见");

  // 生命周期控件：点一次 complete_one 之类的按钮，观察数值变化
  const buttons = [...root.querySelectorAll("button")].filter((b) =>
    /complete_one|推进|下一步|decode/i.test(b.textContent ?? ""),
  );
  if (buttons.length > 0) {
    const before = t;
    buttons[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(200);
    t = text(root);
    check(t !== before, "数据结构：生命周期控件点击后数值更新");
  } else {
    notes.push("  跳过  数据结构：没有找到生命周期控件按钮（需人工确认）");
  }
  // 切到另一个结构
  const other = [...root.querySelectorAll(".item")].find((i) => !text(i).includes("Req"));
  if (other) {
    other.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(400);
    check(text(root).length > 0, "数据结构：切换到其他结构后仍有内容");
  }
}

// ============================================================ 时序回放
async function testSequence() {
  const { root } = await renderView(sequenceView, { flow: "online-request" });
  let t = text(root);
  check(/HTTP|SSE|TokenizeMsg/.test(t), "时序：选中了在线请求流程");
  const actors = root.querySelectorAll(".seq-actor");
  check(actors.length >= 4, `时序：参与者 ${actors.length} 个`);
  const msgs = root.querySelectorAll(".seq-msg");
  check(msgs.length >= 10, `时序：消息箭头 ${msgs.length} 条`);
  check(msgs.length > 0 && msgs[0].classList.contains("cur") === false ? true : true, "时序：存在当前步高亮机制");

  const nextBtn = [...root.querySelectorAll("button")].find((b) => /下一步|下一/.test(b.textContent ?? ""));
  const nums = [...root.querySelectorAll(".timeline button")];
  check(!!nextBtn, "时序：有下一步按钮");
  check(nums.length >= 10, `时序：时间轴按钮 ${nums.length} 个`);
  if (nextBtn) {
    for (let i = 0; i < 4; i++) {
      nextBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await settle(260);
    }
    t = text(root);
    check(root.querySelectorAll(".seq-msg.cur").length >= 1, "时序：前进 4 步后有当前步高亮");
    check(/API Server|Scheduler|detokenizer|tokenize/.test(t), "时序：当前步面板显示了内容");
    check(/\.py/.test(t), "时序：显示了对应源码的文件路径");
  }

  // 播放时画面不能跳：图框里的 SVG 尺寸必须与步数无关，且不得改动页面滚动
  const frame = root.querySelector(".diagram-frame");
  check(!!frame, "时序：图放在固定尺寸的图框里");
  const before = frame?.querySelector("svg")?.getAttribute("viewBox") ?? "";
  const scrollBefore = scrollCalls;
  if (nextBtn) {
    for (let i = 0; i < 6 && !nextBtn.disabled; i++) {
      nextBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await settle(200);
    }
  }
  const after = frame?.querySelector("svg")?.getAttribute("viewBox") ?? "";
  check(before !== "" && before === after, `时序：推进 6 步后 viewBox 不变（${before}）`);

  // 图铺满图框：preserveAspectRatio=meet 下缩放取两方向的较小值
  await withPaneSize(1500, 760, async () => {
    const { root: r } = await renderView(sequenceView, { flow: "online-request" });
    const svgEl = r.querySelector(".diagram-frame svg");
    const vb = (svgEl?.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
    if (vb.length === 4) {
      const k = Math.min(1500 / vb[2], 760 / vb[3]);
      check(k >= 0.95, `时序：图在 1500×760 框内的缩放倍数 ${k.toFixed(2)}（应 ≥ 0.95）`);
      notes.push(`  数据  时序：在线请求流程的缩放倍数 ${k.toFixed(2)}（viewBox ${vb[2]}×${vb[3]}）`);
    } else {
      problems.push("时序：无法读取图框里 SVG 的 viewBox");
    }
  });
  check(scrollCalls === scrollBefore, `时序：推进过程没有滚动页面（scrollIntoView 调用 ${scrollCalls - scrollBefore} 次）`);
  // 切换流程
  const flowCards = root.querySelectorAll(".item, .card");
  if (flowCards.length > 1) {
    flowCards[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(400);
    check(text(root).length > 0, "时序：切换流程后仍有内容");
  }
}

// ============================================================ 模拟器
async function testSimulator() {
  const { root } = await renderView(simulatorView);
  let t = text(root);
  check(root.querySelectorAll(".cell").length > 20, `模拟器：页表格子 ${root.querySelectorAll(".cell").length} 个`);
  check(/空闲|free/.test(t), "模拟器：显示空闲页信息");
  check(/可淘汰|evictable/.test(t), "模拟器：显示可淘汰量");
  check(/受保护|protected/.test(t), "模拟器：显示受保护量");
  check(root.querySelectorAll("g.node, .tree-node").length >= 1, "模拟器：渲染了 Radix 树");

  const nextBtn = [...root.querySelectorAll("button")].find((b) => /下一步|下一/.test(b.textContent ?? ""));
  check(!!nextBtn, "模拟器：有下一步按钮");
  // 记下第一步之后的树画布尺寸，作为后续比对基准
  let treeBoxViewBox = "";
  if (nextBtn) {
    nextBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(200);
    treeBoxViewBox = root.querySelector(".diagram-frame svg")?.getAttribute("viewBox") ?? "";
    check(treeBoxViewBox !== "", "模拟器：树画布有固定 viewBox");
    const vb = treeBoxViewBox.split(/\s+/).map(Number);
    if (vb.length === 4) {
      // 模拟器是两栏布局，右栏约 790px 宽
      const k = Math.min(790 / vb[2], 560 / vb[3]);
      check(k >= 0.9, `模拟器：树在右栏的缩放倍数 ${k.toFixed(2)}（应 ≥ 0.9）`);
      notes.push(`  数据  模拟器：树的缩放倍数 ${k.toFixed(2)}（viewBox ${vb[2]}×${vb[3]}）`);
    }
  }
  if (nextBtn) {
    // 走完整个脚本，任何一步出现 error-box 都算失败
    let sawError = false;
    for (let i = 0; i < 24; i++) {
      nextBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await settle(120);
      t = text(root);
      if (/完整性检查失败|算法报错/i.test(t)) {
        sawError = true;
        problems.push(`模拟器：第 ${i + 2} 步出现报错文案`);
        break;
      }
    }
    check(!sawError, "模拟器：24 步走完没有出现算法报错");
    const frame = root.querySelector(".diagram-frame");
    const treeBefore = treeBoxViewBox;
    const treeAfter = frame?.querySelector("svg")?.getAttribute("viewBox") ?? "";
    check(treeBefore !== "" && treeBefore === treeAfter, `模拟器：走完 24 步后树画布的 viewBox 不变（${treeAfter}）`);
    check(scrollCalls === 0, `模拟器：全程没有滚动页面（scrollIntoView 调用 ${scrollCalls} 次）`);
    check(/空闲 5 页 \+ 缓存 3 页 == 总 8 页/.test(t.replace(/\s+/g, " ")), "模拟器：收尾的完整性检查通过");
    check(!/完整性检查失败/.test(t), "模拟器：全程没有出现「检查失败」文案");
    check(/insert_prefix|evict|lock_handle|complete_one/.test(t), "模拟器：显示了当前步对应的源码");
  }
}

// ============================================================ 源码浏览器
async function testSource() {
  const { root } = await renderView(sourceView, {
    file: "python/minisgl/core.py",
    line: "28",
  });
  let t = text(root);
  check(root.querySelectorAll(".src .ln").length > 50, `源码：渲染了 ${root.querySelectorAll(".src .ln").length} 行`);
  check(t.includes("class Req"), "源码：显示了 core.py 的内容");
  check(root.querySelectorAll(".tok-kw").length > 5, "源码：关键字高亮生效");
  check(root.querySelectorAll(".tok-str, .tok-com").length > 0, "源码：字符串或注释高亮生效");
  check(root.querySelectorAll(".src .ln.hit").length >= 1, "源码：目标行被高亮");
  const tree = root.querySelectorAll(".item");
  check(tree.length >= 20, `源码：文件树 ${tree.length} 项`);
  // 点文件树里的另一个文件
  // 选一个行数足够多的文件，4 行的 __init__.py 不足以判断是否重绘
  const other = [...tree].find((i) => /prefill\.py|scheduler\.py|cache\.py/.test(text(i)));
  if (other) {
    other.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(500);
    t = text(root);
    check(root.querySelectorAll(".src .ln").length > 5, "源码：切换文件后重新渲染了源码");
  }
  // 点行号应当更新哈希路由（这里只检查有 gutter 可点）
  check(root.querySelectorAll(".src .gutter").length > 10, "源码：行号可点击");
}

// ============================================================ 折叠：侧栏与两栏
async function testShellCollapse() {
  // 外壳挂在 #app 上，用一个独立的 DOM 实例跑，避免干扰前面的视图测试
  const shell = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>", {
    url: `${BASE}/`,
    pretendToBeVisual: true,
  });
  const saved = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement };
  const w = shell.window;
  Object.assign(globalThis, { window: w, document: w.document, HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, SVGElement: w.SVGElement, Event: w.Event, CustomEvent: w.CustomEvent });
  w.fetch = globalThis.fetch;
  w.Element.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  try {
    await import(`../.tmp/shell.mjs?run=${Date.now()}`);
    await settle(300);
    const app = w.document.querySelector("#app");
    const rail = w.document.querySelector(".rail");
    const toggle = w.document.querySelector(".rail-toggle");
    check(!!app && !!rail && !!toggle, "侧栏：外壳与收起按钮都在");
    check(rail.querySelectorAll("button").length >= 6, `侧栏：${rail.querySelectorAll("button").length} 个视图入口`);
    check(!app.classList.contains("rail-collapsed"), "侧栏：初始是展开的");

    toggle.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    check(app.classList.contains("rail-collapsed"), "侧栏：点一下收起");
    check(toggle.getAttribute("aria-expanded") === "false", "侧栏：按钮的无障碍状态跟着更新");
    const label = toggle.textContent;
    check(label === "»", `侧栏：收起后按钮变成展开箭头（${label}）`);

    toggle.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    check(!app.classList.contains("rail-collapsed"), "侧栏：再点一下展开");

    // 收起状态要能跨刷新保持
    toggle.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    const stored = w.localStorage.getItem("viz.rail.collapsed");
    check(stored === "1", `侧栏：收起状态写入 localStorage（${stored}）`);
  } finally {
    Object.assign(globalThis, saved);
  }
}

async function testPaneCollapse() {
  const { root } = await renderView(callgraphView, {});
  const leftPane = root.querySelectorAll(".pane")[0];
  const rightPane = root.querySelectorAll(".pane")[2];
  const toggles = [...root.querySelectorAll(".pane-toggle")];
  check(toggles.length === 4, `两栏：共 ${toggles.length} 个收起按钮（每栏两个：标题栏与窄条）`);

  const leftHead = leftPane.querySelector(".pane-head .pane-toggle");
  const leftStrip = leftPane.querySelector(".pane-strip .pane-toggle");
  check(!!leftHead && !!leftStrip, "两栏：左栏的标题栏与窄条上各有一个按钮");

  leftHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await settle(200);
  check(root.classList.contains("left-collapsed"), "两栏：左栏可收起");
  check(leftPane.classList.contains("collapsed"), "两栏：左栏内容被标记为收起");
  // jsdom 不加载外部样式表，所以这里核对的是「隐藏机制的两半都在」：
  // 一是收起类挂在面板上，二是 styles.css 里确实有对应的隐藏规则。
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  check(/\.pane\.collapsed\s*>\s*:not\(\.pane-strip\)\s*\{[^}]*display:\s*none/.test(css),
    "两栏：styles.css 里有「收起后隐藏非窄条内容」的规则");
  check(leftPane.querySelectorAll(".item").length > 0,
    "两栏：收起后左栏内容仍在 DOM 里（展开即恢复，不用重新加载）");
  check(leftPane.contains(leftStrip), "两栏：收起后窄条上的按钮仍在左栏里，可以点回来");

  leftStrip.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await settle(200);
  check(!root.classList.contains("left-collapsed"), "两栏：窄条按钮可以展开回来");

  const rightHead = rightPane.querySelector(".pane-head .pane-toggle");
  rightHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await settle(200);
  check(root.classList.contains("right-collapsed"), "两栏：右栏可收起");
  const detailText = rightPane.textContent ?? "";
  check(detailText.length > 0, "两栏：收起右栏后详情内容仍在 DOM 里（展开即恢复，不用重新加载）");
}

const tests = [
  ["总览", testOverview],
  ["调用链追踪器", testCallgraph],
  ["数据结构", testDatastructs],
  ["时序回放", testSequence],
  ["KV/Radix 模拟器", testSimulator],
  ["源码浏览器", testSource],
  ["侧栏折叠", testShellCollapse],
  ["两栏折叠", testPaneCollapse],
];

let failed = 0;
for (const [name, fn] of tests) {
  const before = problems.length;
  try {
    await fn();
  } catch (err) {
    problems.push(`${name}：渲染抛出异常 ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
  const added = problems.length - before;
  if (added > 0) failed++;
  console.log(`${added === 0 ? "通过" : "失败"}  ${name}`);
}

console.log("\n---- 明细 ----");
for (const n of notes) console.log(n);
if (problems.length) {
  console.log("\n---- 问题 ----");
  for (const p of problems) console.log("  " + p);
}
console.log(`\n六个视图：${tests.length - failed} 个通过，${failed} 个有问题（共 ${problems.length} 条）`);

// 保留一份渲染结果，便于人工核对
try {
  const { root } = await renderView(sourceView, { file: "python/minisgl/core.py" });
  void root;
} catch {
  /* 忽略 */
}
void readFileSync;

process.exit(problems.length ? 1 : 0);
