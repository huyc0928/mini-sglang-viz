//! Rust 版 Python 源码抽取器。
//!
//! 与 `tools/reference-extractor/extract.py` 是同一套算法：先把每个文件的导入与
//! 类型信息收齐，建立跨文件索引，再扫描符号与调用边。

pub mod index;
pub mod scan;
pub mod walk;

use anyhow::{Context, Result};
use rustpython_ast::{self as ast, Ranged};
use std::path::{Path, PathBuf};

/// 行号索引：把字节偏移换算成 1 起始的行号。
pub struct LineIndex {
    starts: Vec<u32>,
}

impl LineIndex {
    pub fn new(src: &str) -> Self {
        let mut starts = vec![0u32];
        for (i, b) in src.bytes().enumerate() {
            if b == b'\n' {
                starts.push(i as u32 + 1);
            }
        }
        Self { starts }
    }

    /// 偏移所在行，1 起始。
    pub fn line_of(&self, offset: u32) -> u32 {
        match self.starts.binary_search(&offset) {
            Ok(i) => i as u32 + 1,
            Err(i) => i as u32,
        }
    }

    /// 节点末字符所在行，对应 CPython 的 end_lineno。
    pub fn end_line_of(&self, end_offset: u32) -> u32 {
        self.line_of(end_offset.saturating_sub(1))
    }

    pub fn count(&self) -> u32 {
        self.starts.len() as u32
    }
}

/// 一个已解析的 Python 文件。
pub struct PyFile {
    pub abs: PathBuf,
    pub rel: String,
    pub module: String,
    pub is_package: bool,
    pub source: String,
    pub lines: Vec<String>,
    pub index: LineIndex,
    pub body: Vec<ast::Stmt>,
    /// 本地名 -> "module:symbol" 或 "module"
    pub imports: std::collections::BTreeMap<String, String>,
    pub star_imports: Vec<String>,
    /// 函数名 -> 返回类型简单名（不区分所属类，供跨文件查询）
    pub return_types: std::collections::BTreeMap<String, String>,
}

impl PyFile {
    pub fn load(abs: &Path, src_root: &Path) -> Result<Self> {
        let source = std::fs::read_to_string(abs)
            .with_context(|| format!("读取 {}", abs.display()))?;
        let rel = abs
            .strip_prefix(src_root)
            .unwrap_or(abs)
            .to_string_lossy()
            .replace('\\', "/");
        let parsed = rustpython_parser::parse(&source, rustpython_parser::Mode::Module, &rel)
            .map_err(|e| anyhow::anyhow!("解析 {} 失败: {}", rel, e))?;
        let body = match parsed {
            ast::Mod::Module(m) => m.body,
            other => anyhow::bail!("{} 不是模块（{:?}）", rel, std::mem::discriminant(&other)),
        };
        let is_package = abs.file_name().map(|f| f == "__init__.py").unwrap_or(false);
        let mut me = Self {
            abs: abs.to_path_buf(),
            module: module_name_of(&rel),
            rel,
            is_package,
            lines: source.lines().map(|s| s.to_string()).collect(),
            index: LineIndex::new(&source),
            source,
            body,
            imports: Default::default(),
            star_imports: Vec::new(),
            return_types: Default::default(),
        };
        me.collect_imports();
        me.collect_returns();
        Ok(me)
    }

    /// 行区间（1 起始、闭区间）的源码文本
    pub fn slice_lines(&self, start: u32, end: u32) -> Vec<String> {
        let a = start.saturating_sub(1) as usize;
        let b = (end as usize).min(self.lines.len());
        if a >= b {
            return Vec::new();
        }
        self.lines[a..b].to_vec()
    }

    fn resolve_relative(&self, level: u32, modname: Option<&str>) -> String {        if level == 0 {
            return modname.unwrap_or("").to_string();
        }
        let parts: Vec<&str> = self.module.split('.').collect();
        // 包内的 __init__.py 用 level=1 指自己，普通模块则要退一层
        let strip = level as i64 - if self.is_package { 1 } else { 0 };
        let keep = if strip > 0 {
            (parts.len() as i64 - strip).max(0) as usize
        } else {
            parts.len()
        };
        let mut out: Vec<String> = parts[..keep].iter().map(|s| s.to_string()).collect();
        if let Some(m) = modname {
            out.extend(m.split('.').map(|s| s.to_string()));
        }
        out.join(".")
    }

    fn collect_imports(&mut self) {
        // 先只读地收集，再一次性写入，避免同时借用 self 的两个字段
        let mut found: Vec<(String, String)> = Vec::new();
        let mut stars: Vec<String> = Vec::new();
        for node in walk::deep(&self.body) {
            match node {
                walk::Node::S(ast::Stmt::Import(n)) => {
                    for alias in &n.names {
                        let full = alias.name.to_string();
                        match &alias.asname {
                            Some(a) => found.push((a.to_string(), full)),
                            None => {
                                let root = full.split('.').next().unwrap_or(&full).to_string();
                                found.push((root, full));
                            }
                        }
                    }
                }
                walk::Node::S(ast::Stmt::ImportFrom(n)) => {
                    let modname = n.module.as_ref().map(|m| m.to_string());
                    let level = n.level.map(|l| l.to_u32()).unwrap_or(0);
                    let base = self.resolve_relative(level, modname.as_deref());
                    for alias in &n.names {
                        let name = alias.name.to_string();
                        if name == "*" {
                            stars.push(base.clone());
                            continue;
                        }
                        let local = alias
                            .asname
                            .as_ref()
                            .map(|a| a.to_string())
                            .unwrap_or_else(|| name.clone());
                        let value = if base.is_empty() {
                            name
                        } else {
                            format!("{base}:{name}")
                        };
                        found.push((local, value));
                    }
                }
                _ => {}
            }
        }
        for (k, v) in found {
            self.imports.insert(k, v);
        }
        self.star_imports.extend(stars);
    }

