//! 输出到 JSON 的数据结构，字段名与前端约定一致。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Param {
    pub name: String,
    pub annotation: String,
    pub default: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldInfo {
    pub name: String,
    pub annotation: String,
    pub default: String,
    pub init: bool,
    pub origin: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttrInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub line: u32,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssertInfo {
    pub line: u32,
    pub text: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignmentOut {
    pub target: String,
    pub method: String,
    pub line: u32,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallOut {
    pub line: u32,
    pub callee: String,
    pub target: String,
    #[serde(default)]
    pub confidence: String,
    #[serde(default)]
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimpleCall {
    pub line: u32,
    pub callee: String,
    #[serde(default)]
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalCall {
    pub line: u32,
    pub callee: String,
    pub lib: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolOut {
    pub id: String,
    pub name: String,
    pub qualname: String,
    pub kind: String,
    pub module: String,
    pub group: String,
    pub file: String,
    pub lineno: u32,
    pub end_lineno: u32,
    pub signature: String,
    pub params: Vec<Param>,
    pub returns: String,
    pub decorators: Vec<String>,
    pub bases: Vec<String>,
    pub docstring: String,
    pub fields: Vec<FieldInfo>,
    pub methods: Vec<String>,
    pub assignments: Vec<AssignmentOut>,
    pub attrs: Vec<AttrInfo>,
    pub asserts: Vec<AssertInfo>,
    pub is_dataclass: bool,
    pub is_property: bool,
    pub loc: u32,
    pub calls: Vec<CallOut>,
    pub unresolved: Vec<SimpleCall>,
    pub external: Vec<ExternalCall>,
    pub module_refs: Vec<SimpleCall>,
    #[serde(default)]
    pub imports: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeOut {
    #[serde(rename = "from")]
    pub from: String,
    #[serde(rename = "to")]
    pub to: String,
    pub count: u32,
    pub confidence: String,
    pub lines: Vec<u32>,
}

/// 调用边的中间表示，聚合前使用
pub struct EdgeAgg {
    pub from: String,
    pub to: String,
    pub count: u32,
    pub confidence: String,
    pub lines: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileOut {
    pub path: String,
    pub module: String,
    pub group: String,
    pub loc: u32,
    pub symbols: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleOut {
    pub name: String,
    pub files: Vec<String>,
    pub loc: u32,
    pub other_files: Vec<String>,
    pub description: String,
    pub path_hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataStructOut {
    pub id: String,
    pub name: String,
    pub module: String,
    pub group: String,
    pub file: String,
    pub lineno: u32,
    pub end_lineno: u32,
    pub docstring: String,
    pub bases: Vec<String>,
    pub kind: String,
    pub fields: Vec<FieldInfo>,
    pub attrs: Vec<AttrInfo>,
    pub methods: Vec<String>,
    pub asserts: Vec<AssertInfo>,
    pub assignments: Vec<AssignmentOut>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KernelItem {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: u32,
    #[serde(default)]
    pub end_line: u32,
    pub signature: String,
    #[serde(default)]
    pub base: String,
    #[serde(default)]
    pub decorators: Vec<String>,
    #[serde(default)]
    pub docstring: String,
    #[serde(default)]
    pub params: Vec<Param>,
    #[serde(default)]
    pub ext: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Stats {
    pub py_files: u32,
    pub py_loc: u32,
    pub symbols: u32,
    pub classes: u32,
    pub functions: u32,
    pub methods: u32,
    pub edges: u32,
    pub resolved_edges: u32,
    pub inferred_edges: u32,
    pub unresolved_calls: u32,
    pub external_calls: u32,
    pub datastructs: u32,
    pub csrc_symbols: u32,
    pub triton_symbols: u32,
    pub modules: u32,
    pub external_top: Vec<(String, u32)>,
}

/// 一次抽取的全部产物
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ExtractOutput {
    pub symbols: BTreeMap<String, SymbolOut>,
    pub edges: Vec<EdgeOut>,
    pub files: BTreeMap<String, FileOut>,
    pub modules: Vec<ModuleOut>,
    pub datastructs: Vec<DataStructOut>,
    pub sources: BTreeMap<String, Vec<String>>,
    pub kernels_csrc: Vec<KernelItem>,
    pub kernels_triton: Vec<KernelItem>,
    /// 抽象基类方法到实现类方法的边
    #[serde(default)]
    pub overrides: Vec<EdgeOut>,
    pub stats: Stats,
}
