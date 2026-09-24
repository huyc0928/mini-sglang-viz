// 时序回放：把 flows.json 里的流程画成时序图，逐步播放并定位到真实源码。

import { api } from "../api";
import { clear, el, svg } from "../lib/dom";
import { focusInto, sourceBlock } from "../lib/hl";
import { mountHead } from "../lib/view";
import type { Content, Flow, SymbolDetail } from "../types";
import type { View, ViewContext } from "./types";

const ROW_H = 38;
const TOP = 42;
const ACTOR_H = 30;
const MARGIN = 80;

let playTimer: number | undefined;

export const sequenceView: View = {
  id: "sequence",
  title: "时序回放",
  subtitle: "分步走完请求生命周期等流程，每步定位到源码",
  render(ctx) {
    return renderSequence(ctx);
  },
  destroy() {
    if (playTimer !== undefined) {
      window.clearInterval(playTimer);
      playTimer = undefined;
    }
  },
};

async function renderSequence(ctx: ViewContext): Promise<void> {
  const { root } = ctx;
  mountHead(root, "时序回放", "选择一条流程，用「下一步」逐步走。每一步都对应源码里的一处调用，右侧给出该符号的真实代码。");

  const content: Content = await api.content();
  const flows = content.flows;
  let flow: Flow = flows.find((f) => f.id === ctx.params.get("flow")) ?? flows[0];
  let step = Math.max(0, Math.min(flow.steps.length - 1, Number(ctx.params.get("step") ?? "0") || 0));

  const detailCache = new Map<string, SymbolDetail | null>();

  // 流程选择做成下拉 + 一行摘要，比一排卡片省下两百多像素的纵向空间
  const flowSel = el("select", { style: "max-width:420px" }) as HTMLSelectElement;
  const flowSummary = el("div", { class: "dim", style: "font-size:12.5px;margin-top:6px;max-width:100ch" });
  const timeline = el("div", { class: "timeline" });
  const diagramBox = el("div", { class: "diagram-frame tall" });
  const stepBox = el("div", { style: "margin-top:14px" });
  const sourceBox = el("div", { style: "margin-top:10px" });

  const prevBtn = el("button", { class: "btn", text: "上一步", onclick: () => go(step - 1) });
  const nextBtn = el("button", { class: "btn primary", text: "下一步", onclick: () => go(step + 1) });
  const playBtn = el("button", { class: "btn", text: "播放", onclick: () => togglePlay() });
  const jumpInput = el("input", { type: "number", min: "1", style: "width:88px" }) as HTMLInputElement;
  const jumpBtn = el("button", { class: "btn", text: "跳转", onclick: () => go(Number(jumpInput.value) - 1) });

  flowSel.addEventListener("change", () => {
    const f = flows.find((x) => x.id === flowSel.value);
    if (f) selectFlow(f);
  });

  const controls = el("div", { class: "row", style: "margin:10px 0" }, prevBtn, nextBtn, playBtn, el("span", { class: "faint", text: "跳到第" }), jumpInput, el("span", { class: "faint", text: "步" }), jumpBtn);

  root.append(el("div", { class: "row" }, el("span", { class: "faint", text: "流程：" }), flowSel), flowSummary, controls, timeline, diagramBox, stepBox, sourceBox);

  function renderFlowCards(): void {
    clear(flowSel);
    for (const f of flows) {
      flowSel.append(el("option", { value: f.id, text: `${f.title}（${f.steps.length} 步 · ${f.actors.length} 角色）` }));
    }
    flowSel.value = flow.id;
    clear(flowSummary);
    flowSummary.append(
      el("span", { text: flow.summary }),
    );
  }

  function selectFlow(f: Flow): void {
    flow = f;
    step = 0;
    stopPlay();
    window.history.replaceState(null, "", `#/sequence?flow=${encodeURIComponent(f.id)}&step=0`);
    renderFlowCards();
    render();
  }

  function go(i: number): void {
    if (i < 0 || i >= flow.steps.length) {
      stopPlay();
      return;
    }
    step = i;
    jumpInput.value = String(step + 1);
    window.history.replaceState(null, "", `#/sequence?flow=${encodeURIComponent(flow.id)}&step=${step}`);
    render();
  }

  function togglePlay(): void {
    if (playTimer !== undefined) {
      stopPlay();
      return;
    }
    playBtn.textContent = "暂停";
    playTimer = window.setInterval(() => {
      if (step >= flow.steps.length - 1) {
        stopPlay();
        return;
      }
      go(step + 1);
    }, 1200);
  }

  function stopPlay(): void {
    if (playTimer !== undefined) {
      window.clearInterval(playTimer);
      playTimer = undefined;
    }
    playBtn.textContent = "播放";
  }

  function renderTimeline(): void {
    clear(timeline);
    flow.steps.forEach((_, i) => {
      const cls = i === step ? "cur" : i < step ? "done" : "";
      timeline.append(el("button", { class: cls, text: String(i + 1), title: `第 ${i + 1} 步`, onclick: () => go(i) }));
    });
  }

  function renderDiagram(): void {
    clear(diagramBox);
    const actors = flow.actors;
    const width = Math.max(880, actors.length * 150);
    const height = TOP + ACTOR_H + 20 + flow.steps.length * ROW_H + 30;
    const xs = actors.map((_, i) => (actors.length === 1 ? width / 2 : MARGIN + (i * (width - 2 * MARGIN)) / (actors.length - 1)));
    const idx = new Map(actors.map((a, i) => [a, i]));
    // 尺寸只由流程决定，与当前步无关；放在固定框里缩放铺满，播放时不会移动
    const canvas = svg("svg", {
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: "xMidYMid meet",
    });
    canvas.append(
      svg("defs", {}, svg("marker", { id: "arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" },
        svg("path", { d: "M0,0 L10,5 L0,10 z", style: "fill:var(--edge-resolved)" }))),
    );

    // 角色框与生命线
    actors.forEach((a, i) => {
      const g = svg("g", { class: "seq-actor", transform: `translate(${xs[i] - 66} 10)` });
      g.append(svg("rect", { width: 132, height: ACTOR_H }), svg("text", { x: 66, y: 20, "text-anchor": "middle", text: a }));
      canvas.append(g);
      canvas.append(svg("line", { class: "seq-life", x1: xs[i], y1: 40, x2: xs[i], y2: height - 10 }));
    });

    flow.steps.forEach((s, i) => {
      const y = TOP + ACTOR_H + 34 + i * ROW_H;
      const fi = idx.get(s.from);
      const ti = idx.get(s.to);
      const state = i === step ? " cur" : i < step ? " done" : "";
      if (fi === undefined || ti === undefined) return;
      const x1 = xs[fi];
      const x2 = xs[ti];
      const g = svg("g", { class: `seq-msg${state}` });
      if (fi === ti) {
        const d = `M ${x1} ${y} C ${x1 + 68} ${y - 26}, ${x1 + 68} ${y + 20}, ${x1} ${y + 20}`;
        const stroke = i === step ? "var(--edge-hl)" : i < step ? "var(--fg-faint)" : "var(--edge-resolved)";
        const sw = i === step ? 2.4 : 1.4;
        g.append(svg("path", { d, fill: "none", "marker-end": "url(#arrow)", style: `stroke:${stroke};stroke-width:${sw}` }));
        g.append(svg("text", { x: x1 + 78, y: y + 2, text: s.label }));
      } else {
        g.append(svg("line", { x1, y1: y, x2, y2: y }));
        g.append(svg("text", { x: (x1 + x2) / 2, y: y - 7, "text-anchor": "middle", text: s.label }));
        const bx = x1 + (x2 > x1 ? 15 : -15);
        const badge = svg("g", { transform: `translate(${bx} ${y + 14})` });
        badge.append(svg("circle", { class: "badge", r: 9 }), svg("text", { class: "badge-num", y: 3.5, "text-anchor": "middle", style: "font:10px var(--mono)", text: String(i + 1) }));
        g.append(badge);
      }
      g.append(svg("title", { text: `${i + 1}. ${s.from} → ${s.to}：${s.label}` }));
      g.addEventListener("click", () => go(i));
      canvas.append(g);
    });

    diagramBox.append(canvas);
  }

  async function renderStep(): Promise<void> {
    clear(stepBox);
    const s = flow.steps[step];
    if (!s) return;
    const badge = el("div", { class: "stepbox" },
      el("h4", { text: `第 ${step + 1} / ${flow.steps.length} 步：${s.from} → ${s.to}` }),
      el("p", { style: "color:var(--fg);font-family:var(--mono);font-size:12.5px", text: s.label }),
    );
    if (s.detail) badge.append(el("p", { text: s.detail }));
    if (s.hint) badge.append(el("p", { class: "faint mono", style: "font-size:12px", text: s.hint }));
    if (s.symbol) {
      badge.append(el("div", { class: "row tight" }, el("span", { class: "pill resolved", text: s.symbol })));
    }
    stepBox.append(badge);

    clear(sourceBox);
    if (!s.symbol) {
      sourceBox.append(el("div", { class: "faint", text: "这一步没有绑定符号，只看说明即可。" }));
      return;
    }
    sourceBox.append(el("h3", { text: "对应源码" }));
    const cached = detailCache.get(s.symbol);
    if (cached === null) {
      sourceBox.append(el("div", { class: "faint", text: "该符号在抽取数据里没有源码片段。" }));
      return;
    }
    if (cached) {
      renderSource(cached);
      return;
    }
    sourceBox.append(el("p", { class: "loading", text: "加载源码中…" }));
    try {
      const d = await api.symbol(s.symbol);
      detailCache.set(s.symbol, d);
      clear(sourceBox);
      sourceBox.append(el("h3", { text: "对应源码" }));
      renderSource(d);
    } catch (err) {
      clear(sourceBox);
      sourceBox.append(el("h3", { text: "对应源码" }), el("div", { class: "error-box", text: `加载失败：${err instanceof Error ? err.message : String(err)}` }));
    }
  }

  function renderSource(d: SymbolDetail): void {
    const src = d.source;
    if (!src || src.lines.length === 0) {
      sourceBox.append(el("div", { class: "faint", text: "没有可显示的源码。" }));
      return;
    }
    const sym = d.symbol;
    sourceBox.append(
      el("div", { class: "row" },
        el("span", {
          class: "mono",
          style: "cursor:pointer;text-decoration:underline;font-size:12.5px",
          text: `${sym.file}:${sym.lineno}`,
          onclick: () => ctx.navigate(ctx.sourceRoute(sym.file, sym.lineno)),
        }),
        el("span", { class: "faint", text: "点击跳到源码视图" }),
      ),
    );
    const block = sourceBlock(src.lines, sym.file, {
      highlight: [[sym.lineno, sym.end_lineno]],
      onLineClick: (n) => ctx.navigate(ctx.sourceRoute(sym.file, n)),
      focusLine: sym.lineno,
    });
    sourceBox.append(block);
    focusInto(block);
  }

  function render(): void {
    prevBtn.toggleAttribute("disabled", step <= 0);
    nextBtn.toggleAttribute("disabled", step >= flow.steps.length - 1);
    jumpInput.max = String(flow.steps.length);
    jumpInput.value = String(step + 1);
    renderTimeline();
    renderDiagram();
    void renderStep();
  }

  renderFlowCards();
  render();
}
