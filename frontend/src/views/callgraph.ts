// 调用链追踪器：文件树 + 分层调用图 + 符号详情，支持重定根、找路径。

import { api } from "../api";
import { clear, el, hashColor, makePanZoom, svg } from "../lib/dom";
import { boundsOf, byGroupThenName, layerLayout } from "../lib/layout";
import type { Pt } from "../lib/layout";
import { mountHead } from "../lib/view";
import type { FileMeta, Graph, GraphNode, Neighbor, SymbolDetail } from "../types";
import type { View, ViewContext } from "./types";

const NODE_W = 144;
const NODE_H = 44;
// 层间距取小：横向是层数乘出来的，收窄它才能让层多的图也铺满面板
const GAP_X = 28;
const GAP_Y = 22;
// 画布兜底尺寸。正常情况下按面板的像素尺寸建画布：视口单位与 CSS 像素 1:1，
// fit() 算出的缩放就是真实缩放。若固定成一个大 viewBox，CSS 会先缩一次，
// fit 再缩一次，两次叠起来图会小到看不清。
const CANVAS_FALLBACK_W = 900;
const CANVAS_FALLBACK_H = 560;

const ENTRY_POINTS: { id: string; label: string }[] = [
  { id: "minisgl.scheduler.scheduler.Scheduler.run_forever", label: "Scheduler.run_forever" },
  { id: "minisgl.scheduler.scheduler.Scheduler.overlap_loop", label: "Scheduler.overlap_loop" },
  { id: "minisgl.engine.engine.Engine.forward_batch", label: "Engine.forward_batch" },
  { id: "minisgl.models.qwen3.Qwen3ForCausalLM.forward", label: "Qwen3ForCausalLM.forward" },
  { id: "minisgl.kvcache.radix_cache.RadixPrefixCache._tree_walk", label: "RadixPrefixCache._tree_walk" },
  { id: "minisgl.engine.graph.GraphRunner.replay", label: "GraphRunner.replay" },
  { id: "minisgl.server.launch.launch_server", label: "launch_server" },
  { id: "minisgl.attention.base.HybridBackend.forward", label: "HybridBackend.forward" },
];

interface PathState {
  from: string;
  to: string;
  found: boolean;
  nodeIds: Set<string>;
  edgeKeys: Set<string>;
  hops: string[];
}

let searchTimer: number | undefined;

export const callgraphView: View = {
  id: "callgraph",
  title: "调用链追踪器",
  subtitle: "点一个函数，看它调用了谁、被谁调用，追踪完整链路",
  render(ctx) {
    return renderCallgraph(ctx);
  },
  destroy() {
    if (searchTimer !== undefined) {
      window.clearTimeout(searchTimer);
      searchTimer = undefined;
    }
    paneResizeObserver?.disconnect();
    paneResizeObserver = null;
  },
};

let paneResizeObserver: ResizeObserver | null = null;

