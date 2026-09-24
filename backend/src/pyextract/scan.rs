//! 扫描符号：签名、字段、实例属性、不变式、调用边。

use super::index::Index;
use super::walk::{self, Node};
use super::{dotted_name, module_of_path, simple_type, PyFile};
use crate::model::*;
use rustpython_ast::{self as ast, Ranged};
use std::collections::BTreeMap;

const EXTERNAL_ROOTS: &[&str] = &[
    "torch", "F", "flashinfer", "triton", "tl", "logging", "os", "sys", "math", "time",
    "heapq", "re", "json", "functools", "itertools", "collections", "dataclasses",
    "contextlib", "typing", "asyncio", "signal", "struct", "gc", "inspect", "copy",
    "msgpack", "zmq", "numpy", "np", "enum", "abc", "warnings", "traceback", "argparse",
    "partial", "logger", "uvicorn", "fastapi", "openai", "transformers", "safetensors",
    "modelscope", "huggingface_hub", "pytest", "tqdm", "multiprocessing", "subprocess",
];

const BUILTINS: &[&str] = &[
    "len", "super", "isinstance", "issubclass", "range", "max", "min", "getattr", "setattr",
    "str", "int", "float", "bool", "bytes", "list", "dict", "set", "tuple", "type", "sorted",
    "sum", "all", "any", "zip", "enumerate", "map", "filter", "print", "repr", "hash", "id",
    "abs", "round", "divmod", "next", "iter", "open", "format", "vars", "dir", "callable",
    "ValueError", "RuntimeError", "TypeError", "KeyError", "IndexError", "AssertionError",
    "NotImplementedError", "Exception", "StopIteration", "AttributeError", "ZeroDivisionError",
    "FileNotFoundError", "OverflowError", "OSError", "ImportError", "KeyboardInterrupt",
    "object", "frozenset", "reversed", "slice", "property", "staticmethod", "classmethod",
    "hasattr", "globals", "locals", "exec", "eval", "input",
];

const CONTAINER_METHODS: &[&str] = &[
    "append", "extend", "insert", "remove", "pop", "clear", "copy", "count", "index",
    "sort", "reverse", "get", "keys", "values", "items", "update", "setdefault",
    "add", "discard", "union", "intersection", "difference", "push", "put", "join",
    "split", "strip", "lower", "upper", "startswith", "endswith", "getvalue",
];

const LIB_ALIASES: &[(&str, &str)] = &[
    ("Tensor", "torch"), ("Module", "torch"), ("Event", "torch"), ("CUDAGraph", "torch"),
    ("Stream", "torch"), ("nn", "torch"), ("device", "torch"), ("dtype", "torch"),
    ("Any", "typing"), ("Dict", "typing"), ("List", "typing"), ("Final", "typing"),
    ("None", "typing"), ("TypeAlias", "typing"), ("Tuple", "typing"), ("Set", "typing"),
    ("AutoTokenizer", "transformers"), ("AutoConfig", "transformers"),
    ("OpenAI", "openai"), ("Queue", "multiprocessing"), ("Request", "fastapi"),
    ("StreamingResponse", "fastapi"), ("PromptSession", "prompt_toolkit"),
];

fn normalize_lib(label: &str) -> String {
    let label = label.strip_prefix("external:").unwrap_or(label);
    let label = label.split(':').next().unwrap_or(label);
    let root = label.rsplit('.').next().unwrap_or(label);
    LIB_ALIASES
        .iter()
        .find(|(k, _)| *k == root)
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| root.to_string())
}

/// 调用解析结果
#[derive(Debug, Clone)]
pub struct Resolved {
    pub target: Option<String>,
    pub confidence: String,
    pub external: Option<String>,
}

impl Resolved {
    fn target(id: String, conf: &str) -> Self {
        Self { target: Some(id), confidence: conf.to_string(), external: None }
    }
    fn ext(lib: impl Into<String>) -> Self {
        Self { target: None, confidence: String::new(), external: Some(lib.into()) }
    }
    fn unresolved() -> Self {
        Self { target: None, confidence: "unresolved".to_string(), external: None }
    }
    fn module_ref() -> Self {
        Self { target: None, confidence: "module-ref".to_string(), external: None }
    }
    fn is_external(&self) -> bool {
        self.external.is_some()
    }
}

struct Scanner<'a> {
    f: &'a PyFile,
    idx: &'a Index,
}

