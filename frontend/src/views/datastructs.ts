// 数据结构检查器：字段、实例属性、不变式与归属关系。

import { api } from "../api";
import { clear, el, svg } from "../lib/dom";
import { sourceBlock } from "../lib/hl";
import { mountHead } from "../lib/view";
import type { AssertInfo, DataStructOut, SourceLine } from "../types";
import type { View, ViewContext } from "./types";

const KIND_LABEL: Record<string, string> = { dataclass: "dataclass", namedtuple: "namedtuple", class: "class" };

export const datastructsView: View = {
  id: "datastructs",
  title: "数据结构",
  subtitle: "字段、类型、实例属性与不变式，以及归属关系",
  render(ctx) {
    return renderDatastructs(ctx);
  },
};

/** 手工写的断言解释，按「符号 id + 断言原文」索引 */
const ASSERT_NOTES: Record<string, string> = {
  "minisgl.core.Req|assert self.input_ids.is_cpu":
    "输入的 token 必须在 CPU 上：调度器在主机侧维护 input_ids，再由它拷到 GPU；直接传显存张量会破坏这个分工。",
  "minisgl.core.Req|assert 0 <= self.cached_len < self.device_len <= self.max_device_len":
    "三个长度必须保持这个次序：已缓存的部分不能超过当前要算到的位置，当前位置不能超过上限；而且严格小于意味着构造时至少要有一个 token 还没进缓存。",
  "minisgl.distributed.info.DistributedInfo|assert 0 <= self.rank < self.size":
    "rank 是 0 到 size-1 的编号，越界说明进程组信息被写错了。",
  "minisgl.engine.engine.Engine|assert not torch.cuda.is_initialized()":
    "Engine 必须是第一个碰 CUDA 的人：它要在 meta 设备上搭模型、自己算剩余显存来决定页数，所以此前不能有别的代码初始化过 CUDA。",
  "minisgl.layers.attention.AttentionLayer|assert num_qo_heads % num_kv_heads == 0":
    "GQA 要求查询头数是 KV 头数的整数倍，这样一组 KV 头才能被若干个查询头共享。",
  "minisgl.layers.rotary.RotaryEmbedding|assert rotary_dim == head_size":
    "旋转位置编码按完整头维旋转，参数里写死的 rotary_dim 必须等于头的实际宽度。",
  "minisgl.layers.rotary.RotaryEmbedding|assert self.head_size in [64, 128, 256, 512]":
    "只支持这几种头宽，因为旋转的 log 表是按这些尺寸预先算好的。",
  "minisgl.attention.fi.FIMetadata|assert self.page_size == 1, 'Currently only page_size=1 is supported.'":
    "FlashInfer 后端的元数据只支持单 token 页；页大小不为 1 时这里的偏移计算不成立。",
  "minisgl.attention.fi.FIMetadata|assert self.cu_seqlens_k_cpu.is_cpu and self.cu_seqlens_q_cpu.is_cpu and self.cu_seqlens_q_gpu.is_cuda and self.indices.is_cuda and self.last_page_len_cpu.is_cpu and self.seq_lens_cpu.is_cpu":
    "张量必须待在该在的设备上：序列长度这类小张量留在 CPU 给调度器读，KV 位置索引必须在显存里给 kernel 直接用。",
};

function explainAssert(id: string, a: AssertInfo): string {
  const exact = ASSERT_NOTES[`${id}|${a.text}`];
  if (exact) return exact;
  const t = a.text;
  if (a.message) return a.message;
  if (/is not None|!= None/.test(t)) return "这个字段在这里必须已经初始化，否则后面用到它时才会报错、且很难定位。";
  if (/len\([^)]*\)\s*==\s*len\(/.test(t)) return "两边的长度必须一致：它们按位置一一对应，长度不同说明拼装时漏了一项。";
  if (/%|mod/.test(t)) return "这里检查一个整除关系，不整除时按份切分会切不干净。";
  if (/>\s*0|>=\s*0/.test(t)) return "做一个下界检查，避免负数或零进入后续计算。";
  return "构造时就检查一个前提，让不合法的状态不会流到后面的计算里。";
}

