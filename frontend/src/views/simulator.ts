// KV / Radix 模拟器：把分页分配、页表写入、前缀命中与淘汰按步骤演出来。

import { api } from "../api";
import { clear, el, hashColor, svg } from "../lib/dom";
import { focusInto, sourceBlock } from "../lib/hl";
import { CacheSim } from "../lib/simulator";
import type { OpResult, SimParams } from "../lib/simulator";
import { mountHead } from "../lib/view";
import type { SimOp, SymbolDetail } from "../types";
import type { View, ViewContext } from "./types";

const NODE_W = 156;
const NODE_H = 36;
// 树的画布尺寸写死，不随树的大小变化。数值按脚本可能出现的最深层数与最多兄弟数留够：
// 4 层 × 每层 3 个节点。viewBox 固定后，缩放比例也就固定了。
// 宽度取 780 是为了配合模拟器两栏（各约 790px）的宽度，让树接近 1:1 显示。
const TREE_VB_W = 780;
const TREE_VB_H = 330;

let playTimer: number | undefined;

export const simulatorView: View = {
  id: "simulator",
  title: "KV / Radix 模拟器",
  subtitle: "分页分配、淘汰与前缀缓存的联动动画",
  render(ctx) {
    return renderSimulator(ctx);
  },
  destroy() {
    if (playTimer !== undefined) {
      window.clearInterval(playTimer);
      playTimer = undefined;
    }
  },
};

interface Params extends SimParams {
  title: string;
  desc: string;
  ops: SimOp[];
}

