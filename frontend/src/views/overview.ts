// 总览：统计、进程拓扑、模块地图、建议阅读顺序与模块笔记。

import { api } from "../api";
import { el, svg } from "../lib/dom";
import { mountHead } from "../lib/view";
import type { Content, ModuleOut, Stats } from "../types";
import type { View, ViewContext } from "./types";

const TOPO_W = 196;
const TOPO_H = 62;

/** 手工排布的进程拓扑坐标 */
const TOPO_POS: Record<string, { x: number; y: number }> = {
  client: { x: 16, y: 66 },
  api: { x: 252, y: 14 },
  frontend_mgr: { x: 252, y: 138 },
  tokenizer: { x: 540, y: 14 },
  detokenizer: { x: 540, y: 138 },
  sched0: { x: 820, y: 14 },
  schedN: { x: 820, y: 138 },
  engine: { x: 1090, y: 14 },
};

/** 节点标题：只留名字，副标题与说明走 tooltip 与下方列表 */
const NODE_TITLE: Record<string, string> = {
  client: "客户端",
  api: "API Server",
  frontend_mgr: "FrontendManager",
  tokenizer: "tokenize worker",
  detokenizer: "detokenizer worker",
  sched0: "Scheduler rank0",
  schedN: "Scheduler rank1..N-1",
  engine: "Engine",
};

const KIND_LABEL: Record<string, string> = {
  external: "外部",
  process: "进程",
  component: "进程内组件",
};

export const overviewView: View = {
  id: "overview",
  title: "总览",
  subtitle: "进程拓扑、模块地图与建议阅读顺序",
  render(ctx) {
    return renderOverview(ctx);
  },
};

async function renderOverview(ctx: ViewContext): Promise<void> {
  const { root } = ctx;
  mountHead(root, "总览", "数字来自对 mini-sglang 源码的静态抽取；「推断」类数字由类型信息或调用链间接得出，不是逐行实测。");

  const [ov, content] = await Promise.all([api.overview(), api.content()]);
  renderStats(root, ov.stats);
  root.append(sectionTitle("进程拓扑", "方框是进程或进程内组件，箭头是通信方式。每条边的完整说明在图下方按编号列出，鼠标移上去两边一起高亮；点带符号的节点跳到调用链视图。"));
  root.append(renderTopology(content, ctx));
  root.append(sectionTitle("模块地图", "每个模块的代码量、入边与出边数量。点击卡片按模块筛选调用图。"));
  root.append(renderModules(ov.modules, ov.group_edges, ctx));
  root.append(sectionTitle("建议阅读顺序", "按这六遍读，先建立整体印象，再逐层深入。带符号的步骤可以点进调用链。"));
  root.append(renderReadingOrder(content, ctx));
  root.append(sectionTitle("模块笔记", "每个模块一句话定位、入口文件与读的时候要注意的点。"));
  root.append(renderModuleNotes(content, ctx));
}

function sectionTitle(title: string, hint: string): HTMLElement {
  return el("div", { style: "margin:22px 0 10px" }, el("h3", { style: "text-transform:none;font-size:14px;color:var(--fg);letter-spacing:0", text: title }), el("p", { class: "faint", style: "margin:2px 0 0;font-size:12.5px", text: hint }));
}

function renderStats(root: HTMLElement, s: Stats): void {
  const kernels = s.csrc_symbols + s.triton_symbols;
  const primary: [string, string | number][] = [
    ["符号", s.symbols],
    ["调用边", s.edges],
    ["Python 行数", s.py_loc],
    ["模块", s.modules],
    ["数据结构", s.datastructs],
    ["算子", kernels],
  ];
  const row = el("div", { class: "stat-row" });
  for (const [label, value] of primary) row.append(el("div", { class: "stat", title: "静态抽取自源码" }, el("b", { text: String(value) }), el("span", { text: label })));
  root.append(row);

  const inferred = el("div", { class: "faint", style: "font-size:12.5px;margin-bottom:6px" }, [
    el("span", { text: "静态解析到的调用边 " }),
    el("b", { class: "mono", text: String(s.resolved_edges) }),
    el("span", { text: "；经字段类型推断出的边 " }),
    el("b", { class: "mono", text: String(s.inferred_edges) }),
    el("span", { text: "（推断，非直接可见）；未解析调用 " }),
    el("b", { class: "mono", text: String(s.unresolved_calls) }),
    el("span", { text: "；外部库调用 " }),
    el("b", { class: "mono", text: String(s.external_calls) }),
    el("span", { text: "。" }),
  ]);
  root.append(inferred);
  root.append(el("div", { class: "faint mono", style: "font-size:12px", text: `${s.py_files} 个 Python 文件 · ${s.classes} 类 · ${s.functions} 函数 · ${s.methods} 方法` }));
}

