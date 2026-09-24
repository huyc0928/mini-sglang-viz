//! 查询层：把抽取产物建成索引，供 API 使用。

use crate::model::*;
use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct Neighbor {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub group: String,
    pub file: String,
    pub lineno: u32,
    pub confidence: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    pub id: String,
    pub name: String,
    pub qualname: String,
    pub kind: String,
    pub group: String,
    pub file: String,
    pub lineno: u32,
    pub signature: String,
    pub score: i32,
    pub why: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub group: String,
    pub file: String,
    pub lineno: u32,
    pub depth: i32,
    pub loc: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub confidence: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Graph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceChunk {
    pub path: String,
    pub start: u32,
    pub end: u32,
    pub lines: Vec<SourceLine>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceLine {
    pub n: u32,
    pub text: String,
}

pub struct Store {
    pub out: ExtractOutput,
    pub content: serde_json::Value,
    /// 被调用者 -> 调用者列表
    reverse: HashMap<String, Vec<String>>,
    /// 抽象基类方法 -> 实现类方法
    pub overrides: Vec<EdgeOut>,
    pub kernels: serde_json::Value,
    source_root: Option<PathBuf>,
}

impl Store {
    pub fn load(data: &Path, content_path: &Path, source_root: Option<PathBuf>) -> Result<Self> {
        let out = crate::extract::load_output(data)?;
        let kernels_path = data.join("kernels.json");
        let kernels = if kernels_path.exists() {
            serde_json::from_str(&std::fs::read_to_string(&kernels_path)?)?
        } else {
            serde_json::json!({ "csrc": [], "triton": [] })
        };
        let content = if content_path.exists() {
            serde_json::from_str(
                &std::fs::read_to_string(content_path)
                    .with_context(|| format!("读取 {}", content_path.display()))?,
            )?
        } else {
            serde_json::json!({})
        };
        let mut reverse: HashMap<String, Vec<String>> = HashMap::new();
        for e in out.edges.iter().chain(out.overrides.iter()) {
            reverse.entry(e.to.clone()).or_default().push(e.from.clone());
        }
        let overrides = out.overrides.clone();
        Ok(Self {
            out,
            content,
            reverse,
            overrides,
            kernels,
            source_root,
        })
    }

    pub fn symbol(&self, id: &str) -> Option<&SymbolOut> {
        self.out.symbols.get(id)
    }

    pub fn callees(&self, id: &str) -> Vec<Neighbor> {
        let mut v: Vec<Neighbor> = self
            .out
            .edges
            .iter()
            .chain(self.overrides.iter())
            .filter(|e| e.from == id)
            .filter_map(|e| self.symbol(&e.to).map(|s| self.neighbor(s, e)))
            .collect();
        v.sort_by(|a, b| b.count.cmp(&a.count).then(a.lineno.cmp(&b.lineno)));
        v
    }

    pub fn callers(&self, id: &str) -> Vec<Neighbor> {
        let Some(froms) = self.reverse.get(id) else {
            return Vec::new();
        };
        let mut v: Vec<Neighbor> = froms
            .iter()
            .filter_map(|from| {
                self.out
                    .edges
                    .iter()
                    .chain(self.overrides.iter())
                    .find(|e| &e.from == from && e.to == id)
                    .and_then(|e| self.symbol(from).map(|s| self.neighbor(s, e)))
            })
            .collect();
        v.sort_by(|a, b| b.count.cmp(&a.count).then(a.lineno.cmp(&b.lineno)));
        v
    }

    fn neighbor(&self, s: &SymbolOut, e: &EdgeOut) -> Neighbor {
        Neighbor {
            id: s.id.clone(),
            name: s.name.clone(),
            kind: s.kind.clone(),
            group: s.group.clone(),
            file: s.file.clone(),
            lineno: s.lineno,
            confidence: e.confidence.clone(),
            count: e.count,
        }
    }

    /// 一步可达的符号 id（含 override 边）
    fn next_ids(&self, id: &str, direction: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        if direction != "up" {
            out.extend(self.out.edges.iter().chain(self.overrides.iter()).filter(|e| e.from == id).map(|e| e.to.clone()));
        }
        if direction != "down" {
            out.extend(self.reverse.get(id).cloned().unwrap_or_default());
        }
        out
    }

    /// 子图：从 root 出发按方向做广度优先，收集节点与其间所有边
    pub fn graph(&self, root: &str, depth: i32, direction: &str, max_nodes: usize) -> Graph {
        let mut depth_of: BTreeMap<String, i32> = BTreeMap::new();
        let mut truncated = false;
        if self.symbol(root).is_some() {
            depth_of.insert(root.to_string(), 0);
            let mut queue: VecDeque<(String, i32)> = VecDeque::new();
            queue.push_back((root.to_string(), 0));
            while let Some((cur, d)) = queue.pop_front() {
                if d >= depth {
                    continue;
                }
                for n in self.next_ids(&cur, direction) {
                    if self.symbol(&n).is_none() {
                        continue;
                    }
                    if !depth_of.contains_key(&n) {
                        if depth_of.len() >= max_nodes {
                            truncated = true;
                            continue;
                        }
                        depth_of.insert(n.clone(), d + 1);
                        queue.push_back((n, d + 1));
                    }
                }
            }
        }
        self.subgraph(&depth_of, truncated)
    }

    /// 最短调用路径（按边方向）
    pub fn path(&self, from: &str, to: &str, max_nodes: usize) -> Graph {
        let mut prev: HashMap<String, String> = HashMap::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut queue: VecDeque<String> = VecDeque::new();
        seen.insert(from.to_string());
        queue.push_back(from.to_string());
        let mut found = false;
        while let Some(cur) = queue.pop_front() {
            if cur == to {
                found = true;
                break;
            }
            if seen.len() > max_nodes {
                break;
            }
            for n in self.next_ids(&cur, "down") {
                if seen.insert(n.clone()) {
                    prev.insert(n.clone(), cur.clone());
                    queue.push_back(n);
                }
            }
        }
        if !found {
            return Graph { nodes: Vec::new(), edges: Vec::new(), truncated: false };
        }
        // 回溯路径
        let mut chain = vec![to.to_string()];
        let mut cur = to.to_string();
        while let Some(p) = prev.get(&cur) {
            chain.push(p.clone());
            cur = p.clone();
        }
        chain.reverse();
        let mut depth_of: BTreeMap<String, i32> = BTreeMap::new();
        for (i, id) in chain.iter().enumerate() {
            depth_of.insert(id.clone(), i as i32);
        }
        self.subgraph(&depth_of, false)
    }

    fn subgraph(&self, depth_of: &BTreeMap<String, i32>, truncated: bool) -> Graph {
        let mut nodes: Vec<GraphNode> = Vec::new();
        for (id, d) in depth_of {
            if let Some(s) = self.symbol(id) {
                nodes.push(GraphNode {
                    id: s.id.clone(),
                    name: s.name.clone(),
                    kind: s.kind.clone(),
                    group: s.group.clone(),
                    file: s.file.clone(),
                    lineno: s.lineno,
                    depth: *d,
                    loc: s.loc,
                });
            }
        }
        let mut edges: Vec<GraphEdge> = Vec::new();
        for e in self.out.edges.iter().chain(self.overrides.iter()) {
            if depth_of.contains_key(&e.from) && depth_of.contains_key(&e.to) {
                edges.push(GraphEdge {
                    from: e.from.clone(),
                    to: e.to.clone(),
                    confidence: e.confidence.clone(),
                    count: e.count,
                });
            }
        }
        Graph { nodes, edges, truncated }
    }

    pub fn search(&self, q: &str, limit: usize) -> Vec<Hit> {
        let needle = q.trim().to_lowercase();
        if needle.is_empty() {
            return Vec::new();
        }
        let mut hits: Vec<Hit> = Vec::new();
        for s in self.out.symbols.values() {
            let mut score = 0i32;
            let mut why = "";
            let id = s.id.to_lowercase();
            let name = s.name.to_lowercase();
            let qual = s.qualname.to_lowercase();
            if id == needle {
                score = 100;
                why = "符号 id 完全匹配";
            } else if name == needle {
                score = 90;
                why = "名字完全匹配";
            } else if qual == needle {
                score = 88;
                why = "限定名完全匹配";
            } else if name.starts_with(&needle) {
                score = 75;
                why = "名字前缀匹配";
            } else if qual.contains(&needle) {
                score = 65;
                why = "限定名包含";
            } else if id.contains(&needle) {
                score = 55;
                why = "路径包含";
            } else if s.signature.to_lowercase().contains(&needle) {
                score = 35;
                why = "签名包含";
            } else if s.docstring.to_lowercase().contains(&needle) {
                score = 30;
                why = "文档字符串包含";
            } else if subsequence(&name, &needle) {
                score = 20;
                why = "名字近似匹配";
            }
            if score > 0 {
                hits.push(Hit {
                    id: s.id.clone(),
                    name: s.name.clone(),
                    qualname: s.qualname.clone(),
                    kind: s.kind.clone(),
                    group: s.group.clone(),
                    file: s.file.clone(),
                    lineno: s.lineno,
                    signature: s.signature.clone(),
                    score,
                    why: why.to_string(),
                });
            }
        }
        hits.sort_by(|a, b| b.score.cmp(&a.score).then(a.id.cmp(&b.id)));
        hits.truncate(limit);
        hits
    }

    /// 符号列表，可按模块与类型过滤
    pub fn symbol_list(&self, group: Option<&str>, kind: Option<&str>, file: Option<&str>) -> Vec<&SymbolOut> {
        let mut v: Vec<&SymbolOut> = self
            .out
            .symbols
            .values()
            .filter(|s| group.map(|g| s.group == g).unwrap_or(true))
            .filter(|s| kind.map(|k| s.kind == k).unwrap_or(true))
            .filter(|s| file.map(|f| s.file == f).unwrap_or(true))
            .collect();
        v.sort_by(|a, b| (&a.file, a.lineno).cmp(&(&b.file, b.lineno)));
        v
    }

    pub fn datastruct(&self, id: &str) -> Option<&DataStructOut> {
        self.out.datastructs.iter().find(|d| d.id == id)
    }

    /// 源码切片；path 缺省时用符号所在文件
    pub fn source(&self, path: &str, start: u32, end: u32) -> Option<SourceChunk> {
        let lines = self.out.sources.get(path)?;
        let s = start.max(1);
        let e = end.min(lines.len() as u32).max(s);
        let chunk: Vec<SourceLine> = (s..=e)
            .filter_map(|n| {
                lines.get((n - 1) as usize).map(|t| SourceLine {
                    n,
                    text: t.clone(),
                })
            })
            .collect();
        Some(SourceChunk {
            path: path.to_string(),
            start: s,
            end: e,
            lines: chunk,
        })
    }

    pub fn symbol_source(&self, id: &str, pad: u32) -> Option<SourceChunk> {
        let s = self.symbol(id)?;
        if s.lineno == 0 {
            return None;
        }
        let start = s.lineno.saturating_sub(pad).max(1);
        self.source(&s.file, start, s.end_lineno + pad)
    }

    pub fn source_root(&self) -> Option<&Path> {
        self.source_root.as_deref()
    }

    /// 原样读出磁盘上的源码行，用于最新内容（抽取产物之外的兜底）
    pub fn source_from_disk(&self, rel: &str) -> Option<Vec<String>> {
        let root = self.source_root.as_ref()?;
        let text = std::fs::read_to_string(root.join(rel)).ok()?;
        Some(text.lines().map(|l| l.to_string()).collect())
    }
}

/// 子序列匹配，用于名字近似搜索
fn subsequence(haystack: &str, needle: &str) -> bool {
    let mut it = haystack.chars();
    needle.chars().all(|c| it.any(|h| h == c))
}