async function renderSimulator(ctx: ViewContext): Promise<void> {
  const { root } = ctx;
  mountHead(
    root,
    "KV / Radix 模拟器",
    "这是按源码重写的教学模拟：步数与页数按参数算出，用来对照算法。它只保留 CacheManager、TableManager、RadixPrefixCache 里与页分配、页表、前缀匹配和淘汰有关的状态。",
  );

  const content = await api.content();
  const scenario = content.kv_scenario;
  window.history.replaceState(null, "", "#/simulator");

  let params: Params = {
    page_size: scenario.params.page_size,
    num_pages: scenario.params.num_pages,
    max_running_req: scenario.params.max_running_req,
    title: scenario.title,
    desc: scenario.desc,
    ops: scenario.ops,
  };

  let sim = new CacheSim(params);
  let cursor = 0; // 已应用的 op 数量
  let lastResult: OpResult | null = null;
  const symCache = new Map<string, SymbolDetail | null>();

  // ---------------- 控制区 ----------------
  const pageSel = el("select") as HTMLSelectElement;
  for (const ps of [1, 2, 4, 8]) pageSel.append(el("option", { value: String(ps), text: String(ps) }));
  const pagesInput = el("input", { type: "number", min: "2", max: "32", style: "width:80px" }) as HTMLInputElement;
  const maxReqInput = el("input", { type: "number", min: "1", max: "8", style: "width:72px" }) as HTMLInputElement;
  const rerunBtn = el("button", { class: "btn", text: "按新参数重跑", onclick: () => rerun() });

  const prevBtn = el("button", { class: "btn", text: "上一步", onclick: () => seek(cursor - 1) });
  const nextBtn = el("button", { class: "btn primary", text: "下一步", onclick: () => seek(cursor + 1) });
  const playBtn = el("button", { class: "btn", text: "播放", onclick: () => togglePlay() });
  const resetBtn = el("button", { class: "btn", text: "重置", onclick: () => seek(0) });

  const readout = el("div", { class: "row", style: "gap:18px;margin:10px 0" });
  const gridBox = el("div");
  const treeBox = el("div", { class: "diagram-frame" });
  const stepBox = el("div", { style: "margin-top:14px" });
  const sourceBox = el("div", { style: "margin-top:10px" });

  root.append(
    el("div", { class: "stepbox" },
      el("h4", { text: "这不是真实运行的录像" }),
      el("p", { style: "margin:0", text: "下面是按 mini-sglang 源码重写的模拟：page_size 与 num_pages 可调，free_slots、页表、Radix 树的语义都按实现来。模型前向、attention 元数据、张量搬运这些与页管理无关的部分没有搬进来。" }),
    ),
    el("div", { class: "row", style: "margin:12px 0" },
      el("span", { class: "faint", text: "page_size" }), pageSel,
      el("span", { class: "faint", text: "num_pages" }), pagesInput,
      el("span", { class: "faint", text: "max_running_req" }), maxReqInput,
      rerunBtn,
    ),
    el("div", { class: "row", style: "margin-bottom:6px" }, prevBtn, nextBtn, playBtn, resetBtn,
      el("span", { class: "faint mono", style: "font-size:12px", id: "sim-pos" })),
    readout,
    el("div", { style: "display:grid;grid-template-columns:minmax(360px,1fr) minmax(360px,1fr);gap:16px" },
      el("div", {}, el("h3", { text: "页表与物理页池" }), gridBox),
      el("div", {}, el("h3", { text: "Radix 前缀树" }), treeBox),
    ),
    stepBox,
    sourceBox,
  );

  function rebuild(): void {
    sim = new CacheSim(params);
    sim.prime(params.ops);
    let r: OpResult | null = null;
    for (let i = 0; i < cursor; i++) r = sim.runOp(params.ops[i]);
    lastResult = r;
  }

  function seek(target: number): void {
    cursor = Math.max(0, Math.min(params.ops.length, target));
    if (target >= params.ops.length) stopPlay();
    rebuild();
    render();
  }

  function rerun(): void {
    stopPlay();
    params = {
      ...params,
      page_size: Number(pageSel.value),
      num_pages: Math.max(2, Number(pagesInput.value) || scenario.params.num_pages),
      max_running_req: Math.max(1, Number(maxReqInput.value) || scenario.params.max_running_req),
    };
    cursor = 0;
    rebuild();
    render();
  }

  function togglePlay(): void {
    if (playTimer !== undefined) {
      stopPlay();
      return;
    }
    if (cursor >= params.ops.length) cursor = 0;
    playBtn.textContent = "暂停";
    playTimer = window.setInterval(() => {
      if (cursor >= params.ops.length) {
        stopPlay();
        return;
      }
      seek(cursor + 1);
    }, 1100);
  }

  function stopPlay(): void {
    if (playTimer !== undefined) {
      window.clearInterval(playTimer);
      playTimer = undefined;
    }
    playBtn.textContent = "播放";
  }

  // ---------------- 渲染 ----------------
  function render(): void {
    const pos = root.querySelector<HTMLElement>("#sim-pos");
    if (pos) pos.textContent = cursor === 0 ? `初始状态（0 / ${params.ops.length}）` : `已应用 ${cursor} / ${params.ops.length}：${params.ops[cursor - 1].op}`;
    prevBtn.toggleAttribute("disabled", cursor <= 0);
    nextBtn.toggleAttribute("disabled", cursor >= params.ops.length);
    renderReadout();
    renderGrid();
    renderTree();
    void renderStep();
  }

  function renderReadout(): void {
    const s = sim.snapshot();
    clear(readout);
    const item = (label: string, value: string, cls = ""): HTMLElement =>
      el("span", { class: cls }, [el("span", { class: "faint", text: `${label} ` }), el("b", { class: "mono", text: value })]);
    readout.append(
      item("可淘汰 evictable_size", `${s.evictable} token`),
      item("受保护 protected_size", `${s.protectedSize} token`),
      item("空闲 free_slots", `${s.freePages.length} 页`),
      item("树上缓存", `${s.cachePages} 页`),
      el("span", {}, [
        el("span", { class: "faint", text: "完整性 " }),
        // 运行中请求占着页，这条恒等式本来就不成立，不该标成失败
        el("b", {
          class: "mono",
          style: s.integrityStrict
            ? "color:var(--accent-2)"
            : s.inflightPages > 0
              ? "color:var(--warn)"
              : "color:var(--danger)",
          text: s.integrity ?? "",
        }),
      ]),
    );
  }

  function ownerColor(tableIdx: number): string {
    for (const req of sim.reqs.values()) if (req.tableIdx === tableIdx) return hashColor(`uid${req.uid}`);
    return hashColor(`row${tableIdx}`);
  }

  function renderGrid(): void {
    const s = sim.snapshot();
    clear(gridBox);
    const grid = el("div", { class: "grid-cells", style: `grid-template-columns:34px repeat(${s.cols}, 15px)` });
    const hlCells = new Set((lastResult?.highlightCells ?? []).map((c) => `${c.row}:${c.col}`));
    const hlPages = new Set(lastResult?.highlightPages ?? []);

    for (let r = 0; r < s.rows; r++) {
      const dummy = r === sim.maxRunningReq;
      grid.append(el("div", { class: "faint mono", style: "font-size:10px;align-self:center", title: dummy ? "dummy 请求固定占用这一行" : `table_idx=${r}`, text: dummy ? "dmy" : `r${r}` }));
      for (let c = 0; c < s.cols; c++) {
        const v = s.pageTable[r][c];
        const cell = el("div", { class: "cell" });
        if (v === null) cell.classList.add("empty");
        else if (dummy) cell.classList.add("free");
        else {
          cell.classList.add("used");
          cell.style.background = ownerColor(r);
          cell.title = `table_idx=${r} pos=${c} → 物理位置 ${v}（页 ${v - (v % sim.pageSize)}）`;
        }
        if (hlCells.has(`${r}:${c}`)) cell.classList.add("hl");
        if (v !== null && hlPages.has(v - (v % sim.pageSize))) cell.classList.add("hl");
        grid.append(cell);
      }
    }
    gridBox.append(grid);
    gridBox.append(el("div", { class: "faint", style: "font-size:11.5px;margin:6px 0 3px", text: `${sim.maxRunningReq + 1} 行 × ${s.cols} token 位置。行号就是 table_idx，来自 TableManager.allocate（从槽位池末尾弹出，所以 uid1 拿到 r${sim.maxRunningReq - 1}）。` }));
    gridBox.append(el("div", { class: "legend", style: "margin-bottom:6px" },
      el("span", {}, [el("i", { style: "background:var(--bg-2)" }), "空位"]),
      el("span", {}, [el("i", { style: "background:var(--accent)" }), "本行请求占用的 KV 位置（颜色按请求区分）"]),
      el("span", {}, [el("i", { style: "outline:2px solid var(--accent-2)" }), "本次操作刚写入"]),
    ));

    // 物理页池
    gridBox.append(el("div", { class: "faint", style: "font-size:11.5px;margin:10px 0 4px", text: "物理页池：每格是一张页（page_size 个 token）。空闲页来自 free_slots，已用页由页表里的物理位置反推。" }));
    const usedPage = new Map<number, number>();
    for (const req of sim.reqs.values()) {
      for (const phys of req.cells.values()) {
        const page = phys - (phys % sim.pageSize);
        if (!usedPage.has(page)) usedPage.set(page, req.uid);
      }
    }
    const strip = el("div", { class: "grid-cells", style: `grid-template-columns:repeat(${sim.numPages}, 18px)` });
    for (let p = 0; p < sim.numPages; p++) {
      const start = p * sim.pageSize;
      const free = sim.freeSlots.includes(start);
      const cell = el("div", { class: "cell", style: "width:18px;height:18px" });
      cell.title = `页 ${p}（token ${start}..${start + sim.pageSize - 1}）${free ? " · 空闲" : " · 已用"}`;
      if (free) cell.classList.add("free");
      else {
        const uid = usedPage.get(start);
        cell.style.background = uid !== undefined ? hashColor(`uid${uid}`) : "var(--neutral)";
      }
      if (hlPages.has(start)) cell.classList.add("hl");
      strip.append(cell);
    }
    gridBox.append(strip);
    gridBox.append(el("div", { class: "faint mono", style: "font-size:11px;margin-top:4px", text: `free_slots = [${sim.freeSlots.slice().sort((a, b) => a - b).join(", ")}]` }));
  }

  function renderTree(): void {
    clear(treeBox);
    const nodes = sim.tree.nodes();
    const layers: string[][] = [];
    for (const { node, depth } of nodes) {
      while (layers.length <= depth) layers.push([]);
      layers[depth].push(String(node.id));
    }
    const maxRows = layers.reduce((m, l) => Math.max(m, l.length), 0);
    const pitchY = (TREE_VB_H - NODE_H - 24) / Math.max(1, maxRows - 1 || 1);
    const pitchX = (TREE_VB_W - NODE_W - 80) / Math.max(1, layers.length - 1 || 1);
    const pos = new Map<number, { x: number; y: number }>();
    const spanX = (layers.length - 1) * pitchX;
    const x0 = 40 + Math.max(0, (TREE_VB_W - 80 - NODE_W - spanX) / 2);
    layers.forEach((layer, li) => {
      const spanY = (layer.length - 1) * pitchY;
      const y0 = 12 + Math.max(0, (TREE_VB_H - 24 - NODE_H - spanY) / 2);
      layer.forEach((id, ri) => pos.set(Number(id), { x: x0 + li * pitchX, y: y0 + ri * pitchY }));
    });
    // 画布尺寸固定：树长大或缩小都不改 viewBox，否则缩放比例会跟着变，
    // 节点文字一会儿大一会儿小，整个右侧也会上下跳。
    const canvas = svg("svg", { viewBox: `0 0 ${TREE_VB_W} ${TREE_VB_H}`, preserveAspectRatio: "xMidYMid meet" });
    const hl = new Set(lastResult?.highlightNodes ?? []);
    const isNew = new Set(lastResult?.newNodes ?? []);

    for (const { node } of nodes) {
      if (!node.parent) continue;
      const a = pos.get(node.parent.id);
      const b = pos.get(node.id);
      if (!a || !b) continue;
      canvas.append(svg("path", {
        d: `M ${a.x + NODE_W} ${a.y + NODE_H / 2} C ${(a.x + NODE_W + b.x) / 2} ${a.y + NODE_H / 2}, ${(a.x + NODE_W + b.x) / 2} ${b.y + NODE_H / 2}, ${b.x} ${b.y + NODE_H / 2}`,
        fill: "none", stroke: "var(--edge-resolved)", "stroke-width": 1.4,
      }));
    }

    for (const { node } of nodes) {
      const p = pos.get(node.id);
      if (!p) continue;
      const isRoot = !node.parent;
      const isHl = hl.has(node.id);
      const g = svg("g", { class: `node${isRoot ? " sel" : ""}`, transform: `translate(${p.x} ${p.y})` });
      const rect = svg("rect", { class: "box", width: NODE_W, height: NODE_H, style: isHl ? "stroke:var(--accent-2);stroke-width:2" : "" });
      if (isHl) {
        rect.append(
          svg("animate", { attributeName: "stroke-width", values: "2;6;2", dur: "0.8s", repeatCount: "indefinite" }),
        );
      }
      g.append(rect);
      const label = isRoot ? "root" : `tok[${node.key[0]}…${node.key[node.key.length - 1]}] · len ${node.length}`;
      g.append(svg("text", { x: 10, y: 15, text: label }));
      const tag = isRoot ? "始终受保护" : node.ref > 0 ? `protected · ref=${node.ref}` : "evictable · ref=0";
      g.append(svg("text", { class: "sub", x: 10, y: 29, text: tag }));
      g.append(svg("title", { text: `${isRoot ? "根节点" : `key=[${node.key.join(", ")}]`}\nvalue=[${node.value.join(", ")}]\nref_count=${node.ref} 长度=${node.length}${isNew.has(node.id) ? "\n本次操作新建" : ""}` }));
      canvas.append(g);
    }

    treeBox.append(canvas);
    treeBox.append(el("div", { class: "legend", style: "margin-top:6px" },
      el("span", {}, [el("i", { style: "background:var(--accent-2)" }), "本次操作触及的节点（呼吸高亮）"]),
      el("span", { class: "faint", text: "分叉 = split_at 把部分命中的节点拆成前缀 + 后缀" }),
    ));
  }

  async function renderStep(): Promise<void> {
    clear(stepBox);
    clear(sourceBox);
    if (cursor === 0) {
      stepBox.append(el("div", { class: "stepbox" }, el("h4", { text: "初始状态" }), el("p", { style: "margin:0", text: `${params.title}：${params.desc}` })));
      return;
    }
    const op = params.ops[cursor - 1];
    const box = el("div", { class: "stepbox" },
      el("h4", { text: `第 ${cursor} / ${params.ops.length} 步：${op.op}` }),
      el("p", { style: "margin-bottom:6px", text: op.text }),
    );
    if (op.hint) box.append(el("p", { class: "faint mono", style: "font-size:12px", text: op.hint }));
    if (lastResult?.message && lastResult.message !== op.text) {
      box.append(el("p", { style: "margin-bottom:4px" }, [el("b", { text: "模拟结果：" }), el("span", { text: lastResult.message })]));
    }
    if (lastResult?.error) {
      box.append(el("p", { style: "color:var(--danger);margin-bottom:4px" }, [el("b", { text: "断言失败：" }), el("span", { class: "mono", text: lastResult.error })]));
    }
    if (lastResult?.divergence) {
      box.append(el("p", { class: "faint", style: "font-size:12.5px;margin:0", text: lastResult.divergence }));
    }
    stepBox.append(box);

    if (!op.symbol) return;
    sourceBox.append(el("h3", { text: "这一步对应的源码" }));
    let detail = symCache.get(op.symbol) ?? undefined;
    if (detail === null) {
      sourceBox.append(el("div", { class: "faint", text: `抽取数据里没有 ${op.symbol} 的源码片段。` }));
      return;
    }
    if (detail === undefined) {
      sourceBox.append(el("p", { class: "loading", text: "加载源码中…" }));
      try {
        detail = await api.symbol(op.symbol);
        symCache.set(op.symbol, detail);
      } catch {
        symCache.set(op.symbol, null);
        clear(sourceBox);
        sourceBox.append(el("h3", { text: "这一步对应的源码" }), el("div", { class: "error-box", text: `源码加载失败：${op.symbol}` }));
        return;
      }
      clear(sourceBox);
      sourceBox.append(el("h3", { text: "这一步对应的源码" }));
    }
    const sym = detail.symbol;
    const src = detail.source;
    if (!src || src.lines.length === 0) {
      sourceBox.append(el("div", { class: "faint", text: "该符号没有源码片段。" }));
      return;
    }
    const focus = pickFocusLine(src.lines, op);
    sourceBox.append(
      el("div", { class: "row" },
        el("span", {
          class: "mono", style: "cursor:pointer;text-decoration:underline;font-size:12.5px",
          text: `${sym.file}:${focus}`,
          onclick: () => ctx.navigate(ctx.sourceRoute(sym.file, focus)),
        }),
        el("span", { class: "faint", style: "font-size:12px", text: "浅色高亮是符号所在范围，深色高亮是步骤定位到的那一行（按 hint 或方法入口推断）。" }),
      ),
    );
    const block = sourceBlock(src.lines, sym.file, {
      highlight: [[sym.lineno, sym.end_lineno]],
      focusLine: focus,
      onLineClick: (n) => ctx.navigate(ctx.sourceRoute(sym.file, n)),
    });
    sourceBox.append(block);
    focusInto(block);
  }

  /** 尽量定位到 op 对应的那一行：优先用 hint 里的代码片段，否则退回符号入口 */
  function pickFocusLine(lines: { n: number; text: string }[], op: SimOp): number {
    if (op.hint) {
      const needle = op.hint.replace(/^hint:\s*/, "").trim();
      if (/[=().]|assert/.test(needle)) {
        const hit = lines.find((l) => l.text.includes(needle));
        if (hit) return hit.n;
      }
    }
    return lines[0].n;
  }

  pageSel.value = String(params.page_size);
  pagesInput.value = String(params.num_pages);
  maxReqInput.value = String(params.max_running_req);
  rebuild();
  render();
}