impl<'a> Scanner<'a> {
    // ---------------- 类型推断 ----------------

    fn scope_types(
        &self,
        body: &[ast::Stmt],
        args: Option<&ast::Arguments>,
        cls_name: &str,
    ) -> BTreeMap<String, String> {
        let mut table: BTreeMap<String, String> = BTreeMap::new();
        if let Some(a) = args {
            for arg in a.posonlyargs.iter().chain(a.args.iter()).chain(a.kwonlyargs.iter()) {
                if let Some(ann) = &arg.def.annotation {
                    let t = simple_type(&ann.to_string());
                    if !t.is_empty() {
                        table.insert(arg.def.arg.to_string(), t);
                    }
                }
            }
        }
        let mut assigns: Vec<(String, &ast::Expr)> = Vec::new();
        for node in walk::own_body(body) {
            match node {
                Node::S(ast::Stmt::AnnAssign(a)) => {
                    if let ast::Expr::Name(n) = &*a.target {
                        let t = simple_type(&a.annotation.to_string());
                        if !t.is_empty() {
                            table.insert(n.id.to_string(), t);
                        }
                    }
                }
                Node::S(ast::Stmt::Assign(a)) => {
                    for t in &a.targets {
                        if let ast::Expr::Name(n) = t {
                            assigns.push((n.id.to_string(), &a.value));
                        }
                    }
                }
                _ => {}
            }
        }
        for (name, value) in assigns {
            if table.contains_key(&name) {
                continue;
            }
            let t = self.type_of_expr(value, &table, cls_name);
            if !t.is_empty() {
                table.insert(name, t);
            }
        }
        table
    }

    fn type_of_expr(
        &self,
        expr: &ast::Expr,
        scope: &BTreeMap<String, String>,
        cls_name: &str,
    ) -> String {
        match expr {
            ast::Expr::Name(n) => {
                let id = n.id.to_string();
                if (id == "self" || id == "cls") && !cls_name.is_empty() {
                    return cls_name.to_string();
                }
                if let Some(t) = scope.get(&id) {
                    return t.clone();
                }
                self.name_type(&id)
            }
            ast::Expr::Attribute(a) => {
                let base = self.type_of_expr(&a.value, scope, cls_name);
                if base.is_empty() {
                    return String::new();
                }
                if self.idx.by_module.contains_key(&base) {
                    return self
                        .idx
                        .module_symbol(&base, &a.attr.to_string())
                        .unwrap_or_default();
                }
                let t = self.idx.field_type(&base, &a.attr.to_string());
                if !t.is_empty() {
                    return self.idx.canonical(self.f, &t);
                }
                let attr = a.attr.to_string();
                if attr.chars().next().map(|c| c.is_ascii_uppercase()).unwrap_or(false)
                    && self.idx.is_class(&attr)
                {
                    return attr;
                }
                if !self.idx.is_class(&base) {
                    return base; // 外部库类型，继续向外传播
                }
                String::new()
            }
            ast::Expr::Call(c) => self.return_of_call(c, scope, cls_name),
            ast::Expr::IfExp(i) => {
                let a = self.type_of_expr(&i.body, scope, cls_name);
                if !a.is_empty() {
                    a
                } else {
                    self.type_of_expr(&i.orelse, scope, cls_name)
                }
            }
            ast::Expr::Subscript(s) => self.type_of_expr(&s.value, scope, cls_name),
            ast::Expr::Starred(s) => self.type_of_expr(&s.value, scope, cls_name),
            ast::Expr::Await(a) => self.type_of_expr(&a.value, scope, cls_name),
            _ => String::new(),
        }
    }

    fn name_type(&self, name: &str) -> String {
        if let Some(imp) = self.f.imports.get(name) {
            if imp.contains(':') {
                return self.idx.canonical(self.f, name);
            }
            return imp.clone();
        }
        if let Some(defs) = self.idx.module_defs.get(&self.f.module) {
            if let Some(sid) = defs.get(name) {
                let last = sid.rsplit('.').next().unwrap_or(sid);
                if last.chars().next().map(|c| c.is_ascii_uppercase()).unwrap_or(false) {
                    return last.to_string();
                }
            }
        }
        if self.idx.is_class(name) {
            return name.to_string();
        }
        String::new()
    }

