//! C/CUDA 与 Triton 算子的清单。两条路都不做跨语言调用边，只列符号。

use crate::model::KernelItem;
use crate::pyextract::{PyFile, scan};
use anyhow::Result;
use std::path::Path;

const CSRC_KEYWORDS: &[&str] = &["if", "for", "while", "switch", "return", "else", "sizeof", "catch", "throw"];
const CSRC_LEADING: &[&str] = &[
    "void", "int", "float", "double", "bool", "size_t", "auto", "const", "unsigned", "signed",
    "char", "long", "short", "static", "inline", "extern", "constexpr", "template", "struct",
    "class", "typedef", "namespace", "__global__", "__device__", "__host__", "__forceinline__",
    "uint8_t", "uint16_t", "uint32_t", "uint64_t", "int8_t", "int16_t", "int32_t", "int64_t",
];

/// 从一行 C/CUDA 源码里认出函数名
fn csrc_func_name(line: &str) -> Option<String> {
    let t = line.trim();
    if t.starts_with("//") || t.starts_with('*') || t.starts_with('#') {
        return None;
    }
    let paren = t.find('(')?;
    let head = t[..paren].trim_end();
    if head.is_empty() {
        return None;
    }
    // 名字是 head 末尾的标识符
    let mut rev = String::new();
    for c in head.chars().rev() {
        if c.is_alphanumeric() || c == '_' {
            rev.push(c);
        } else {
            break;
        }
    }
    let name: String = rev.chars().rev().collect();
    if name.is_empty() || CSRC_KEYWORDS.contains(&name.as_str()) {
        return None;
    }
    let prefix = head[..head.len() - name.len()].trim_end();
    if prefix.is_empty() {
        return None;
    }
    // 前缀只允许类型、限定符、指针与模板符号
    if !prefix
        .chars()
        .all(|c| c.is_alphanumeric() || "_*&:<>, \t".contains(c))
    {
        return None;
    }
    let first = prefix.split([' ', '\t', '*', '&']).find(|w| !w.is_empty())?;
    let first = first.split('<').next().unwrap_or(first);
    // 声明有「返回类型 + 函数名」两段，函数调用只有一段
    let two_tokens = prefix.split_whitespace().count() >= 2;
    if !two_tokens && !CSRC_LEADING.contains(&first) {
        return None;
    }
    Some(name)
}

/// 结构体 / 类定义
fn csrc_struct(line: &str) -> Option<(String, String, String)> {
    let t = line.trim_start();
    let (kw, rest) = if let Some(r) = t.strip_prefix("struct ") {
        ("struct", r)
    } else if let Some(r) = t.strip_prefix("class ") {
        ("class", r)
    } else {
        return None;
    };
    let rest = rest.trim_start();
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() {
        return None;
    }
    let after = rest[name.len()..].trim_start();
    if !after.starts_with('{') && !after.starts_with(':') {
        return None;
    }
    let base = after
        .strip_prefix(':')
        .map(|b| {
            b.split('{')
                .next()
                .unwrap_or("")
                .trim()
                .trim_start_matches("public ")
                .trim()
                .to_string()
        })
        .unwrap_or_default();
    Some((name, kw.to_string(), base))
}

pub fn scan_csrc_files(root: &Path, src_root: &Path) -> Vec<KernelItem> {
    let mut out = Vec::new();
    if !root.exists() {
        return out;
    }
    let mut files: Vec<std::path::PathBuf> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .collect();
    files.sort();
    for path in files {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let rel = path
            .strip_prefix(src_root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let ext = path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
        for (i, line) in text.lines().enumerate() {
            let n = i as u32 + 1;
            if let Some((name, kind, base)) = csrc_struct(line) {
                out.push(KernelItem {
                    name,
                    kind,
                    file: rel.clone(),
                    line: n,
                    end_line: 0,
                    signature: line.trim().to_string(),
                    base,
                    decorators: Vec::new(),
                    docstring: String::new(),
                    params: Vec::new(),
                    ext: ext.clone(),
                });
                continue;
            }
            if let Some(name) = csrc_func_name(line) {
                out.push(KernelItem {
                    name,
                    kind: "function".to_string(),
                    file: rel.clone(),
                    line: n,
                    end_line: 0,
                    signature: line.trim().to_string(),
                    base: String::new(),
                    decorators: Vec::new(),
                    docstring: String::new(),
                    params: Vec::new(),
                    ext: ext.clone(),
                });
            }
        }
    }
    out
}

/// Triton 与 kernel 目录下的 Python 算子
pub fn scan_triton_files(root: &Path, src_root: &Path, idx: &crate::pyextract::index::Index) -> Result<Vec<KernelItem>> {
    let mut out = Vec::new();
    if !root.exists() {
        return Ok(out);
    }
    let mut files: Vec<std::path::PathBuf> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.path().extension().map(|x| x == "py").unwrap_or(false))
        .map(|e| e.into_path())
        .collect();
    files.sort();
    for path in files {
        let f = PyFile::load(&path, src_root)?;
        for sym in scan::scan_file(&f, idx) {
            if sym.kind != "function" {
                continue;
            }
            let is_kernel = sym
                .decorators
                .iter()
                .any(|d| d.contains("triton.jit") || d == "jit");
            out.push(KernelItem {
                name: sym.name.clone(),
                kind: if is_kernel { "triton_kernel".to_string() } else { "function".to_string() },
                file: sym.file.clone(),
                line: sym.lineno,
                end_line: sym.end_lineno,
                signature: sym.signature.clone(),
                base: String::new(),
                decorators: sym.decorators.clone(),
                docstring: sym.docstring.clone(),
                params: sym.params.clone(),
                ext: ".py".to_string(),
            });
        }
    }
    Ok(out)
}