async function renderDatastructs(ctx: ViewContext): Promise<void> {
  const { root } = ctx;
  mountHead(root, "数据结构", "左侧是抽取到的 dataclass / namedtuple / class。实例属性的类型由静态分析推断，可能为空或近似，请以右侧源码为准。");
  root.classList.add("split");
  root.style.gridTemplateColumns = "320px 1fr";

  const all = await api.datastructs();
  const byId = new Map(all.map((d) => [d.id, d]));
  const byShort = new Map(all.map((d) => [d.name, d.id]));
  const groupOrder = ["core", "scheduler", "engine", "kvcache", "attention", "models", "layers", "kernel", "server", "tokenizer", "distributed", "message", "moe", "llm", "env", "utils", "benchmark", "other"];
  const byGroup = new Map<string, DataStructOut[]>();
  for (const d of all) {
    const list = byGroup.get(d.group) ?? [];
    list.push(d);
    byGroup.set(d.group, list);
  }
  for (const list of byGroup.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const rank = (g: string): number => { const i = groupOrder.indexOf(g); return i < 0 ? groupOrder.length : i; };
  const groups = [...byGroup.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  let selectedId = ctx.params.get("id") ?? "";
  if (!selectedId || !byId.has(selectedId)) selectedId = all.length ? all[0].id : "";
  let query = "";
  let kindFilter = "";

  const listBox = el("div", { class: "list" });
  const queryInput = el("input", { type: "search", placeholder: "筛选结构名…", style: "width:100%;margin-bottom:8px" }) as HTMLInputElement;
  const kindSel = el("select", { style: "width:100%;margin-bottom:8px" }) as HTMLSelectElement;
  kindSel.append(el("option", { value: "", text: "全部类型" }));
  for (const k of ["dataclass", "namedtuple", "class"]) kindSel.append(el("option", { value: k, text: KIND_LABEL[k] ?? k }));
  const left = el("div", { class: "pane" }, el("h3", { text: "结构列表" }), queryInput, kindSel, listBox);
  const right = el("div", { class: "pane", style: "border-right:0" });
  root.append(left, right);

  function renderList(): void {
    clear(listBox);
    const q = query.trim().toLowerCase();
    for (const g of groups) {
      const items = (byGroup.get(g) ?? []).filter(
        (d) => (!q || d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q)) && (!kindFilter || d.kind === kindFilter),
      );
      if (items.length === 0) continue;
      listBox.append(el("div", { class: "faint mono", style: "margin:8px 0 2px;font-size:11px", text: `${g} · ${items.length}` }));
      for (const d of items) {
        listBox.append(
          el(
            "div",
            { class: `item${d.id === selectedId ? " active" : ""}`, onclick: () => select(d.id) },
            el("div", { class: "name" }, [d.name, " ", el("span", { class: "pill", text: KIND_LABEL[d.kind] ?? d.kind })]),
            el("div", { class: "where", text: `${d.file}:${d.lineno}` }),
          ),
        );
      }
    }
    if (!listBox.firstChild) listBox.append(el("div", { class: "empty", text: "没有匹配的结构" }));
  }

  function select(id: string): void {
    selectedId = id;
    window.history.replaceState(null, "", `#/datastructs?id=${encodeURIComponent(id)}`);
    renderList();
    void renderDetail();
  }

  queryInput.addEventListener("input", () => {
    query = queryInput.value;
    renderList();
  });
  kindSel.addEventListener("change", () => {
    kindFilter = kindSel.value;
    renderList();
  });

  async function renderDetail(): Promise<void> {
    clear(right);
    const d = byId.get(selectedId);
    if (!d) {
      right.append(el("div", { class: "empty", text: "请选择一个结构" }));
      return;
    }
    right.append(
      el("div", { class: "row" }, el("h3", { style: "margin:0;text-transform:none;color:var(--fg);font-size:15px" }, [d.name, " ", el("span", { class: "pill", text: KIND_LABEL[d.kind] ?? d.kind })])),
      el("div", { class: "mono faint", style: "font-size:12px;margin-bottom:8px" }, [
        el("span", { style: "cursor:pointer;text-decoration:underline", text: `${d.file}:${d.lineno}`, onclick: () => ctx.navigate(ctx.sourceRoute(d.file, d.lineno)) }),
      ]),
    );
    if (d.bases.length) right.append(el("div", { class: "dim", style: "font-size:12.5px", text: `继承自：${d.bases.join(", ")}` }));
    if (d.docstring) right.append(el("p", { class: "dim", style: "font-size:12.5px;white-space:pre-wrap", text: d.docstring }));

    right.append(el("h3", { style: "margin-top:14px", text: "字段表" }));
    if (d.fields.length === 0) right.append(el("div", { class: "faint", style: "font-size:12.5px", text: "没有类级注解字段。" }));
    else {
      const rows = d.fields.map((f) =>
        el("tr", { style: f.init ? "" : "color:var(--fg-faint)" },
          el("td", { class: "mono", text: `${f.name}${f.init ? "" : " *"}` }),
          el("td", { class: "mono", text: f.annotation || "—" }),
          el("td", { class: "mono faint", text: f.default || "—" }),
          el("td", { class: "mono", text: f.init ? "是" : "否" }),
          el("td", { class: "mono faint", text: f.origin }),
          el("td", { class: "mono faint", text: String(f.line) }),
        ),
      );
      right.append(
        el("table", { class: "grid" },
          el("thead", {}, el("tr", {}, ["字段", "注解", "默认值", "参与 __init__", "来源", "行"].map((h) => el("th", { text: h })))),
          el("tbody", {}, rows),
        ),
        el("p", { class: "faint", style: "font-size:11.5px;margin:4px 0 0", text: "* 表示类级注解但不进入 __init__，通常是声明式的类型标注或普通类属性。" }),
      );
    }

    right.append(el("h3", { style: "margin-top:14px", text: "实例属性表" }));
    right.append(el("p", { class: "faint", style: "font-size:12px;margin:0 0 6px", text: "这些是在 __init__ 等函数体里对 self 赋值得到的属性；「推断类型」由静态分析从赋值表达式猜出，可能为空或不准确。" }));
    if (d.attrs.length === 0) right.append(el("div", { class: "faint", style: "font-size:12.5px", text: "没有抽取到实例属性。" }));
    else {
      const rows = d.attrs.map((a) =>
        el("tr", {},
          el("td", { class: "mono", text: a.name }),
          el("td", { class: "mono", style: a.type ? "" : "color:var(--fg-faint)", text: a.type || "（推断为空）" }),
          el("td", { class: "mono faint", text: a.value }),
          el("td", { class: "mono faint", text: String(a.line) }),
        ),
      );
      right.append(
        el("table", { class: "grid" },
          el("thead", {}, el("tr", {}, ["属性", "推断类型", "赋值表达式", "行"].map((h) => el("th", { text: h })))),
          el("tbody", {}, rows),
        ),
      );
    }

    right.append(el("h3", { style: "margin-top:14px", text: "不变式" }));
    if (d.asserts.length === 0) right.append(el("div", { class: "faint", style: "font-size:12.5px", text: "没有在 __init__ / __post_init__ 里发现断言。" }));
    else {
      for (const a of d.asserts) {
        right.append(
          el("div", { class: "stepbox" },
            el("pre", { class: "code", style: "max-height:none;margin:0 0 6px;padding:8px", text: a.text }),
            el("p", { style: "margin:0", text: explainAssert(d.id, a) }),
            el("div", { class: "faint mono", style: "font-size:11px", text: `${d.file}:${a.line}` }),
          ),
        );
      }
    }

    right.append(el("h3", { style: "margin-top:16px", text: "归属关系" }));
    right.append(renderOwnership(d, byShort, (id) => select(id)));

    if (d.id === "minisgl.core.Req") {
      right.append(el("h3", { style: "margin-top:18px", text: "Req 生命周期" }));
      right.append(await renderReqLifecycle(ctx));
    }
  }

  renderList();
  await renderDetail();
}

// ---------------- 归属关系图 ----------------

function baseTypeName(text: string): string {
  const cleaned = text.replace(/\[[^\]]*\]/g, "").replace(/["']/g, "").trim();
  const last = cleaned.split(/[.:]/).pop() ?? cleaned;
  return last.trim();
}

function renderOwnership(d: DataStructOut, byShort: Map<string, string>, onSelect: (id: string) => void): HTMLElement {
  const edges: { to: string; kind: "field" | "inherit"; label: string }[] = [];
  const seen = new Set<string>();
  const add = (to: string, kind: "field" | "inherit", label: string): void => {
    const key = `${kind}:${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ to, kind, label });
  };
  for (const f of d.fields) {
    const t = baseTypeName(f.annotation);
    const id = byShort.get(t);
    if (id && id !== d.id) add(id, "field", `${f.name}: ${t}`);
  }
  for (const a of d.attrs) {
    const t = baseTypeName(a.type);
    const id = byShort.get(t);
    if (id && id !== d.id) add(id, "field", `${a.name}: ${t}`);
  }
  for (const b of d.bases) {
    const t = baseTypeName(b);
    const id = byShort.get(t);
    if (id && id !== d.id) add(id, "inherit", "继承");
  }

  if (edges.length === 0) {
    return el("div", { class: "faint", style: "font-size:12.5px", text: "在这个结构里没有发现指向其他已抽取结构的字段类型，也没有已抽取的基类。" });
  }

  const W = 620;
  const H = 330;
  const cx = W / 2;
  const cy = H / 2;
  const r = 118;
  const canvas = svg("svg", { viewBox: `0 0 ${W} ${H}`, style: "width:100%;height:auto;background:var(--bg-1);border:1px solid var(--line);border-radius:10px" });
  canvas.append(
    svg("defs", {},
      svg("marker", { id: "own-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" }, svg("path", { d: "M0,0 L10,5 L0,10 z", fill: "#3d4759" })),
      svg("marker", { id: "own-arrow-i", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" }, svg("path", { d: "M0,0 L10,5 L0,10 z", fill: "#c792ea" })),
    ),
  );
  const posOf = new Map<string, { x: number; y: number }>();
  posOf.set(d.id, { x: cx, y: cy });
  edges.forEach((e, i) => {
    const ang = (i / edges.length) * Math.PI * 2 - Math.PI / 2;
    posOf.set(e.to, { x: cx + r * Math.cos(ang) * 1.5, y: cy + r * Math.sin(ang) });
  });

  for (const e of edges) {
    const p = posOf.get(e.to)!;
    const solid = e.kind === "field";
    const path = svg("path", {
      d: `M ${cx} ${cy} Q ${(cx + p.x) / 2 + 20} ${(cy + p.y) / 2 - 20} ${p.x} ${p.y}`,
      fill: "none",
      stroke: solid ? "#3d4759" : "#c792ea",
      "stroke-width": solid ? 1.4 : 1.6,
      "stroke-dasharray": solid ? undefined : "4 3",
      "marker-end": solid ? "url(#own-arrow)" : "url(#own-arrow-i)",
    }, svg("title", { text: e.label }));
    canvas.append(path);
  }

  const drawNode = (id: string, name: string, center: boolean): void => {
    const p = posOf.get(id)!;
    const w = 148;
    const h = 32;
    const g = svg("g", { class: `node${center ? " sel" : ""}`, transform: `translate(${p.x - w / 2} ${p.y - h / 2})`, style: center ? "" : "cursor:pointer" });
    g.append(svg("rect", { class: "box", width: w, height: h }), svg("text", { x: 10, y: 20, text: name.length > 18 ? `${name.slice(0, 17)}…` : name }));
    if (!center) g.addEventListener("click", () => onSelect(id));
    canvas.append(g);
  };
  drawNode(d.id, d.name, true);
  for (const e of edges) {
    const t = e.to;
    const name = t.split(".").pop() ?? t;
    drawNode(t, name, false);
  }

  return el("div", {},
    canvas,
    el("div", { class: "legend", style: "margin-top:6px" },
      el("span", {}, [el("i", { style: "background:#3d4759" }), "实线：持有该类型的字段"]),
      el("span", {}, [el("i", { style: "background:#c792ea" }), "紫虚线：继承（inherits-from）"]),
    ),
  );
}

// ---------------- Req 生命周期 ----------------

async function renderReqLifecycle(ctx: ViewContext): Promise<HTMLElement> {
  const wrap = el("div");
  const desc = el("p", { class: "dim", style: "font-size:12.5px", text: "拖动三个长度，看不变式与阶段怎么变。三个字段的次序不变式来自 Req.__post_init__；complete_one 就是每轮 decode 前调用的那个方法。" });
  wrap.append(desc);

  let cached = 12;
  let device = 12;
  let maxLen = 16;
  let chunked = false;

  const cachedRange = el("input", { type: "range", min: "0", max: "15", value: "12" }) as HTMLInputElement;
  const deviceRange = el("input", { type: "range", min: "1", max: "16", value: "12" }) as HTMLInputElement;
  const maxRange = el("input", { type: "range", min: "1", max: "40", value: "16" }) as HTMLInputElement;
  const chunkToggle = el("input", { type: "checkbox" }) as HTMLInputElement;
  const readout = el("div");
  const codeBox = el("div", { style: "margin-top:10px" });

  const slider = (label: string, range: HTMLInputElement, hint: string): HTMLElement =>
    el("div", { class: "row", style: "margin-bottom:4px" },
      el("span", { class: "faint mono", style: "flex:0 0 128px;font-size:12px", text: label }),
      range,
      el("span", { class: "faint", style: "font-size:11.5px", text: hint }),
    );

  function clamp(): void {
    maxLen = Math.max(maxLen, device);
    device = Math.min(Math.max(device, cached + 1), maxLen);
    cached = Math.min(Math.max(cached, 0), device - 1);
    cachedRange.max = String(device - 1 || 0);
    deviceRange.min = String(cached + 1);
    deviceRange.max = String(maxLen);
    cachedRange.value = String(cached);
    deviceRange.value = String(device);
    maxRange.value = String(maxLen);
  }

  function evaluate(): void {
    clamp();
    const remain = maxLen - device;
    const extend = device - cached;
    const canDecode = remain > 0;
    const ok = 0 <= cached && cached < device && device <= maxLen;
    let phase: string;
    let phaseNote: string;
    if (!canDecode) {
      phase = "finished";
      phaseNote = "remain_len 已为 0，不能再 decode，请求结束。";
    } else if (chunked) {
      phase = "chunked";
      phaseNote = "ChunkedReq 的 can_decode 恒为假，本轮不算输出、不采样，下一轮接着往前推。";
    } else if (extend > 0) {
      phase = "prefill";
      phaseNote = "device_len 大于 cached_len，本轮要把这段新输入算进 KV，属于 prefill。";
    } else {
      phase = "decode";
      phaseNote = "cached_len 已追上 device_len，每轮只算一个新 token，属于 decode。";
    }
    clear(readout);
    readout.append(
      el("div", { class: "kv", style: "margin-bottom:8px" },
        el("dt", { text: "阶段" }),
        el("dd", {}, el("span", { class: `pill ${ok ? "resolved" : "inferred"}`, text: phase })),
        el("dt", { text: "remain_len" }),
        el("dd", { text: `${remain}（device_len 到 max_device_len 的剩余空间）` }),
        el("dt", { text: "extend_len" }),
        el("dd", { text: `${extend}（device_len - cached_len，本轮要算的长度）` }),
        el("dt", { text: "can_decode" }),
        el("dd", { text: canDecode ? "True" : "False" }),
        el("dt", { text: "不变式" }),
        el("dd", { style: ok ? "color:var(--accent-2)" : "color:var(--danger)", text: ok ? "0 <= cached_len < device_len <= max_device_len 通过" : "不变式被破坏：0 <= cached_len < device_len <= max_device_len 失败" }),
      ),
      el("p", { class: "faint", style: "font-size:12px;margin:0 0 8px", text: phaseNote }),
    );
  }

  cachedRange.addEventListener("input", () => {
    cached = Number(cachedRange.value);
    evaluate();
  });
  deviceRange.addEventListener("input", () => {
    device = Number(deviceRange.value);
    evaluate();
  });
  maxRange.addEventListener("input", () => {
    maxLen = Number(maxRange.value);
    evaluate();
  });
  chunkToggle.addEventListener("change", () => {
    chunked = chunkToggle.checked;
    evaluate();
  });
  const stepBtn = el("button", {
    class: "btn",
    text: "调用 complete_one()",
    onclick: () => {
      cached = device;
      device = device + 1;
      if (device > maxLen) maxLen = device;
      evaluate();
    },
  });
  const resetBtn = el("button", { class: "btn", text: "重置", onclick: () => { cached = 12; device = 12; maxLen = 16; evaluate(); } });

  wrap.append(
    slider("max_device_len", maxRange, "输入长度 + 最大输出长度"),
    slider("device_len", deviceRange, "当前要算到的位置"),
    slider("cached_len", cachedRange, "已经写进 KV 缓存的部分"),
    el("div", { class: "row", style: "margin:6px 0" }, el("label", { class: "row tight", style: "cursor:pointer" }, chunkToggle, el("span", { class: "faint", style: "font-size:12px", text: "按 ChunkedReq 处理（长 prompt 被切块）" })), stepBtn, resetBtn),
    readout,
    codeBox,
  );

  evaluate();

  // 真实代码：Req 的方法与 __post_init__
  try {
    const [req, chunk] = await Promise.all([
      api.symbol("minisgl.core.Req"),
      api.symbol("minisgl.scheduler.prefill.ChunkedReq"),
    ]);
    const render = (lines: SourceLine[], path: string, focus: [number, number]): void => {
      codeBox.append(sourceBlock(lines, path, { highlight: [focus], onLineClick: (n) => ctx.navigate(ctx.sourceRoute(path, n)) }));
    };
    if (req.source) {
      codeBox.append(el("div", { class: "faint mono", style: "font-size:11.5px;margin-top:6px", text: `minisgl/core.py:${req.source.start}-${req.source.end}` }));
      render(req.source.lines, req.symbol.file, [38, 61]);
    }
    if (chunk.source) {
      codeBox.append(el("div", { class: "faint mono", style: "font-size:11.5px;margin-top:10px", text: `${chunk.symbol.file}:${chunk.symbol.lineno}` }));
      render(chunk.source.lines, chunk.symbol.file, [chunk.symbol.lineno, chunk.symbol.end_lineno]);
    }
  } catch {
    codeBox.append(el("div", { class: "faint", text: "源码加载失败。" }));
  }

  return wrap;
}