    fn return_of_call(
        &self,
        call: &ast::ExprCall,
        scope: &BTreeMap<String, String>,
        cls_name: &str,
    ) -> String {
        match &*call.func {
            ast::Expr::Name(n) => {
                let name = n.id.to_string();
                if BUILTINS.contains(&name.as_str()) {
                    return String::new();
                }
                // 直接构造本项目里的类
                let local_cls = simple_type(&name);
                if !local_cls.is_empty() {
                    let canonical = self.idx.canonical(self.f, &local_cls);
                    if self.idx.is_class(&canonical) {
                        return canonical;
                    }
                }
                if let Some(imp) = self.f.imports.get(&name).cloned() {
                    if let Some((m, s)) = imp.split_once(':') {
                        let t = self.idx.func_return(m, s);
                        if !t.is_empty() {
                            return t;
                        }
                    }
                    // 无法从注解得到类型：外部模块的工厂返回模块名以便归类
                    if !self.idx.by_module.contains_key(&imp) {
                        return imp;
                    }
                }
                let t = self.idx.func_return(&self.f.module, &name);
                if !t.is_empty() {
                    return t;
                }
                for (m, rets) in &self.idx.module_returns {
                    if let Some(t) = rets.get(&name) {
                        let _ = m;
                        return t.clone();
                    }
                }
                String::new()
            }
            ast::Expr::Attribute(a) => {
                let base = self.type_of_expr(&a.value, scope, cls_name);
                if base.is_empty() {
                    return String::new();
                }
                self.idx.func_return(&base, &a.attr.to_string())
            }
            _ => String::new(),
        }
    }

    // ---------------- 调用解析 ----------------

    fn resolve_callee(
        &self,
        call: &ast::ExprCall,
        scope: &BTreeMap<String, String>,
        cls_name: &str,
    ) -> Resolved {
        let tgt = &*call.func;
        let root = dotted_name(tgt)
            .unwrap_or_else(|| tgt.to_string())
            .split('.')
            .next()
            .unwrap_or("")
            .to_string();
        if EXTERNAL_ROOTS.contains(&root.as_str()) {
            return Resolved::ext(normalize_lib(&root));
        }

        match tgt {
            ast::Expr::Name(n) => {
                let name = n.id.to_string();
                if BUILTINS.contains(&name.as_str()) {
                    return Resolved::ext("builtins");
                }
                if let Some(sid) = self.idx.module_symbol(&self.f.module, &name) {
                    return Resolved::target(sid, "resolved");
                }
                if let Some(imp) = self.f.imports.get(&name) {
                    let m = imp.split(':').next().unwrap_or(imp).to_string();
                    if self.idx.by_module.contains_key(&m) {
                        if let Some((_, s)) = imp.split_once(':') {
                            return match self.idx.module_symbol(&m, s) {
                                Some(sid) => Resolved::target(sid, "resolved"),
                                None => Resolved::module_ref(),
                            };
                        }
                        return Resolved::module_ref();
                    }
                    let lib = if m.is_empty() { name.clone() } else { m };
                    return Resolved::ext(normalize_lib(&lib));
                }
                Resolved::unresolved()
            }
            ast::Expr::Attribute(a) => {
                let attr = a.attr.to_string();
                let base_expr = &*a.value;
                // super().__init__() 这类内置构造
                if let ast::Expr::Call(inner) = base_expr {
                    if let ast::Expr::Name(n) = &*inner.func {
                        if BUILTINS.contains(&n.id.to_string().as_str()) {
                            return Resolved::ext("builtins");
                        }
                    }
                }
                let base = self.type_of_expr(base_expr, scope, cls_name);
                if !base.is_empty() {
                    if self.idx.by_module.contains_key(&base) {
                        return match self.idx.module_symbol(&base, &attr) {
                            Some(sid) => Resolved::target(sid, "resolved"),
                            None => Resolved::module_ref(),
                        };
                    }
                    if let Some(sid) = self.idx.method_id(&base, &attr) {
                        let d = dotted_name(base_expr).unwrap_or_default();
                        let conf = if d.starts_with("self.") { "inferred" } else { "resolved" };
                        return Resolved::target(sid, conf);
                    }
                    let ft = self.idx.field_type(&base, &attr);
                    if !ft.is_empty() && self.idx.is_class(&ft) {
                        if let Some(sid) = self.idx.method_id(&ft, "__call__") {
                            return Resolved::target(sid, "inferred");
                        }
                    }
                    if !self.idx.is_class(&base) {
                        return Resolved::ext(normalize_lib(&base));
                    }
                }
                if CONTAINER_METHODS.contains(&attr.as_str()) {
                    return Resolved::ext("builtin-method");
                }
                Resolved::unresolved()
            }
            _ => Resolved::unresolved(),
        }
    }