    fn collect_returns(&mut self) {
        let mut found: Vec<(String, String)> = Vec::new();
        for node in walk::deep(&self.body) {
            match node {
                walk::Node::S(ast::Stmt::FunctionDef(f)) => {
                    if let Some(r) = &f.returns {
                        let t = simple_type(&r.to_string());
                        if !t.is_empty() {
                            found.push((f.name.to_string(), t));
                        }
                    }
                }
                walk::Node::S(ast::Stmt::AsyncFunctionDef(f)) => {
                    if let Some(r) = &f.returns {
                        let t = simple_type(&r.to_string());
                        if !t.is_empty() {
                            found.push((f.name.to_string(), t));
                        }
                    }
                }
                _ => {}
            }
        }
        for (k, v) in found {
            self.return_types.entry(k).or_insert(v);
        }
    }

    pub fn import_map(&self) -> Vec<String> {
        self.imports
            .iter()
            .map(|(k, v)| format!("{k} -> {v}"))
            .collect()
    }

    /// 供索引层使用
    pub fn resolve_relative_pub(&self, level: u32, modname: Option<&str>) -> String {
        self.resolve_relative(level, modname)
    }
}

/// python/minisgl/engine/engine.py -> minisgl.engine.engine
pub fn module_name_of(rel: &str) -> String {
    let mut parts: Vec<&str> = rel.split('/').collect();
    if parts.first() == Some(&"python") {
        parts.remove(0);
    }
    if let Some(last) = parts.last_mut() {
        *last = last.trim_end_matches(".py");
    }
    if parts.last() == Some(&"__init__") {
        parts.pop();
    }
    if parts.is_empty() {
        "__root__".to_string()
    } else {
        parts.join(".")
    }
}

/// minisgl.engine.engine -> engine
pub fn module_of_path(rel: &str) -> String {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.len() >= 3 && parts[0] == "python" && parts[1] == "minisgl" {
        if parts.len() == 3 {
            return parts[2].trim_end_matches(".py").to_string();
        }
        return parts[2].to_string();
    }
    "other".to_string()
}

const GENERIC_HEADS: &[&str] = &[
    "Optional", "List", "Dict", "Set", "Tuple", "Iterator", "Iterable", "Sequence",
    "Callable", "Type", "Mapping", "list", "dict", "set", "tuple", "frozenset", "ClassVar",
];

/// 从注解或赋值右侧表达式里取出简单类型名。
pub fn simple_type(text: &str) -> String {
    let text = text.trim().trim_start_matches(['*', '&', ' ']).to_string();
    if text.is_empty() {
        return String::new();
    }
    // 泛型注解：取内部第一个大写开头的类型
    if let Some(open) = text.find('[') {
        if text.ends_with(']') {
            let head = &text[..open];
            let inner = &text[open + 1..text.len() - 1];
            let head_last = head.rsplit('.').next().unwrap_or(head);
            if GENERIC_HEADS.contains(&head_last) {
                for part in split_top_level(inner) {
                    let t = simple_type(part);
                    if !t.is_empty() {
                        return t;
                    }
                }
                return String::new();
            }
        }
    }
    // 剥掉调用参数与下标
    let head = text
        .split(['(', '['])
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if head.is_empty() {
        return String::new();
    }
    let last = head.rsplit('.').next().unwrap_or(&head).to_string();
    let mut chars = last.chars();
    match chars.next() {
        Some(c) if c.is_ascii_uppercase() && last.chars().all(|c| c.is_alphanumeric() || c == '_') => {
            last
        }
        _ => String::new(),
    }
}

pub fn split_top_level(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    for (i, ch) in text.char_indices() {
        match ch {
            '[' | '(' => depth += 1,
            ']' | ')' => depth -= 1,
            ',' if depth == 0 => {
                out.push(&text[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&text[start..]);
    out
}

/// 把 Name/Attribute 链拼成点号字符串
pub fn dotted_name(expr: &ast::Expr) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut cur = expr;
    loop {
        match cur {
            ast::Expr::Attribute(a) => {
                parts.push(a.attr.to_string());
                cur = &a.value;
            }
            ast::Expr::Name(n) => {
                parts.push(n.id.to_string());
                break;
            }
            _ => return None,
        }
    }
    parts.reverse();
    Some(parts.join("."))
}

/// 节点在源码中的偏移区间
pub fn span<T: Ranged + ?Sized>(node: &T) -> (u32, u32) {
    (node.start().to_u32(), node.end().to_u32())
}

/// 取节点对应的原始源码文本，用于 assert 这类语句
pub fn source_slice<'a, T: Ranged + ?Sized>(src: &'a str, node: &T) -> &'a str {
    let (s, e) = span(node);
    src.get(s as usize..e as usize).unwrap_or("")
}