function renderTopology(content: Content, ctx: ViewContext): HTMLElement {
  const topo = content.process_topology;
  const W = 1310;
  const H = 216;
  const canvas = svg("svg", {
    viewBox: `0 0 ${W} ${H}`,
    style: "width:100%;height:auto;background:var(--bg-1);border:1px solid var(--line);border-radius:10px",
  });
  const defs = svg("defs");
  for (const kind of ["http", "inproc", "zmq", "nccl"]) {
    defs.append(
      svg("marker", { id: `topo-${kind}`, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" },
        svg("path", { d: "M0,0 L10,5 L0,10 z", style: `fill:var(--k-${kind})` })),
    );
  }
  canvas.append(defs);

  const posOf = (id: string): { x: number; y: number } => TOPO_POS[id] ?? { x: 16, y: 16 };
  const boxOf = (id: string) => ({ x: posOf(id).x, y: posOf(id).y, w: TOPO_W, h: TOPO_H });

  // 同一对节点之间的多条边沿法线左右分开
  const pairTotal = new Map<string, number>();
  for (const l of topo.links) {
    const k = `${l.from}->${l.to}`;
    pairTotal.set(k, (pairTotal.get(k) ?? 0) + 1);
  }
  const pairSeen = new Map<string, number>();

  const linkLayer = svg("g");
  const badgeLayer = svg("g");
  const edges: { g: SVGGElement; row: HTMLElement }[] = [];

  topo.links.forEach((l, i) => {
    const k = `${l.from}->${l.to}`;
    const total = pairTotal.get(k) ?? 1;
    const idx = pairSeen.get(k) ?? 0;
    pairSeen.set(k, idx + 1);
    const offset = total > 1 ? (idx - (total - 1) / 2) * 30 : 0;
    const geo = linkGeometry(boxOf(l.from), boxOf(l.to), offset);
    const color = `var(--k-${l.kind}, var(--edge-resolved))`;

    const g = svg("g", { class: "topo-edge" });
    g.append(
      svg("path", {
        d: geo.d,
        fill: "none",
        stroke: color,
        "stroke-width": l.kind === "nccl" ? 2 : 1.5,
        "stroke-dasharray": l.kind === "inproc" ? "4 3" : l.kind === "nccl" ? "7 4" : undefined,
        "marker-end": `url(#topo-${l.kind})`,
      }),
      svg("path", { d: geo.d, fill: "none", stroke: "transparent", "stroke-width": 14 }),
      svg("title", { text: `${nodeName(l.from)} → ${nodeName(l.to)}\n${l.label.replace(/\n/g, " ")}` }),
    );
    linkLayer.append(g);

    // 边上的徽标只放编号，完整文字在图下方的列表里
    const badge = svg("g", { class: "topo-badge", transform: `translate(${geo.mx} ${geo.my})` },
      svg("circle", { r: 9 }),
      svg("text", { x: 0, y: 3.4, "text-anchor": "middle", text: String(i + 1) }),
    );
    badgeLayer.append(badge);

    const row = el("div", { class: "topo-row", title: l.label.replace(/\n/g, " ") },
      el("span", { class: "idx", text: String(i + 1) }),
      el("span", {}, [
        el("span", { class: "pair", text: `${nodeName(l.from)} → ${nodeName(l.to)}` }),
        el("span", { class: "desc", text: `　${l.label.replace(/\n/g, " · ")}` }),
      ]),
    );
    const on = () => {
      g.classList.add("on");
      row.classList.add("on");
    };
    const off = () => {
      g.classList.remove("on");
      row.classList.remove("on");
    };
    g.addEventListener("pointerenter", on);
    g.addEventListener("pointerleave", off);
    row.addEventListener("pointerenter", on);
    row.addEventListener("pointerleave", off);
    edges.push({ g, row });
  });
  canvas.append(linkLayer, badgeLayer);

  for (const n of topo.nodes) {
    const p = posOf(n.id);
    const g = svg("g", {
      class: `node topo-node ${n.kind}`,
      "data-id": n.id,
      transform: `translate(${p.x} ${p.y})`,
      style: n.symbol ? "cursor:pointer" : "",
    });
    g.append(svg("rect", { class: "box topo-box", width: TOPO_W, height: TOPO_H }));
    g.append(
      svg("text", { class: "topo-title", x: 13, y: 26, text: NODE_TITLE[n.id] ?? n.label.replace(/\n/g, " ") }),
      svg("text", { class: "topo-kind", x: 13, y: 46, text: KIND_LABEL[n.kind] ?? n.kind }),
      // 有符号的节点加一个可点的记号，省掉一行说明文字
      ...(n.symbol ? [svg("text", { class: "topo-bullet", x: TOPO_W - 13, y: 46, "text-anchor": "end", text: "点击查看 →" })] : []),
      svg("title", { text: `${n.label.replace(/\n/g, " ")}\n${n.note}${n.symbol ? `\n符号：${n.symbol}` : ""}` }),
    );
    if (n.symbol) g.addEventListener("click", () => ctx.navigate(ctx.graphRoute(n.symbol!, 2)));
    canvas.append(g);
  }

  const legend = el("div", { class: "legend", style: "margin-top:8px" },
    el("span", {}, [el("i", { style: "background:var(--k-http)" }), "HTTP / SSE"]),
    el("span", {}, [el("i", { style: "background:var(--k-inproc)" }), "进程内调用"]),
    el("span", {}, [el("i", { style: "background:var(--k-zmq)" }), "ZMQ ipc"]),
    el("span", {}, [el("i", { style: "background:var(--k-nccl)" }), "NCCL 集合通信"]),
  );
  const list = el("div", { class: "topo-list" }, edges.map((e) => e.row));
  return el("div", {}, canvas, legend, list);
}

function nodeName(id: string): string {
  return NODE_TITLE[id] ?? id;
}

function linkGeometry(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  offset: number,
): { d: string; mx: number; my: number } {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  let dx = cb.x - ca.x;
  let dy = cb.y - ca.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const tx = dx === 0 ? Infinity : Math.abs(a.w / 2 / dx);
  const ty = dy === 0 ? Infinity : Math.abs(a.h / 2 / dy);
  const s = Math.min(tx, ty);
  const px = -dy;
  const py = dx;
  const start = { x: ca.x + dx * s + px * offset, y: ca.y + dy * s + py * offset };
  const end = { x: cb.x - dx * s + px * offset, y: cb.y - dy * s + py * offset };
  const mid = { x: (start.x + end.x) / 2 + px * offset, y: (start.y + end.y) / 2 + py * offset };
  return { d: `M ${start.x} ${start.y} Q ${mid.x} ${mid.y} ${end.x} ${end.y}`, mx: mid.x, my: mid.y };
}

function renderModules(
  modules: ModuleOut[],
  groupEdges: { group: string; symbols: number; out_edges: number; in_edges: number }[],
  ctx: ViewContext,
): HTMLElement {
  const edgeOf = new Map(groupEdges.map((g) => [g.group, g]));
  const cards = el("div", { class: "cards" });
  for (const m of [...modules].sort((a, b) => b.loc - a.loc)) {
    const e = edgeOf.get(m.name);
    cards.append(
      el("div", { class: "card", style: "cursor:pointer", onclick: () => ctx.navigate(`callgraph?group=${encodeURIComponent(m.name)}`) },
        el("h4", {}, [m.name, " ", el("span", { class: "pill", text: `${m.files.length} 文件` })]),
        el("p", { text: m.description || "（无描述）" }),
        el("div", { class: "row tight" },
          el("span", { class: "pill", text: `${m.loc} 行` }),
          el("span", { class: "pill", text: `${e?.symbols ?? 0} 符号` }),
          el("span", { class: "pill resolved", text: `出 ${e?.out_edges ?? 0}` }),
          el("span", { class: "pill inferred", text: `入 ${e?.in_edges ?? 0}` }),
        ),
        el("div", { class: "faint mono", style: "margin-top:6px;font-size:11px", text: m.path_hint }),
      ),
    );
  }
  return cards;
}

function renderReadingOrder(content: Content, ctx: ViewContext): HTMLElement {
  const wrap = el("div", { class: "list" });
  for (const path of content.reading_order) {
    const steps = el("div", { style: "margin-top:8px" });
    path.steps.forEach((s, i) => {
      const row = el("div", { class: "row", style: "align-items:baseline;margin-bottom:5px" },
        el("span", { class: "faint mono", style: "flex:0 0 22px", text: `${i + 1}.` }),
      );
      if (s.symbol) {
        row.append(el("button", { class: "btn", style: "text-align:left", text: s.label, onclick: () => ctx.navigate(ctx.graphRoute(s.symbol!, 2)) }));
      } else {
        row.append(el("span", { text: s.label }));
      }
      if (s.hint) row.append(el("span", { class: "faint", style: "font-size:12px", text: s.hint }));
      steps.append(row);
    });
    wrap.append(
      el("div", { class: "card" }, el("h4", { text: path.title }), el("p", { text: path.goal }), steps),
    );
  }
  return wrap;
}

function renderModuleNotes(content: Content, ctx: ViewContext): HTMLElement {
  const wrap = el("div", { class: "cards" });
  for (const [name, note] of Object.entries(content.module_notes)) {
    const chips = el("div", { class: "row tight", style: "margin-top:6px" });
    if (note.key_symbols.length === 0) chips.append(el("span", { class: "faint", text: "（没有列出的关键符号）" }));
    for (const sym of note.key_symbols) {
      chips.append(
        el("button", { class: "btn", style: "font:11px var(--mono);padding:3px 8px", text: sym.split(".").slice(-2).join("."), title: sym, onclick: () => ctx.navigate(ctx.graphRoute(sym, 2)) }),
      );
    }
    const details = el("details", { class: "card" },
      el("summary", { style: "cursor:pointer" }, [el("b", { text: name }), el("span", { class: "faint", text: ` · ${note.entry}` })]),
      el("p", { style: "margin-top:8px", text: note.role }),
      el("ul", { style: "margin:0;padding-left:18px" },
        note.notes.map((n) => el("li", { class: "dim", style: "font-size:12.5px;margin-bottom:3px", text: n })),
      ),
      chips,
    );
    wrap.append(details);
  }
  return wrap;
}