async function renderCallgraph(ctx: ViewContext): Promise<void> {
  const { root } = ctx;
  const head = mountHead(
    root,
    "调用链追踪器",
    "中间是调用图：点击节点即可把它设为新的根；实线是静态解析到的调用，虚线是经字段类型推断出的调用，紫色虚线是「接口方法 → 具体实现」的对应关系，不是一次调用。",
  );
  root.classList.add("split");

  // ---- 左右两栏可收起：收起后只留一条窄条，按钮仍在原地 ----
  const panes: Partial<Record<"left" | "right", HTMLElement>> = {};
  const paneButtons: Record<"left" | "right", HTMLButtonElement[]> = { left: [], right: [] };
  const PANE_NAME: Record<"left" | "right", string> = { left: "文件 / 模块", right: "符号详情" };

  function paneToggleButton(side: "left" | "right"): HTMLButtonElement {
    const btn = el("button", { class: "pane-toggle", type: "button" });
    btn.addEventListener("click", () => setPaneCollapsed(side, !root.classList.contains(`${side}-collapsed`)));
    paneButtons[side].push(btn);
    return btn;
  }

  function paneHead(side: "left" | "right"): HTMLElement {
    return el("div", { class: "pane-head" },
      el("h3", { text: PANE_NAME[side] }),
      paneToggleButton(side),
    );
  }

  function paneStrip(side: "left" | "right"): HTMLElement {
    return el("div", { class: "pane-strip" },
      paneToggleButton(side),
      el("span", { class: "strip-label", text: PANE_NAME[side] }),
    );
  }

  function setPaneCollapsed(side: "left" | "right", collapsed: boolean): void {
    root.classList.toggle(`${side}-collapsed`, collapsed);
    panes[side]?.classList.toggle("collapsed", collapsed);
    for (const btn of paneButtons[side]) {
      btn.textContent = collapsed ? (side === "left" ? "»" : "«") : (side === "left" ? "«" : "»");
      btn.title = collapsed ? `展开${PANE_NAME[side]}` : `收起${PANE_NAME[side]}`;
      btn.setAttribute("aria-expanded", String(!collapsed));
    }
    try {
      window.localStorage.setItem(`viz.pane.${side}`, collapsed ? "1" : "0");
    } catch {
      /* 写不了就算了，只影响下次打开时的状态 */
    }
  }

  function storedPaneState(side: "left" | "right"): boolean {
    try {
      return window.localStorage.getItem(`viz.pane.${side}`) === "1";
    } catch {
      return false;
    }
  }

  let lastPaneW = 0;
  let lastPaneH = 0;
  let rootId = ctx.params.get("symbol") ?? ENTRY_POINTS[0].id;
  let depth = Number(ctx.params.get("depth") ?? "2") || 2;
  let direction = "both";
  let graph: Graph | null = null;
  let detail: SymbolDetail | null = null;
  let pathState: PathState | null = null;
  let lastPathNodes: Graph["nodes"] = [];
  let lastPathEdges: Graph["edges"] = [];
  let fileFilter = "";
  let groupFilter = ctx.params.get("group") ?? "";
  let fileQuery = "";

  const filesMap = await api.files();
  const byGroup = new Map<string, FileMeta[]>();
  for (const meta of Object.values(filesMap)) {
    const list = byGroup.get(meta.group) ?? [];
    list.push(meta);
    byGroup.set(meta.group, list);
  }
  for (const list of byGroup.values()) list.sort((a, b) => a.path.localeCompare(b.path));
  const groups = [...byGroup.keys()].sort((a, b) => a.localeCompare(b));

  // ---------------- 顶部控制区 ----------------
  const rootLabel = el("span", { class: "mono", style: "font-size:12px" });
  const depthSel = el("select") as HTMLSelectElement;
  for (const d of [1, 2, 3]) depthSel.append(el("option", { value: String(d), text: `深度 ${d}` }));
  depthSel.value = String(Math.min(3, Math.max(1, depth)));
  const dirSel = el("select") as HTMLSelectElement;
  for (const [v, t] of [["down", "下游（它调用谁）"], ["up", "上游（谁调用它）"], ["both", "双向"]] as const) {
    dirSel.append(el("option", { value: v, text: t }));
  }
  const resetBtn = el("button", { class: "btn", text: "回到入口", onclick: () => reroot(ENTRY_POINTS[0].id) });
  const pathFromInput = el("input", { type: "text", style: "flex:1;min-width:180px" }) as HTMLInputElement;
  const pathToInput = el("input", { type: "search", placeholder: "目标符号…", style: "flex:1;min-width:180px" }) as HTMLInputElement;
  const pathToResults = el("div", { class: "list", style: "max-height:180px;overflow:auto;margin-top:6px" });
  const traceBtn = el("button", { class: "btn primary", text: "找路径", onclick: () => void tracePath() });
  const clearPathBtn = el("button", { class: "btn", text: "清除高亮", onclick: () => { pathState = null; pathToResults2.textContent = ""; void refreshGraph(); } });
  const pathToResults2 = el("div", { class: "dim", style: "font-size:12.5px" });

  // 预设入口放成下拉，比一排按钮省一整行高度
  const presetSel = el("select") as HTMLSelectElement;
  presetSel.append(el("option", { value: "", text: "选择入口…" }));
  for (const p of ENTRY_POINTS) presetSel.append(el("option", { value: p.id, text: p.label }));
  presetSel.addEventListener("change", () => {
    if (presetSel.value) reroot(presetSel.value);
    presetSel.value = "";
  });

  head.append(
    el("div", { class: "row", style: "margin-top:10px" }, el("span", { class: "faint", text: "当前根：" }), rootLabel, depthSel, dirSel, resetBtn),
    el("div", { class: "row", style: "margin-top:8px" }, el("span", { class: "faint", text: "入口：" }), presetSel),
    el(
      "div",
      { class: "row", style: "margin-top:8px" },
      el("span", { class: "faint", text: "找路径：" }),
      pathFromInput,
      el("span", { class: "faint", text: "→" }),
      pathToInput,
      traceBtn,
      clearPathBtn,
    ),
    pathToResults,
    pathToResults2,
  );

  // ---------------- 左：文件树 ----------------
  const fileList = el("div", { class: "list" });
  const fileQueryInput = el("input", { type: "search", placeholder: "筛选文件…", style: "width:100%;margin-bottom:8px" }) as HTMLInputElement;
  const left = el(
    "div",
    { class: "pane" },
    paneHead("left"),
    fileQueryInput,
    fileList,
    paneStrip("left"),
  );

  function renderTree(): void {
    clear(fileList);
    const q = fileQuery.trim().toLowerCase();
    fileList.append(
      el(
        "div",
        {
          class: `item${!fileFilter && !groupFilter ? " active" : ""}`,
          onclick: () => {
            fileFilter = "";
            groupFilter = "";
            renderTree();
            void refreshGraph();
          },
        },
        el("div", { class: "name", text: "整库" }),
        el("div", { class: "where", text: "显示全部模块的调用关系" }),
      ),
    );
    for (const g of groups) {
      const items = (byGroup.get(g) ?? []).filter((f) => !q || f.path.toLowerCase().includes(q));
      if (items.length === 0 && !q) {
        // 无符号的空模块也保留分组入口
      }
      const groupActive = groupFilter === g;
      fileList.append(
        el(
          "div",
          {
            class: `item${groupActive ? " active" : ""}`,
            onclick: () => {
              fileFilter = "";
              groupFilter = groupActive ? "" : g;
              renderTree();
              void refreshGraph();
            },
          },
          el("div", { class: "name", text: `${g}/` }),
          el("div", { class: "where", text: `模块整体${groupActive ? "（点击取消）" : ""}` }),
        ),
      );
      for (const f of items) {
        const name = f.path.slice(f.path.lastIndexOf("/") + 1);
        fileList.append(
          el(
            "div",
            {
              class: `item${f.path === fileFilter ? " active" : ""}`,
              style: "margin-left:12px",
              onclick: () => {
                fileFilter = f.path;
                groupFilter = "";
                renderTree();
                void refreshGraph();
              },
            },
            el("div", { class: "name", text: name }),
            el("div", { class: "where", text: `${f.symbols.length} 符号 · ${f.loc} 行` }),
          ),
        );
      }
    }
  }
  fileQueryInput.addEventListener("input", () => {
    fileQuery = fileQueryInput.value;
    renderTree();
  });

  // ---------------- 中：调用图 ----------------
  const center = el("div", { class: "pane center" });
  // 画布按面板像素尺寸建，面板变大变小都要重画，否则缩放会失真
  paneResizeObserver?.disconnect();
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      if (lastPaneW !== center.clientWidth || lastPaneH !== center.clientHeight) drawGraph();
    });
    observer.observe(center);
    paneResizeObserver = observer;
  }
  // ---------------- 右：详情 ----------------
  const detailBox = el("div");
  const right = el("div", { class: "pane" }, paneHead("right"), detailBox, paneStrip("right"));

  panes.left = left;
  panes.right = right;
  root.append(left, center, right);

  // 恢复上次的收起状态；图会由 ResizeObserver 在中间栏变宽后重画
  setPaneCollapsed("left", storedPaneState("left"));
  setPaneCollapsed("right", storedPaneState("right"));

  // ---------------- 数据加载 ----------------
  async function loadGraph(): Promise<void> {
    graph = await api.graph(rootId, depth, direction, 300);
  }

  async function loadDetail(id: string): Promise<void> {
    clear(detailBox);
    detailBox.append(el("p", { class: "loading", text: "加载中…" }));
    try {
      detail = await api.symbol(id);
    } catch (err) {
      clear(detailBox);
      detailBox.append(el("div", { class: "error-box", text: `加载失败：${err instanceof Error ? err.message : String(err)}` }));
      return;
    }
    drawDetail();
  }

  function reroot(id: string): void {
    rootId = id;
    pathState = null;
    pathToResults2.textContent = "";
    pathFromInput.value = id;
    window.history.replaceState(null, "", `#/callgraph?symbol=${encodeURIComponent(id)}&depth=${depth}`);
    void (async () => {
      await loadGraph();
      drawGraph();
      await loadDetail(id);
    })();
  }

  async function refreshGraph(): Promise<void> {
    await loadGraph();
    drawGraph();
  }

  // ---------------- 详情渲染 ----------------
  function neighborList(title: string, items: Neighbor[], empty: string): HTMLElement {
    const box = el("div", { style: "margin-top:12px" });
    box.append(el("h3", { text: title }));
    if (items.length === 0) {
      box.append(el("div", { class: "faint", style: "font-size:12.5px", text: empty }));
      return box;
    }
    const list = el("div", { class: "list" });
    for (const n of items) {
      list.append(
        el(
          "div",
          {
            class: "item",
            onmouseenter: () => highlightNeighbor(n.id),
            onmouseleave: () => clearHighlight(),
            onclick: () => reroot(n.id),
          },
          el("div", { class: "name" }, [
            n.name,
            " ",
            el("span", { class: `pill ${n.confidence}`, text: confLabel(n.confidence) }),
          ]),
          el("div", { class: "where", text: `${n.file}:${n.lineno}${n.count > 1 ? ` · ${n.count} 次` : ""}` }),
        ),
      );
    }
    box.append(list);
    return box;
  }

  function drawDetail(): void {
    clear(detailBox);
    if (!detail) return;
    const s = detail.symbol;
    detailBox.append(
      el("div", { class: "mono", style: "font-size:13.5px;margin-bottom:4px;word-break:break-word" }, [
        s.name,
        " ",
        el("span", { class: `pill ${s.kind}`, text: s.kind }),
      ]),
      el("div", { class: "where mono", style: "margin-bottom:8px" }, [
        el("span", {
          class: "mono",
          style: "cursor:pointer;text-decoration:underline",
          text: `${s.file}:${s.lineno}`,
          onclick: () => ctx.navigate(ctx.sourceRoute(s.file, s.lineno)),
        }),
      ]),
    );
    if (s.signature) detailBox.append(el("pre", { class: "code", style: "max-height:150px;margin-bottom:8px", text: s.signature }));
    if (s.bases?.length) {
      detailBox.append(el("div", { class: "dim", style: "font-size:12.5px", text: `基类：${s.bases.join(", ")}` }));
    }
    if (s.decorators?.length) {
      detailBox.append(el("div", { class: "dim mono", style: "font-size:12px", text: s.decorators.map((d) => `@${d}`).join("  ") }));
    }
    if (s.docstring) {
      detailBox.append(el("p", { class: "dim", style: "font-size:12.5px;white-space:pre-wrap", text: s.docstring }));
    }
    if (s.params.length) {
      const rows = s.params.map((p) =>
        el("tr", {}, el("td", { class: "mono", text: p.name }), el("td", { class: "mono", text: p.annotation || "—" }), el("td", { class: "mono faint", text: p.default || "—" })),
      );
      detailBox.append(
        el("div", { style: "margin-top:10px" }, el("h3", { text: "参数" }),
          el("table", { class: "grid" }, el("thead", {}, el("tr", {}, el("th", { text: "名" }), el("th", { text: "注解" }), el("th", { text: "默认" }))), el("tbody", {}, rows))),
      );
    }
    detailBox.append(neighborList("调用（callees）", detail.callees, "没有解析到下游调用。"));
    detailBox.append(neighborList("被调用（callers）", detail.callers, "没有解析到上游调用。"));
    const un = s.unresolved ?? [];
    const ubox = el("div", { style: "margin-top:12px" }, el("h3", { text: "未解析调用（unresolved）" }));
    ubox.append(el("p", { class: "faint", style: "font-size:12px;margin:0 0 6px", text: "静态分析无法确定目标：可能是动态分派、回调、或被调方在运行时才绑定。" }));
    if (un.length === 0) ubox.append(el("div", { class: "faint", style: "font-size:12.5px", text: "没有未解析调用。" }));
    else {
      const ul = el("div", { class: "list" });
      for (const c of un) {
        ul.append(
          el("div", { class: "item", onclick: () => ctx.navigate(ctx.sourceRoute(s.file, c.line)) },
            el("div", { class: "name", text: c.callee }),
            el("div", { class: "where", text: `${s.file}:${c.line}` }),
            c.text ? el("div", { class: "sig", text: c.text }) : null,
          ),
        );
      }
      ubox.append(ul);
    }
    detailBox.append(ubox);
  }

  // ---------------- 图渲染 ----------------
  function computeLayers(nodes: GraphNode[], edges: { from: string; to: string }[]): string[][] {
    const ids = new Set(nodes.map((n) => n.id));
    const fwd = new Map<string, string[]>();
    const bwd = new Map<string, string[]>();
    for (const e of edges) {
      if (!ids.has(e.from) || !ids.has(e.to)) continue;
      (fwd.get(e.from) ?? fwd.set(e.from, []).get(e.from)!).push(e.to);
      (bwd.get(e.to) ?? bwd.set(e.to, []).get(e.to)!).push(e.from);
    }
    const bfs = (adj: Map<string, string[]>): Map<string, number> => {
      const dist = new Map<string, number>([[rootId, 0]]);
      const queue = [rootId];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const nx of adj.get(cur) ?? []) {
          if (!dist.has(nx)) {
            dist.set(nx, dist.get(cur)! + 1);
            queue.push(nx);
          }
        }
      }
      return dist;
    };
    const down = bfs(fwd);
    const up = bfs(bwd);
    const layerOf = new Map<string, number>();
    for (const n of nodes) {
      const d = down.get(n.id);
      const u = up.get(n.id);
      let v: number;
      if (direction === "down") v = d ?? 0;
      else if (direction === "up") v = -(u ?? 0);
      else {
        const dc = d === undefined ? Infinity : d;
        const uc = u === undefined ? Infinity : u;
        v = dc <= uc ? dc === Infinity ? 0 : dc : -uc;
      }
      layerOf.set(n.id, v);
    }
    const minL = Math.min(...[...layerOf.values()], 0);
    const buckets = new Map<number, GraphNode[]>();
    for (const n of nodes) {
      const l = layerOf.get(n.id)! - minL;
      const list = buckets.get(l) ?? [];
      list.push(n);
      buckets.set(l, list);
    }
    const out: string[][] = [];
    const maxL = Math.max(...buckets.keys(), 0);
    for (let i = 0; i <= maxL; i++) out.push(byGroupThenName(buckets.get(i) ?? []).map((n) => n.id));
    return out;
  }

  function displayGraph(): { nodes: GraphNode[]; edges: Graph["edges"]; truncated: boolean } {
    const base = graph ?? { nodes: [], edges: [], truncated: false };
    let nodes = base.nodes;
    let edges = base.edges;
    if (pathState?.found) {
      const have = new Set(nodes.map((n) => n.id));
      const extra = lastPathNodes.filter((n) => !have.has(n.id));
      nodes = [...nodes, ...extra];
      const ekeys = new Set(edges.map((e) => `${e.from}->${e.to}`));
      const extraEdges = lastPathEdges.filter((e) => !ekeys.has(`${e.from}->${e.to}`));
      edges = [...edges, ...extraEdges];
    }
    if (fileFilter) {
      const nset = new Set(nodes.filter((n) => n.file === fileFilter).map((n) => n.id));
      nodes = nodes.filter((n) => nset.has(n.id));
      edges = edges.filter((e) => nset.has(e.from) && nset.has(e.to));
    } else if (groupFilter) {
      const nset = new Set(nodes.filter((n) => n.group === groupFilter).map((n) => n.id));
      nodes = nodes.filter((n) => nset.has(n.id));
      edges = edges.filter((e) => nset.has(e.from) && nset.has(e.to));
    }
    return { nodes, edges, truncated: base.truncated };
  }

  function drawGraph(): void {
    clear(center);
    const disp = displayGraph();
    const note = el("div", {
      class: "faint mono",
      style: "position:absolute;left:10px;top:8px;font-size:11.5px;z-index:2;background:var(--bg-1);padding:3px 7px;border:1px solid var(--line);border-radius:6px",
      text: `${disp.nodes.length} 节点 · ${disp.edges.length} 边${fileFilter ? ` · 仅 ${fileFilter}` : groupFilter ? ` · 仅 ${groupFilter}` : ""}${disp.truncated ? " · 已截断" : ""}`,
    });
    center.append(note);
    center.append(
      el("div", { class: "legend pane-overlay" }, [
        el("span", {}, [el("i", { style: "background:var(--accent)" }), "左侧色条 = 所属模块"]),
        el("span", {}, [el("i", { style: "background:var(--edge-resolved)" }), "实线 = 静态调用"]),
        el("span", {}, [el("i", { style: "background:var(--edge-inferred)" }), "虚线 = 类型推断"]),
        el("span", {}, [el("i", { style: "background:var(--edge-override)" }), "紫虚线 = 接口实现（非调用）"]),
      ]),
    );
    if (disp.nodes.length === 0) {
      center.append(el("div", { class: "empty", style: "padding-top:80px", text: fileFilter || groupFilter ? "该筛选下没有节点" : "没有可显示的节点" }));
      return;
    }
    const layers = computeLayers(disp.nodes, disp.edges);
    const paneW = Math.max(320, center.clientWidth || CANVAS_FALLBACK_W);
    const paneH = Math.max(260, center.clientHeight || CANVAS_FALLBACK_H);
    lastPaneW = center.clientWidth;
    lastPaneH = center.clientHeight;
    // 层内间距按面板长宽比反算，让图在两个方向上都铺开
    const maxRows = layers.reduce((m, l) => Math.max(m, l.length), 0);
    const w0 = boundsOf(layerLayout(layers, NODE_W, NODE_H, GAP_X, GAP_Y).values(), NODE_W, NODE_H).w;
    const wantH = w0 / (paneW / paneH);
    const gapY = maxRows > 1
      ? Math.min(150, Math.max(12, (wantH - maxRows * NODE_H) / (maxRows - 1)))
      : GAP_Y;
    const pos = layerLayout(layers, NODE_W, NODE_H, GAP_X, gapY);
    const b = boundsOf(pos.values(), NODE_W, NODE_H);
    const pz = makePanZoom(paneW, paneH);
    center.append(pz.node);
    const layer = svg("g");
    pz.node.querySelector(".panzoom-layer")?.append(layer);
    layer.append(
      svg("defs", {},
        svg("marker", { id: "arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" },
          svg("path", { d: "M0,0 L10,5 L0,10 z", style: "fill:var(--edge-resolved)" })),
        svg("marker", { id: "arrow-hl", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" },
          svg("path", { d: "M0,0 L10,5 L0,10 z", style: "fill:var(--edge-hl)" })),
      ),
    );
    const nodeById = new Map(disp.nodes.map((n) => [n.id, n]));

    for (const e of disp.edges) {
      const a = pos.get(e.from);
      const c = pos.get(e.to);
      if (!a || !c) continue;
      const isPath = pathState?.found && pathState.edgeKeys.has(`${e.from}->${e.to}`);
      const cls = `edge ${e.confidence}${isPath ? " hl" : ""}`;
      const p = svg("path", { class: cls, d: edgePath(a, c, e.from === e.to), "data-from": e.from, "data-to": e.to });
      if (isPath) p.setAttribute("style", "marker-end:url(#arrow-hl)");
      p.append(svg("title", { text: `${nodeById.get(e.from)?.name ?? e.from} → ${nodeById.get(e.to)?.name ?? e.to}（${confLabel(e.confidence)}${e.count > 1 ? `，${e.count} 次` : ""}）` }));
      layer.append(p);
    }

    for (const n of disp.nodes) {
      const p = pos.get(n.id);
      if (!p) continue;
      const isRoot = n.id === rootId;
      const onPath = pathState?.found && pathState.nodeIds.has(n.id);
      const g = svg("g", {
        class: `node${isRoot || onPath ? " sel" : ""}`,
        "data-id": n.id,
        transform: `translate(${p.x} ${p.y})`,
        onclick: () => reroot(n.id),
        onmouseenter: () => highlightNeighbor(n.id),
        onmouseleave: () => clearHighlight(),
      });
      g.append(
        svg("rect", { class: "box", width: NODE_W, height: NODE_H }),
        svg("rect", { x: 0, y: 0, width: 4, height: NODE_H, rx: 2, style: `fill:${hashColor(n.group)}` }),
        svg("text", { x: 11, y: 17, text: truncate(n.name, 18) }),
        svg("text", { class: "sub", x: 11, y: 32, text: `${n.kind} · ${n.group}` }),
        svg("title", { text: `${n.id}\n${n.file}:${n.lineno}` }),
      );
      layer.append(g);
    }
    // 缩放不足以容下全图时，以当前根节点为中心显示
    pz.fit(b, pos.get(rootId));
  }

  function highlightNeighbor(id: string): void {
    const disp = displayGraph();
    const reach = new Set<string>([id]);
    const adj = new Map<string, string[]>();
    for (const e of disp.edges) {
      (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
      (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
    }
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nx of adj.get(cur) ?? []) if (!reach.has(nx)) { reach.add(nx); queue.push(nx); }
    }
    const gsvg = center.querySelector("svg");
    if (!gsvg) return;
    for (const g of gsvg.querySelectorAll<SVGGElement>("g.node")) {
      const nid = g.dataset.id ?? "";
      g.classList.toggle("dim", !reach.has(nid));
    }
    for (const p of gsvg.querySelectorAll<SVGPathElement>("path.edge")) {
      const f = p.dataset.from ?? "";
      const t = p.dataset.to ?? "";
      p.classList.toggle("dim", !(reach.has(f) && reach.has(t)));
    }
  }

  function clearHighlight(): void {
    const gsvg = center.querySelector("svg");
    if (!gsvg) return;
    for (const g of gsvg.querySelectorAll("g.node")) g.classList.remove("dim");
    for (const p of gsvg.querySelectorAll("path.edge")) p.classList.remove("dim");
  }

  function edgePath(a: Pt, b: Pt, self: boolean): string {
    const ax = a.x;
    const ay = a.y + NODE_H / 2;
    const bx = b.x;
    const by = b.y + NODE_H / 2;
    if (self) {
      const top = a.y - 6;
      return `M ${ax + NODE_W} ${ay} C ${ax + NODE_W + 70} ${top - 34}, ${ax - 70} ${top - 34}, ${ax} ${ay}`;
    }
    const right = bx >= ax;
    const sx = right ? ax + NODE_W : ax;
    const tx = right ? bx : bx + NODE_W;
    const cx = (sx + tx) / 2;
    return `M ${sx} ${ay} C ${cx} ${ay}, ${cx} ${by}, ${tx} ${by}`;
  }

  // ---------------- 找路径 ----------------
  function setPathResult(msg: string, warn = false): void {
    pathToResults2.className = warn ? "" : "dim";
    pathToResults2.style.color = warn ? "var(--warn)" : "";
    pathToResults2.textContent = msg;
  }

  async function tracePath(): Promise<void> {
    const from = pathFromInput.value.trim() || rootId;
    const to = pathToInput.value.trim();
    if (!to) {
      setPathResult("请先填写目标符号。");
      return;
    }
    setPathResult("查询中…");
    try {
      const res = await api.path(from, to);
      pathState = { from, to, found: res.found, nodeIds: new Set(), edgeKeys: new Set(), hops: [] };
      (globalThis as { __lastPathNodes?: Graph["nodes"] }).__lastPathNodes = res.nodes;
      (globalThis as { __lastPathEdges?: Graph["edges"] }).__lastPathEdges = res.edges;
      if (!res.found) {
        setPathResult(`未找到 ${shortId(from)} → ${shortId(to)} 的静态调用路径。这类情况通常意味着链路跨进程边界，或经过动态分派（回调、注册表、接口多态）。`, true);
        await refreshGraph();
        return;
      }
      const order = chainOrder(res.nodes.map((n) => n.id), res.edges);
      for (const id of order.nodeIds) pathState.nodeIds.add(id);
      for (const e of res.edges) pathState.edgeKeys.add(`${e.from}->${e.to}`);
      pathState.hops = order.ids;
      const hopsBox = el("div", { class: "list" });
      order.ids.forEach((id, i) => {
        const n = res.nodes.find((x) => x.id === id);
        hopsBox.append(
          el("div", { class: "item", onclick: () => reroot(id) },
            el("div", { class: "name", text: `${i + 1}. ${n?.name ?? id}` }),
            el("div", { class: "where", text: `${n?.file ?? ""}:${n?.lineno ?? ""}` }),
          ),
        );
      });
      pathToResults2.className = "dim";
      clear(pathToResults2);
      pathToResults2.append(el("div", { style: "margin-bottom:4px", text: `找到路径，${order.ids.length} 跳：` }), hopsBox);
      await refreshGraph();
    } catch (err) {
      setPathResult(`查询失败：${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  /** 从边集合还原链式顺序 */
  function chainOrder(nodeIds: string[], edges: { from: string; to: string }[]): { ids: string[]; nodeIds: string[] } {
    const next = new Map(edges.map((e) => [e.from, e.to]));
    const targets = new Set(edges.map((e) => e.to));
    const start = nodeIds.find((id) => !targets.has(id)) ?? nodeIds[0];
    if (!start) return { ids: [], nodeIds: [] };
    const ids: string[] = [start];
    const seen = new Set([start]);
    let cur = start;
    while (next.has(cur) && !seen.has(next.get(cur)!)) {
      cur = next.get(cur)!;
      ids.push(cur);
      seen.add(cur);
    }
    return { ids, nodeIds: ids };
  }

  pathToInput.addEventListener("input", () => {
    const q = pathToInput.value.trim();
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    clear(pathToResults);
    if (q.length < 2) return;
    searchTimer = window.setTimeout(() => {
      void api
        .search(q, 8)
        .then((r) => {
          for (const hit of r.items) {
            pathToResults.append(
              el("div", { class: "item", onclick: () => { pathToInput.value = hit.id; clear(pathToResults); } },
                el("div", { class: "name", text: hit.name }),
                el("div", { class: "where", text: `${hit.id} · ${hit.kind}` }),
              ),
            );
          }
        })
        .catch(() => clear(pathToResults));
    }, 200);
  });

  depthSel.addEventListener("change", () => {
    depth = Number(depthSel.value);
    window.history.replaceState(null, "", `#/callgraph?symbol=${encodeURIComponent(rootId)}&depth=${depth}`);
    void refreshGraph();
  });
  dirSel.addEventListener("change", () => {
    direction = dirSel.value;
    void refreshGraph();
  });
  dirSel.value = direction;

  // ---------------- 首次渲染 ----------------
  pathFromInput.value = rootId;
  rootLabel.textContent = shortId(rootId);
  renderTree();
  await loadGraph();
  drawGraph();
  await loadDetail(rootId);
}

function confLabel(confidence: string): string {
  if (confidence === "resolved") return "已解析";
  if (confidence === "inferred") return "推断";
  if (confidence === "override") return "接口实现";
  return confidence;
}

function shortId(id: string): string {
  return id.split(".").slice(-2).join(".");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
