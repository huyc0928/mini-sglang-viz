// 应用外壳：左栏导航、顶部搜索、哈希路由。

import "./styles.css";
import { api } from "./api";
import { clear, el } from "./lib/dom";
import { views } from "./views";
import type { View, ViewContext } from "./views/types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("缺少 #app 容器");

const rail = el("nav", { class: "rail" });
const topbar = el("header", { class: "topbar" });
const main = el("main", { class: "main" });
let active: View | undefined;

/** 解析 #/route?a=b 形式的哈希 */
function currentRoute(): { path: string; params: URLSearchParams } {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  return { path: path || "overview", params: new URLSearchParams(query) };
}

export function navigate(route: string): void {
  const next = route.startsWith("#") ? route : `#/${route}`;
  if (window.location.hash === next) {
    void mount();
    return;
  }
  window.location.hash = next;
}

function sourceRoute(file: string, line?: number): string {
  const p = new URLSearchParams({ file });
  if (line !== undefined) p.set("line", String(line));
  return `source?${p.toString()}`;
}

function graphRoute(symbolId: string, depth = 2): string {
  return `callgraph?symbol=${encodeURIComponent(symbolId)}&depth=${depth}`;
}

async function mount(): Promise<void> {
  const { path, params } = currentRoute();
  const view = views.find((v) => v.id === path) ?? views[0];
  if (!view) throw new Error("没有可用视图");

  active?.destroy?.();
  active = view;
  for (const btn of rail.querySelectorAll("button")) btn.classList.toggle("active", btn.dataset.view === view.id);

  clear(main);
  const body = el("div", { class: "view-body" });
  const wrap = el("div", { class: "view" }, body);
  main.append(wrap);

  const ctx: ViewContext = { root: body, params, navigate, sourceRoute, graphRoute };
  try {
    await view.render(ctx);
  } catch (err) {
    clear(body);
    body.append(
      el("div", { class: "error-box" }, [
        el("b", { text: "视图渲染失败：" }),
        el("span", { text: err instanceof Error ? err.message : String(err) }),
        el("p", {
          class: "faint",
          text: "确认后端已启动：cd backend && cargo run -- serve --data ../data",
        }),
      ]),
    );
    console.error(err);
  }
}

window.addEventListener("hashchange", () => void mount());

// ---- 左栏 ----
rail.append(
  ...views.map((v) =>
    el(
      "button",
      { "data-view": v.id, title: v.subtitle, onclick: () => navigate(v.id) },
      el("span", { text: v.title }),
    ),
  ),
);
rail.append(
  el("div", { class: "rail-note" }, [
    el("div", { text: "数据来自 mini-sglang 源码的静态抽取" }),
    el("div", { class: "mono", id: "rail-stats", text: "" }),
  ]),
);

// ---- 顶部搜索 ----
const searchInput = el("input", {
  type: "search",
  placeholder: "搜索符号：Scheduler、radix、evict、ChunkedReq …",
  style: "flex:1;max-width:520px",
}) as HTMLInputElement;
let searchSeq = 0;

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim();
  const seq = ++searchSeq;
  if (q.length < 2) {
    showSearchResults([], q);
    return;
  }
  void api
    .search(q, 12)
    .then((r) => {
      if (seq !== searchSeq) return; // 丢弃过期结果
      showSearchResults(r.items, q);
    })
    .catch(() => showSearchResults([], q));
});

function showSearchResults(items: { id: string; name: string; kind: string; group: string; file: string; lineno: number; why: string; signature: string }[], q: string): void {
  const pop = document.querySelector<HTMLDivElement>("#search-pop");
  if (!pop) return;
  clear(pop);
  if (!q) {
    pop.style.display = "none";
    return;
  }
  if (items.length === 0) {
    pop.append(el("div", { class: "item" }, [el("div", { class: "name faint", text: q.length < 2 ? "至少输入两个字符" : "没有匹配的符号" })]));
  }
  for (const hit of items) {
    pop.append(
      el(
        "div",
        {
          class: "item",
          onclick: () => {
            pop.style.display = "none";
            searchInput.value = "";
            navigate(graphRoute(hit.id, 2));
          },
        },
        [
          el("div", { class: "name" }, [hit.name, " ", el("span", { class: `pill ${hit.kind}`, text: hit.kind })]),
          el("div", { class: "sig", text: hit.signature || hit.id }),
          el("div", { class: "where", text: `${hit.file}:${hit.lineno} · ${hit.group} · ${hit.why}` }),
        ],
      ),
    );
  }
  pop.style.display = items.length ? "block" : "none";
}

const searchPop = el("div", {
  id: "search-pop",
  style:
    "display:none;position:absolute;top:46px;left:16px;right:16px;max-width:640px;z-index:40;" +
    "background:var(--bg-1);border:1px solid var(--line);border-radius:10px;padding:8px;max-height:60vh;overflow:auto",
});
topbar.style.position = "relative";
topbar.append(
  el("span", { class: "faint", text: "mini-sglang" }),
  searchInput,
  searchPop,
);
document.addEventListener("click", (e) => {
  if (!topbar.contains(e.target as Node) && searchPop.style.display === "block") searchPop.style.display = "none";
});

// ---- 侧栏统计 ----
void api
  .stats()
  .then((s) => {
    const node = document.querySelector("#rail-stats");
    if (node) node.textContent = `${s.symbols} 符号 · ${s.edges} 调用边 · ${s.py_loc} 行`;
  })
  .catch(() => {
    const node = document.querySelector("#rail-stats");
    if (node) node.textContent = "后端未连接";
  });

app.append(
  el("div", { class: "brand" }, [
    el("div", {}, [el("div", { text: "mini-sglang" }), el("small", { text: "源码可视化" })]),
  ]),
  topbar,
  rail,
  main,
);

void mount();
