// 后端 API 客户端。所有请求都走 /api 前缀，开发时由 Vite 代理到 Rust 服务。

import type {
  Content,
  DataStructOut,
  FileMeta,
  Graph,
  Hit,
  KernelItem,
  ModuleOut,
  SourceChunk,
  Stats,
  SymbolDetail,
} from "./types";

const BASE = "/api";

async function get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const url = new URL(BASE + path, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* 响应体不是 JSON，保留状态文本 */
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return (await res.json()) as T;
}

export interface OverviewData {
  stats: Stats;
  modules: ModuleOut[];
  group_edges: { group: string; symbols: number; out_edges: number; in_edges: number }[];
}

export interface TopoEdge {
  from: string;
  to: string;
  label: string;
  kind: string;
}

export interface Neighbor {
  id: string;
  name: string;
  kind: string;
  group: string;
  file: string;
  lineno: number;
  confidence: string;
  count: number;
}

export const api = {
  overview: () => get<OverviewData>("/overview"),
  stats: () => get<Stats>("/stats"),
  modules: () => get<ModuleOut[]>("/modules"),
  files: () => get<Record<string, FileMeta>>("/files"),
  content: () => get<Content>("/content"),
  kernels: () => get<{ csrc: KernelItem[]; triton: KernelItem[] }>("/kernels"),
  datastructs: () => get<DataStructOut[]>("/datastructs"),
  datastruct: (id: string) => get<DataStructOut>("/datastruct", { id }),
  symbols: (filter: { group?: string; kind?: string; file?: string } = {}) =>
    get<{ count: number; items: SymbolDetail["symbol"][] }>("/symbols", filter),
  symbol: (id: string, pad = 2) => get<SymbolDetail>("/symbol", { id, pad }),
  graph: (root: string, depth = 2, direction = "both", maxNodes = 200) =>
    get<Graph>("/graph", { root, depth, direction, max_nodes: maxNodes }),
  path: (from: string, to: string) =>
    get<{ found: boolean; nodes: Graph["nodes"]; edges: Graph["edges"] }>("/path", { from, to }),
  search: (q: string, limit = 30) => get<{ items: Hit[] }>("/search", { q, limit }),
  source: (path: string, start?: number, end?: number, disk = false) =>
    get<SourceChunk>("/source", { path, start, end, disk }),
};