    // ---------------- 符号构造 ----------------

    fn signature(&self, node: &FnNode) -> (String, Vec<Param>, String) {
        let a = node.args();
        let mut params: Vec<Param> = Vec::new();
        let mut positional: Vec<&ast::ArgWithDefault> = Vec::new();
        positional.extend(a.posonlyargs.iter());
        positional.extend(a.args.iter());
        for (i, arg) in positional.iter().enumerate() {
            let name = arg.def.arg.to_string();
            if i == 0 && (name == "self" || name == "cls") {
                continue;
            }
            params.push(Param {
                name,
                annotation: arg.def.annotation.as_ref().map(|x| x.to_string()).unwrap_or_default(),
                default: arg.default.as_ref().map(|x| x.to_string()).unwrap_or_default(),
                kind: "pos".to_string(),
            });
        }
        for arg in &a.kwonlyargs {
            params.push(Param {
                name: arg.def.arg.to_string(),
                annotation: arg.def.annotation.as_ref().map(|x| x.to_string()).unwrap_or_default(),
                default: arg.default.as_ref().map(|x| x.to_string()).unwrap_or_default(),
                kind: "kw".to_string(),
            });
        }
        if let Some(v) = &a.vararg {
            params.push(Param {
                name: format!("*{}", v.arg),
                annotation: String::new(),
                default: String::new(),
                kind: "varargs".to_string(),
            });
        }
        if let Some(v) = &a.kwarg {
            params.push(Param {
                name: format!("**{}", v.arg),
                annotation: String::new(),
                default: String::new(),
                kind: "kwargs".to_string(),
            });
        }
        let ret = node.returns_str();
        let text = params
            .iter()
            .map(|p| {
                let mut s = p.name.clone();
                if !p.annotation.is_empty() {
                    s.push_str(": ");
                    s.push_str(&p.annotation);
                }
                if !p.default.is_empty() {
                    s.push_str(" = ");
                    s.push_str(&p.default);
                }
                s
            })
            .collect::<Vec<_>>()
            .join(", ");
        let sig = if ret.is_empty() {
            format!("{}({text})", node.name())
        } else {
            format!("{}({text}) -> {ret}", node.name())
        };
        (sig, params, ret)
    }

    fn scan_file(&self) -> Vec<SymbolOut> {
        let mut out = Vec::new();
        for stmt in &self.f.body {
            match stmt {
                ast::Stmt::ClassDef(c) => {
                    let cls_sym = self.scan_class(c);
                    let methods = self.scan_methods(c);
                    let mut cls_sym = cls_sym;
                    cls_sym.methods = methods.iter().map(|m| m.id.clone()).collect();
                    cls_sym.methods.sort();
                    // 构造期属性与不变式汇总到类上
                    for m in &methods {
                        if m.name != "__init__" && m.name != "__post_init__" {
                            continue;
                        }
                        let known: Vec<String> = cls_sym.attrs.iter().map(|a| a.name.clone()).collect();
                        for a in &m.attrs {
                            if !known.contains(&a.name) {
                                cls_sym.attrs.push(a.clone());
                            }
                        }
                        cls_sym.asserts.extend(m.asserts.clone());
                    }
                    out.push(cls_sym);
                    out.extend(methods);
                }
                ast::Stmt::FunctionDef(_) | ast::Stmt::AsyncFunctionDef(_) => {
                    let node = fn_node(stmt).unwrap();
                    out.push(self.scan_function(&node, None));
                }
                _ => {}
            }
        }
        out
    }

