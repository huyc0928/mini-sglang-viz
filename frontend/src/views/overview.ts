// 总览：统计、进程拓扑、模块地图、建议阅读顺序与模块笔记。

import { api } from "../api";
import { el, svg } from "../lib/dom";
import { mountHead } from "../lib/view";
import type { Content, ModuleOut, Stats } from "../types";
import type { View, ViewContext } from "./types";

const TOPO_W = 180;
const TOPO_H = 64;

/** 手工排布的进程拓扑坐标 */
const TOPO_POS: Record<string, { x: number; y: number }> = {
  client: { x: 20, y: 70 },
  api: { x: 220, y: 20 },
  frontend_mgr: { x: 220, y: 140 },
  tokenizer: { x: 500, y: 20 },
  detokenizer: { x: 500, y: 140 },
  sched0: { x: 760, y: 20 },
  schedN: { x: 760, y: 150 },
  engine: { x: 1020, y: 20 },
};

const LINK_COLORS: Record<string, string> = {
  http: "#6aa9ff",
  inproc: "#7ee0c0",
  zmq: "#ffb454",
  nccl: "#c792ea",
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
  root.append(sectionTitle("进程拓扑", "方框是进程或进程内组件，箭头是通信方式。点击带符号的节点可跳到调用链视图。"));
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
  const W = 1240;
  const H = 250;
  const canvas = svg("svg", {
    viewBox: `0 0 ${W} ${H}`,
    style: "width:100%;height:auto;background:var(--bg-1);border:1px solid var(--line);border-radius:10px",
  });
  const defs = svg("defs");
  for (const [kind, color] of Object.entries(LINK_COLORS)) {
    defs.append(
      svg("marker", { id: `topo-${kind}`, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" },
        svg("path", { d: "M0,0 L10,5 L0,10 z", fill: color })),
    );
  }
  canvas.append(defs);

  const posOf = (id: string): { x: number; y: number } => TOPO_POS[id] ?? { x: 20, y: 20 };

  // 同一对节点之间的多条边左右分开
  const pairCount = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const l of topo.links) {
    const k = `${l.from}->${l.to}`;
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
  }
  const linkLayer = svg("g");
  const labelLayer = svg("g");
  for (const l of topo.links) {
    const k = `${l.from}->${l.to}`;
    const total = pairCount.get(k) ?? 1;
    const idx = pairs.get(k) ?? 0;
    pairs.set(k, idx + 1);
    const offset = total > 1 ? (idx - (total - 1) / 2) * 26 : 0;
    const geo = linkGeometry(posOf(l.from), posOf(l.to), offset);
    const color = LINK_COLORS[l.kind] ?? "#3d4759";
    linkLayer.append(
      svg("path", {
        d: geo.d,
        fill: "none",
        stroke: color,
        "stroke-width": l.kind === "nccl" ? 2 : 1.4,
        "stroke-dasharray": l.kind === "inproc" ? "4 3" : l.kind === "nccl" ? "7 4" : undefined,
        "marker-end": `url(#topo-${l.kind})`,
        "data-from": l.from,
        "data-to": l.to,
      }),
    );
    const lines = l.label.split("\n");
    const text = svg("text", { x: geo.mx, y: geo.my, "text-anchor": "middle", style: `fill:${color};font:10.5px var(--mono)` });
    lines.forEach((line, i) => text.append(svg("tspan", { x: geo.mx, dy: i === 0 ? 0 : 11, text: line })));
    labelLayer.append(text);
  }
  canvas.append(linkLayer, labelLayer);

  for (const n of topo.nodes) {
    const p = posOf(n.id);
    const g = svg("g", { class: "node", "data-id": n.id, transform: `translate(${p.x} ${p.y})`, style: n.symbol ? "cursor:pointer" : "" });
    const fill = n.kind === "external" ? "#1b2130" : n.kind === "component" ? "#141922" : "var(--bg-2)";
    const stroke = n.kind === "process" ? "#3d4759" : n.kind === "component" ? "#2a3141" : "#4a5568";
    g.append(
      svg("rect", { class: "box", width: TOPO_W, height: TOPO_H, style: `fill:${fill};stroke:${stroke};stroke-dasharray:${n.kind === "external" ? "5 4" : n.kind === "component" ? "2 3" : "none"}` }),
    );
    const label = n.label.split("\n");
    const t = svg("text", { x: 12, y: 20, style: "font-weight:600" });
    label.forEach((line, i) => t.append(svg("tspan", { x: 12, dy: i === 0 ? 0 : 13, text: line })));
    g.append(t, svg("text", { class: "sub", x: 12, y: TOPO_H - 10, text: truncateText(n.note, 26) }), svg("title", { text: `${n.label.replace(/\n/g, " ")}\n${n.note}${n.symbol ? `\n符号：${n.symbol}` : ""}` }));
    if (n.symbol) g.addEventListener("click", () => ctx.navigate(ctx.graphRoute(n.symbol!, 2)));
    canvas.append(g);
  }
  const legend = el("div", { class: "legend", style: "margin-top:8px" },
    el("span", {}, [el("i", { style: "background:#6aa9ff" }), "HTTP / SSE"]),
    el("span", {}, [el("i", { style: "background:#7ee0c0" }), "进程内调用"]),
    el("span", {}, [el("i", { style: "background:#ffb454" }), "ZMQ ipc"]),
    el("span", {}, [el("i", { style: "background:#c792ea" }), "NCCL 集合通信"]),
  );
  return el("div", {}, canvas, legend);
}

function linkGeometry(a: { x: number; y: number }, b: { x: number; y: number }, offset: number): { d: string; mx: number; my: number } {
  const ca = { x: a.x + TOPO_W / 2, y: a.y + TOPO_H / 2 };
  const cb = { x: b.x + TOPO_W / 2, y: b.y + TOPO_H / 2 };
  let dx = cb.x - ca.x;
  let dy = cb.y - ca.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const tx = dx === 0 ? Infinity : Math.abs(TOPO_W / 2 / dx);
  const ty = dy === 0 ? Infinity : Math.abs(TOPO_H / 2 / dy);
  const s = Math.min(tx, ty);
  const px = -dy;
  const py = dx;
  const start = { x: ca.x + dx * s + px * offset, y: ca.y + dy * s + py * offset };
  const end = { x: cb.x - dx * s + px * offset, y: cb.y - dy * s + py * offset };
  const mid = { x: (start.x + end.x) / 2 + px * offset, y: (start.y + end.y) / 2 + py * offset };
  return { d: `M ${start.x} ${start.y} Q ${mid.x} ${mid.y} ${end.x} ${end.y}`, mx: mid.x, my: mid.y - 4 };
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

function truncateText(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
