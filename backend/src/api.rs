//! axum HTTP 服务：把查询层暴露成 JSON API，可选托管前端构建产物。

use crate::store::Store;
use anyhow::{Context, Result};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

type Shared = Arc<Store>;

fn bad_request(msg: impl Into<String>) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg.into() }))).into_response()
}

fn not_found(msg: impl Into<String>) -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": msg.into() }))).into_response()
}

#[derive(Deserialize)]
struct IdQ {
    id: String,
    /// 源码切片前后附带的行数
    #[serde(default = "default_pad")]
    pad: u32,
}

fn default_pad() -> u32 {
    3
}

#[derive(Deserialize)]
struct GraphQ {
    root: String,
    #[serde(default = "default_depth")]
    depth: i32,
    #[serde(default = "default_dir")]
    direction: String,
    #[serde(default = "default_max")]
    max_nodes: usize,
}

fn default_depth() -> i32 {
    2
}
fn default_dir() -> String {
    "both".to_string()
}
fn default_max() -> usize {
    160
}

#[derive(Deserialize)]
struct PathQ {
    from: String,
    to: String,
}

#[derive(Deserialize)]
struct SearchQ {
    q: String,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    30
}

#[derive(Deserialize)]
struct ListQ {
    group: Option<String>,
    kind: Option<String>,
    file: Option<String>,
}

#[derive(Deserialize)]
struct SourceQ {
    path: String,
    start: Option<u32>,
    end: Option<u32>,
    /// 为真时直接读磁盘上的最新内容
    #[serde(default)]
    disk: bool,
}

async fn stats(State(s): State<Shared>) -> Json<serde_json::Value> {
    Json(serde_json::to_value(&s.out.stats).unwrap_or(json!({})))
}

async fn modules(State(s): State<Shared>) -> Json<serde_json::Value> {
    Json(json!(s.out.modules))
}

async fn files(State(s): State<Shared>) -> Json<serde_json::Value> {
    Json(json!(s.out.files))
}

async fn content(State(s): State<Shared>) -> Json<serde_json::Value> {
    Json(s.content.clone())
}

async fn kernels(State(s): State<Shared>) -> Json<serde_json::Value> {
    Json(s.kernels.clone())
}

async fn datastructs(State(s): State<Shared>) -> Json<serde_json::Value> {
    Json(json!(s.out.datastructs))
}

async fn datastruct(State(s): State<Shared>, Query(q): Query<IdQ>) -> Response {
    match s.datastruct(&q.id) {
        Some(d) => Json(json!(d)).into_response(),
        None => not_found(format!("没有名为 {} 的数据结构", q.id)),
    }
}

async fn symbol_list(State(s): State<Shared>, Query(q): Query<ListQ>) -> Json<serde_json::Value> {
    let list: Vec<serde_json::Value> = s
        .symbol_list(q.group.as_deref(), q.kind.as_deref(), q.file.as_deref())
        .into_iter()
        .map(|sym| {
            json!({
                "id": sym.id, "name": sym.name, "qualname": sym.qualname, "kind": sym.kind,
                "group": sym.group, "file": sym.file, "lineno": sym.lineno,
                "signature": sym.signature, "loc": sym.loc,
            })
        })
        .collect();
    Json(json!({ "count": list.len(), "items": list }))
}

async fn symbol(State(s): State<Shared>, Query(q): Query<IdQ>) -> Response {
    let Some(sym) = s.symbol(&q.id) else {
        return not_found(format!("没有符号 {}", q.id));
    };
    let src = s.symbol_source(&q.id, q.pad);
    Json(json!({
        "symbol": sym,
        "callees": s.callees(&q.id),
        "callers": s.callers(&q.id),
        "source": src,
    }))
    .into_response()
}

async fn graph(State(s): State<Shared>, Query(q): Query<GraphQ>) -> Response {
    if s.symbol(&q.root).is_none() {
        return not_found(format!("没有符号 {}", q.root));
    }
    let g = s.graph(&q.root, q.depth.clamp(1, 4), &q.direction, q.max_nodes);
    Json(json!(g)).into_response()
}