    fn scan_class(&self, c: &ast::StmtClassDef) -> SymbolOut {
        let (start, end) = super::span(c);
        let decorators: Vec<String> = c.decorator_list.iter().map(|d| d.to_string()).collect();
        let is_dc = decorators
            .iter()
            .any(|d| d.split('(').next().unwrap_or("").ends_with("dataclass"));
        let name = c.name.to_string();
        let (line, end_line) = (
            self.f.index.line_of(start),
            self.f.index.end_line_of(end),
        );
        let mut fields: Vec<FieldInfo> = Vec::new();
        for stmt in &c.body {
            match stmt {
                ast::Stmt::AnnAssign(a) => {
                    if let ast::Expr::Name(n) = &*a.target {
                        let default = a.value.as_ref().map(|v| v.to_string()).unwrap_or_default();
                        fields.push(FieldInfo {
                            name: n.id.to_string(),
                            annotation: a.annotation.to_string(),
                            default: if default.starts_with("field()") { String::new() } else { default.clone() },
                            init: !default.contains("init=False"),
                            origin: "annotation".to_string(),
                            line: self.f.index.line_of(super::span(a).0),
                        });
                    }
                }
                ast::Stmt::Assign(a) => {
                    for t in &a.targets {
                        if let ast::Expr::Name(n) = t {
                            fields.push(FieldInfo {
                                name: n.id.to_string(),
                                annotation: String::new(),
                                default: a.value.to_string(),
                                init: !is_dc,
                                origin: "class_attr".to_string(),
                                line: self.f.index.line_of(super::span(a).0),
                            });
                        }
                    }
                }
                _ => {}
            }
        }
        SymbolOut {
            id: format!("{}.{}", self.f.module, name),
            name: name.clone(),
            qualname: name.clone(),
            kind: "class".to_string(),
            module: self.f.module.clone(),
            group: module_of_path(&self.f.rel),
            file: self.f.rel.clone(),
            lineno: line,
            end_lineno: end_line,
            signature: String::new(),
            params: Vec::new(),
            returns: String::new(),
            decorators,
            bases: c.bases.iter().map(|b| b.to_string()).collect(),
            docstring: docstring_of(&c.body),
            fields,
            methods: Vec::new(),
            assignments: Vec::new(),
            attrs: Vec::new(),
            asserts: Vec::new(),
            is_dataclass: is_dc,
            is_property: false,
            loc: end_line - line + 1,
            calls: Vec::new(),
            unresolved: Vec::new(),
            external: Vec::new(),
            module_refs: Vec::new(),
            imports: self.f.import_map(),
        }
    }

    fn scan_methods(&self, c: &ast::StmtClassDef) -> Vec<SymbolOut> {
        let cname = c.name.to_string();
        let mut out = Vec::new();
        for stmt in &c.body {
            if let Some(node) = fn_node(stmt) {
                out.push(self.scan_function(&node, Some(&cname)));
            }
        }
        out
    }

