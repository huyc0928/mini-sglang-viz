// 源码浏览器：左侧文件树，右侧高亮源码与行号定位。

import { api } from "../api";
import { clear, el } from "../lib/dom";
import { sourceBlock } from "../lib/hl";
import { mountHead } from "../lib/view";
import type { FileMeta, Hit } from "../types";
import type { View, ViewContext } from "./types";

let searchTimer: number | undefined;

export const sourceView: View = {
  id: "source",
  title: "源码浏览器",
  subtitle: "按文件浏览高亮源码，支持行号定位",
  render(ctx) {
    return renderSource(ctx);
  },
  destroy() {
    if (searchTimer !== undefined) {
      window.clearTimeout(searchTimer);
      searchTimer = undefined;
    }
  },
};

async function renderSource(ctx: ViewContext): Promise<void> {
  const { root } = ctx;
  mountHead(root, "源码浏览器", "左侧按模块浏览文件，点击行号可跳到 #/source?file=…&line=N 并高亮该行。");
  root.classList.add("split");
  root.style.gridTemplateColumns = "300px 1fr";

  const filesMap = await api.files();
  const groupOrder = [
    "core", "scheduler", "engine", "kvcache", "attention", "models", "layers", "kernel",
    "server", "tokenizer", "distributed", "message", "moe", "llm", "env", "utils", "benchmark", "shell", "other",
  ];
  const byGroup = new Map<string, FileMeta[]>();
  for (const meta of Object.values(filesMap)) {
    const list = byGroup.get(meta.group) ?? [];
    list.push(meta);
    byGroup.set(meta.group, list);
  }
  for (const list of byGroup.values()) list.sort((a, b) => a.path.localeCompare(b.path));
  const rank = (g: string): number => { const i = groupOrder.indexOf(g); return i < 0 ? groupOrder.length : i; };
  const groups = [...byGroup.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  let selected = ctx.params.get("file") ?? "";
  if (!selected || !filesMap[selected]) {
    const first = groups.length ? byGroup.get(groups[0])?.[0] : undefined;
    selected = first ? first.path : "";
  }
  let focusLine = Number(ctx.params.get("line") ?? "") || 0;
  let filter = "";

  const fileList = el("div", { class: "list" });
  const filterInput = el("input", {
    type: "search",
    placeholder: "筛选文件名…",
    style: "width:100%;margin-bottom:10px",
  }) as HTMLInputElement;

  function renderTree(): void {
    clear(fileList);
    const q = filter.trim().toLowerCase();
    for (const g of groups) {
      const items = (byGroup.get(g) ?? []).filter((f) => !q || f.path.toLowerCase().includes(q));
      if (items.length === 0) continue;
      fileList.append(el("div", { class: "faint mono", style: "margin:8px 0 2px;font-size:11px", text: `${g} · ${items.length}` }));
      for (const f of items) {
        const name = f.path.slice(f.path.lastIndexOf("/") + 1);
        fileList.append(
          el(
            "div",
            { class: `item${f.path === selected ? " active" : ""}`, onclick: () => void selectFile(f.path) },
            el("div", { class: "name", text: name }),
            el("div", { class: "where", text: `${f.loc} 行 · ${f.symbols.length} 符号` }),
          ),
        );
      }
    }
    if (!fileList.firstChild) fileList.append(el("div", { class: "empty", text: "没有匹配的文件" }));
  }

  const jumpInput = el("input", {
    type: "search",
    placeholder: "跳到符号：evict、RadixTreeNode、allocate_paged …",
    style: "flex:1;min-width:220px",
  }) as HTMLInputElement;
  const jumpResults = el("div", { class: "list" });
  const codeBox = el("div");

  function showJump(items: Hit[]): void {
    clear(jumpResults);
    for (const hit of items) {
      jumpResults.append(
        el(
          "div",
          {
            class: "item",
            onclick: () => {
              clear(jumpResults);
              jumpInput.value = "";
              ctx.navigate(ctx.sourceRoute(hit.file, hit.lineno));
            },
          },
          el("div", { class: "name", text: hit.name }),
          el("div", { class: "where", text: `${hit.file}:${hit.lineno} · ${hit.kind}` }),
        ),
      );
    }
  }

  jumpInput.addEventListener("input", () => {
    const q = jumpInput.value.trim();
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    if (q.length < 2) {
      clear(jumpResults);
      return;
    }
    searchTimer = window.setTimeout(() => {
      void api
        .search(q, 8)
        .then((r) => showJump(r.items))
        .catch(() => clear(jumpResults));
    }, 200);
  });

  const left = el("div", { class: "pane" }, el("h3", { text: "文件" }), filterInput, fileList);
  const right = el(
    "div",
    { class: "pane", style: "border-right:0" },
    el("h3", { text: "文件内容" }),
    el("div", { class: "row", style: "margin-bottom:10px" }, jumpInput),
    jumpResults,
    codeBox,
  );
  root.append(left, right);

  async function selectFile(path: string, line = 0): Promise<void> {
    selected = path;
    focusLine = line;
    renderTree();
    clear(codeBox);
    codeBox.append(el("p", { class: "loading", text: "加载中…" }));
    try {
      const chunk = await api.source(path, line ? Math.max(1, line - 20) : undefined, line ? line + 200 : undefined);
      clear(codeBox);
      const total = chunk.total ?? chunk.end;
      codeBox.append(
        el("div", {
          class: "faint mono",
          style: "margin-bottom:6px;font-size:11.5px",
          text: `${chunk.path} · 共 ${total} 行${chunk.total ? "" : "（仅显示相关片段）"}`,
        }),
      );
      const block = sourceBlock(chunk.lines, path, {
        focusLine: line || undefined,
        onLineClick: (n) => ctx.navigate(ctx.sourceRoute(path, n)),
      });
      codeBox.append(block);
      block.querySelector<HTMLElement>("[data-focus]")?.scrollIntoView({ block: "center" });
    } catch (err) {
      clear(codeBox);
      codeBox.append(el("div", { class: "error-box", text: `读取失败：${err instanceof Error ? err.message : String(err)}` }));
    }
  }

  filterInput.addEventListener("input", () => {
    filter = filterInput.value;
    renderTree();
  });

  renderTree();
  await selectFile(selected, focusLine);
}