async fn path(State(s): State<Shared>, Query(q): Query<PathQ>) -> Response {
    if s.symbol(&q.from).is_none() || s.symbol(&q.to).is_none() {
        return bad_request("from 或 to 不存在");
    }
    let g = s.path(&q.from, &q.to, 20_000);
    Json(json!({
        "found": !g.nodes.is_empty(),
        "nodes": g.nodes,
        "edges": g.edges,
    }))
    .into_response()
}

async fn search(State(s): State<Shared>, Query(q): Query<SearchQ>) -> Json<serde_json::Value> {
    Json(json!({ "items": s.search(&q.q, q.limit.clamp(1, 200)) }))
}

async fn source(State(s): State<Shared>, Query(q): Query<SourceQ>) -> Response {
    let lines = if q.disk {
        s.source_from_disk(&q.path).or_else(|| s.out.sources.get(&q.path).cloned())
    } else {
        s.out.sources.get(&q.path).cloned()
    };
    let Some(lines) = lines else {
        return not_found(format!("没有收录文件 {}", q.path));
    };
    let start = q.start.unwrap_or(1).max(1);
    let end = q.end.unwrap_or(lines.len() as u32).min(lines.len() as u32);
    let items: Vec<serde_json::Value> = (start..=end)
        .filter_map(|n| {
            lines.get((n - 1) as usize).map(|t| json!({ "n": n, "text": t }))
        })
        .collect();
    Json(json!({
        "path": q.path, "start": start, "end": end,
        "total": lines.len(), "lines": items,
    }))
    .into_response()
}

/// 反向索引概览：每个模块的符号数与入度出度，用于总览页
async fn overview(State(s): State<Shared>) -> Json<serde_json::Value> {
    let mut per_group: BTreeMap<String, (u32, u32, u32)> = BTreeMap::new();
    for sym in s.out.symbols.values() {
        let e = per_group.entry(sym.group.clone()).or_insert((0, 0, 0));
        e.0 += 1;
        e.1 += s.callees(&sym.id).len() as u32;
        e.2 += s.callers(&sym.id).len() as u32;
    }
    let groups: Vec<serde_json::Value> = per_group
        .into_iter()
        .map(|(g, (syms, out, inc))| json!({ "group": g, "symbols": syms, "out_edges": out, "in_edges": inc }))
        .collect();
    Json(json!({
        "stats": s.out.stats,
        "modules": s.out.modules,
        "group_edges": groups,
    }))
}

pub fn serve(data: PathBuf, dist: Option<PathBuf>, port: u16) -> Result<()> {
    let content_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../content/flows.json");
    // 源码根目录：优先环境变量，其次按仓库布局猜测
    let source_root = std::env::var("MINISGL_SRC")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            let guess = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../mini-sglang");
            guess.exists().then_some(guess)
        });
    let store = Store::load(&data, &content_path, source_root)
        .with_context(|| format!("加载数据目录 {}", data.display()))?;
    let shared: Shared = Arc::new(store);

    let mut app = Router::new()
        .route("/api/overview", get(overview))
        .route("/api/stats", get(stats))
        .route("/api/modules", get(modules))
        .route("/api/files", get(files))
        .route("/api/content", get(content))
        .route("/api/kernels", get(kernels))
        .route("/api/datastructs", get(datastructs))
        .route("/api/datastruct", get(datastruct))
        .route("/api/symbols", get(symbol_list))
        .route("/api/symbol", get(symbol))
        .route("/api/graph", get(graph))
        .route("/api/path", get(path))
        .route("/api/search", get(search))
        .route("/api/source", get(source))
        .with_state(shared);

    if let Some(dir) = dist {
        if dir.exists() {
            app = app.fallback_service(
                tower_http::services::ServeDir::new(&dir)
                    .not_found_service(tower_http::services::ServeFile::new(dir.join("index.html"))),
            );
            println!("并托管前端产物 {}", dir.display());
        }
    }

    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async move {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        println!("API 已启动 http://{addr}");
        let listener = tokio::net::TcpListener::bind(addr).await?;
        axum::serve(listener, app).await?;
        Ok::<(), anyhow::Error>(())
    })
}