    fn scan_function(&self, node: &FnNode, class_name: Option<&str>) -> SymbolOut {
        let cls = class_name.unwrap_or("");
        let (start, end) = node.span();
        let (line, end_line) = (self.f.index.line_of(start), self.f.index.end_line_of(end));
        let (sig, params, ret) = self.signature(node);
        let decorators: Vec<String> = node.decorators().iter().map(|d| d.to_string()).collect();
        let is_property = decorators
            .iter()
            .any(|d| d == "property" || d == "cached_property" || d.ends_with(".setter"));
        let qualname = if cls.is_empty() {
            node.name()
        } else {
            format!("{cls}.{}", node.name())
        };
        let scope = self.scope_types(node.body(), Some(node.args()), cls);

        let mut sym = SymbolOut {
            id: format!("{}.{}", self.f.module, qualname),
            name: node.name(),
            qualname: qualname.clone(),
            kind: if cls.is_empty() { "function".to_string() } else { "method".to_string() },
            module: self.f.module.clone(),
            group: module_of_path(&self.f.rel),
            file: self.f.rel.clone(),
            lineno: line,
            end_lineno: end_line,
            signature: sig,
            params,
            returns: ret,
            decorators,
            bases: Vec::new(),
            docstring: docstring_of(node.body()),
            fields: Vec::new(),
            methods: Vec::new(),
            assignments: Vec::new(),
            attrs: Vec::new(),
            asserts: Vec::new(),
            is_dataclass: false,
            is_property,
            loc: end_line - line + 1,
            calls: Vec::new(),
            unresolved: Vec::new(),
            external: Vec::new(),
            module_refs: Vec::new(),
            imports: self.f.import_map(),
        };

        for n in walk::own_body(node.body()) {
            match n {
                Node::S(ast::Stmt::Assign(a)) => {
                    for t in &a.targets {
                        self.record_assign(&mut sym, t, &a.value, node, &scope, cls);
                    }
                }
                Node::S(ast::Stmt::AnnAssign(a)) => {
                    let val = a.value.as_ref().map(|v| v.to_string()).unwrap_or_default();
                    self.record_assign_ann(
                        &mut sym,
                        &a.target,
                        &a.annotation,
                        &val,
                        a.value.as_deref(),
                        node,
                        &scope,
                        cls,
                    );
                }
                Node::S(ast::Stmt::Assert(a)) => {
                    // 用 AST 重建而非源码切片，避免保留冗余括号
                    let msg = a.msg.as_ref().map(|m| m.to_string()).unwrap_or_default();
                    let text = if msg.is_empty() {
                        format!("assert {}", a.test)
                    } else {
                        format!("assert {}, {}", a.test, msg)
                    };
                    sym.asserts.push(AssertInfo {
                        line: self.f.index.line_of(super::span(a).0),
                        text,
                        message: msg,
                    });
                }
                Node::E(expr @ ast::Expr::Call(c)) => {
                    let callee = dotted_name(&c.func).unwrap_or_else(|| c.func.to_string());
                    let r = self.resolve_callee(c, &scope, cls);
                    let at_line = self.f.index.line_of(super::span(c).0);
                    if let Some(lib) = r.external {
                        sym.external.push(ExternalCall { line: at_line, callee, lib });
                    } else if let Some(target) = r.target {
                        sym.calls.push(CallOut {
                            line: at_line,
                            callee,
                            target,
                            confidence: r.confidence,
                            text: truncate(&expr.to_string(), 200),
                        });
                    } else if r.confidence == "module-ref" {
                        sym.module_refs.push(SimpleCall {
                            line: at_line,
                            callee,
                            text: truncate(&expr.to_string(), 200),
                        });
                    } else {
                        sym.unresolved.push(SimpleCall {
                            line: at_line,
                            callee,
                            text: truncate(&expr.to_string(), 200),
                        });
                    }
                }
                _ => {}
            }
        }

        // 去重并按行号排序，与参考实现一致
        sym.calls.sort_by(|a, b| (a.line, &a.callee).cmp(&(b.line, &b.callee)));
        sym.calls.dedup_by(|a, b| a.line == b.line && a.callee == b.callee);
        sym.unresolved.sort_by(|a, b| (a.line, &a.callee).cmp(&(b.line, &b.callee)));
        sym.unresolved.dedup_by(|a, b| a.line == b.line && a.callee == b.callee);
        sym.external.sort_by(|a, b| (a.line, &a.callee).cmp(&(b.line, &b.callee)));
        sym.external.dedup_by(|a, b| a.line == b.line && a.callee == b.callee);
        sym.module_refs.sort_by(|a, b| (a.line, &a.callee).cmp(&(b.line, &b.callee)));
        sym.module_refs.dedup_by(|a, b| a.line == b.line && a.callee == b.callee);
        sym.assignments.sort_by(|a, b| (a.line, &a.target).cmp(&(b.line, &b.target)));
        sym.asserts.sort_by_key(|a| a.line);
        sym
    }

    fn record_assign(
        &self,
        sym: &mut SymbolOut,
        target: &ast::Expr,
        value: &ast::Expr,
        node: &FnNode,
        scope: &BTreeMap<String, String>,
        cls: &str,
    ) {
        let Some(d) = dotted_name(target) else { return };
        let line = self.f.index.line_of(super::span(target).0);
        sym.assignments.push(AssignmentOut {
            target: d.clone(),
            method: node.name(),
            line,
            value: truncate(&value.to_string(), 100),
        });
        self.maybe_attr(sym, &d, Some(value), line, String::new(), node, scope, cls);
    }

    #[allow(clippy::too_many_arguments)]
    fn record_assign_ann(
        &self,
        sym: &mut SymbolOut,
        target: &ast::Expr,
        annotation: &ast::Expr,
        value_text: &str,
        value: Option<&ast::Expr>,
        node: &FnNode,
        scope: &BTreeMap<String, String>,
        cls: &str,
    ) {
        let Some(d) = dotted_name(target) else { return };
        let line = self.f.index.line_of(super::span(target).0);
        sym.assignments.push(AssignmentOut {
            target: d.clone(),
            method: node.name(),
            line,
            value: truncate(value_text, 100),
        });
        self.maybe_attr(sym, &d, value, line, annotation.to_string(), node, scope, cls);
    }

    /// self.x = ... 记为该类的实例属性
    #[allow(clippy::too_many_arguments)]
    fn maybe_attr(
        &self,
        sym: &mut SymbolOut,
        dotted: &str,
        value: Option<&ast::Expr>,
        line: u32,
        ann_text: String,
        node: &FnNode,
        scope: &BTreeMap<String, String>,
        cls: &str,
    ) {
        let rest = match dotted.strip_prefix("self.") {
            Some(r) if !r.contains('.') => r.to_string(),
            _ => return,
        };
        if node.name() != "__init__" && node.name() != "__post_init__" {
            return;
        }
        if sym.attrs.iter().any(|a| a.name == rest) {
            return;
        }
        let ann = simple_type(&ann_text);
        let inferred = if !ann.is_empty() {
            ann
        } else if let Some(v) = value {
            let from_chain = self.type_of_expr(v, scope, cls);
            if from_chain.is_empty() {
                // 类型推断不出，退回到表达式字面量（如 None）
                simple_type(&v.to_string())
            } else {
                from_chain
            }
        } else {
            String::new()
        };
        sym.attrs.push(AttrInfo {
            name: rest,
            ty: inferred,
            line,
            value: value.map(|v| truncate(&v.to_string(), 100)).unwrap_or_default(),
        });
    }
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

enum FnNode<'a> {
    F(&'a ast::StmtFunctionDef),
    A(&'a ast::StmtAsyncFunctionDef),
}

fn fn_node(stmt: &ast::Stmt) -> Option<FnNode<'_>> {
    match stmt {
        ast::Stmt::FunctionDef(f) => Some(FnNode::F(f)),
        ast::Stmt::AsyncFunctionDef(f) => Some(FnNode::A(f)),
        _ => None,
    }
}

impl<'a> FnNode<'a> {
    fn name(&self) -> String {
        match self {
            FnNode::F(f) => f.name.to_string(),
            FnNode::A(f) => f.name.to_string(),
        }
    }
    fn args(&self) -> &'a ast::Arguments {
        match self {
            FnNode::F(f) => &f.args,
            FnNode::A(f) => &f.args,
        }
    }
    fn body(&self) -> &'a [ast::Stmt] {
        match self {
            FnNode::F(f) => &f.body,
            FnNode::A(f) => &f.body,
        }
    }
    fn decorators(&self) -> &'a [ast::Expr] {
        match self {
            FnNode::F(f) => &f.decorator_list,
            FnNode::A(f) => &f.decorator_list,
        }
    }
    fn returns_str(&self) -> String {
        match self {
            FnNode::F(f) => f.returns.as_ref().map(|r| r.to_string()).unwrap_or_default(),
            FnNode::A(f) => f.returns.as_ref().map(|r| r.to_string()).unwrap_or_default(),
        }
    }
    fn span(&self) -> (u32, u32) {
        match self {
            FnNode::F(f) => (f.start().to_u32(), f.end().to_u32()),
            FnNode::A(f) => (f.start().to_u32(), f.end().to_u32()),
        }
    }
}

/// 首条语句若是字符串常量，作为 docstring，按 inspect.cleandoc 的规则整理
fn docstring_of(body: &[ast::Stmt]) -> String {
    let Some(ast::Stmt::Expr(e)) = body.first() else {
        return String::new();
    };
    let ast::Expr::Constant(c) = &*e.value else {
        return String::new();
    };
    let ast::Constant::Str(s) = &c.value else {
        return String::new();
    };
    cleandoc(s)
}

fn cleandoc(s: &str) -> String {
    let mut lines: Vec<&str> = s.split('\n').collect();
    if let Some(first) = lines.first_mut() {
        *first = first.trim();
    }
    let indent = lines
        .iter()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start().len())
        .min()
        .unwrap_or(0);
    let mut out: Vec<String> = Vec::new();
    out.push(lines.first().unwrap_or(&"").to_string());
    for l in lines.iter().skip(1) {
        out.push(l.get(indent.min(l.len())..).unwrap_or("").to_string());
    }
    while out.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        out.pop();
    }
    out.join("\n").trim_end().to_string()
}

/// 扫描一个文件并返回其符号
pub fn scan_file(f: &PyFile, idx: &Index) -> Vec<SymbolOut> {
    Scanner { f, idx }.scan_file()
}
