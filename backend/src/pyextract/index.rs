//! 跨文件名字索引：类表、字段类型、方法 id、返回类型。
//!
//! 与 Python 参考实现同序：先建模块定义与返回类型，再按源码顺序扫类，
//! 类字段分三轮——注解、简单赋值、工厂调用与参数注解。

use super::walk::{self, Node};
use super::{dotted_name, simple_type, span, PyFile};
use rustpython_ast as ast;
use std::collections::BTreeMap;

/// 字段类型的待定来源
#[derive(Clone, Debug)]
enum Recipe {
    /// self.x = f(...)：通过 f 的返回注解推断
    Func {
        /// f 若来自别的模块，这里是 (module, symbol)
        imported: Option<(String, String)>,
        local_name: String,
        own_module: String,
    },
    /// self.x = 某个参数：用参数的注解
    ParamAnn(String),
}

#[derive(Default, Clone)]
pub struct ClassInfo {
    pub fields: BTreeMap<String, String>,
    pub returns: BTreeMap<String, String>,
    pub bases: Vec<String>,
    /// 方法名 -> 符号 id
    pub methods: BTreeMap<String, String>,
}

#[derive(Default)]
pub struct Index {
    pub by_module: BTreeMap<String, usize>,
    pub classes: BTreeMap<String, ClassInfo>,
    /// module -> 名字 -> 符号 id，或以 "@mod:sym" / "@mod" 表示再导出
    pub module_defs: BTreeMap<String, BTreeMap<String, String>>,
    pub module_returns: BTreeMap<String, BTreeMap<String, String>>,
    /// 类名 -> 定义它的类所在文件下标，用于别名还原
    pub class_file: BTreeMap<String, usize>,
}

impl Index {
    pub fn build(files: &[PyFile]) -> Self {
        let mut me = Index::default();
        for (i, f) in files.iter().enumerate() {
            me.by_module.insert(f.module.clone(), i);
        }
        me.build_module_defs(files);
        me.build_module_returns(files);
        me.build_classes(files);
        me
    }

    fn build_module_defs(&mut self, files: &[PyFile]) {
        for f in files {
            let mut defs: BTreeMap<String, String> = BTreeMap::new();
            for stmt in &f.body {
                match stmt {
                    ast::Stmt::FunctionDef(n) => {
                        let name = n.name.to_string();
                        defs.insert(name.clone(), format!("{}.{}", f.module, name));
                    }
                    ast::Stmt::AsyncFunctionDef(n) => {
                        let name = n.name.to_string();
                        defs.insert(name.clone(), format!("{}.{}", f.module, name));
                    }
                    ast::Stmt::ClassDef(n) => {
                        let name = n.name.to_string();
                        defs.insert(name.clone(), format!("{}.{}", f.module, name));
                    }
                    ast::Stmt::Assign(a) => {
                        for t in &a.targets {
                            if let ast::Expr::Name(n) = t {
                                let name = n.id.to_string();
                                defs.insert(name.clone(), format!("{}.{}", f.module, name));
                            }
                        }
                    }
                    ast::Stmt::ImportFrom(n) => {
                        let modname = n.module.as_ref().map(|m| m.to_string());
                        let level = n.level.map(|l| l.to_u32()).unwrap_or(0);
                        let base = f.resolve_relative_pub(level, modname.as_deref());
                        for alias in &n.names {
                            let name = alias.name.to_string();
                            if name == "*" {
                                continue;
                            }
                            let local = alias
                                .asname
                                .as_ref()
                                .map(|a| a.to_string())
                                .unwrap_or_else(|| name.clone());
                            defs.insert(local, format!("@{base}:{name}"));
                        }
                    }
                    ast::Stmt::Import(n) => {
                        for alias in &n.names {
                            let full = alias.name.to_string();
                            let local = alias
                                .asname
                                .as_ref()
                                .map(|a| a.to_string())
                                .unwrap_or_else(|| full.split('.').next().unwrap_or(&full).to_string());
                            defs.insert(local, format!("@{full}"));
                        }
                    }
                    _ => {}
                }
            }
            self.module_defs.insert(f.module.clone(), defs);
        }
    }

    fn build_module_returns(&mut self, files: &[PyFile]) {
        for f in files {
            let mut m: BTreeMap<String, String> = BTreeMap::new();
            for (k, v) in &f.return_types {
                m.entry(k.clone()).or_insert_with(|| v.clone());
            }
            self.module_returns.insert(f.module.clone(), m);
        }
    }

    fn build_classes(&mut self, files: &[PyFile]) {
        for (fi, f) in files.iter().enumerate() {
            let mut classes: Vec<&ast::StmtClassDef> = Vec::new();
            collect_classes(&f.body, &mut classes);
            for cls in classes {
                let name = cls.name.to_string();
                if self.classes.contains_key(&name) {
                    continue; // 与 Python 的 setdefault 一致：先出现者胜
                }
                self.class_file.insert(name.clone(), fi);
                let info = self.scan_class(f, cls);
                self.classes.insert(name, info);
            }
        }
    }

    fn scan_class(&self, f: &PyFile, cls: &ast::StmtClassDef) -> ClassInfo {
        let mut info = ClassInfo::default();
        info.bases = cls.bases.iter().map(|b| base_name(b)).collect();

        // 第一轮：类级注解与类属性默认值
        for stmt in &cls.body {
            match stmt {
                ast::Stmt::AnnAssign(a) => {
                    if let ast::Expr::Name(n) = &*a.target {
                        let t = simple_type(&a.annotation.to_string());
                        if !t.is_empty() {
                            info.fields.insert(n.id.to_string(), self.canonical(f, &t));
                        }
                    }
                }
                ast::Stmt::FunctionDef(fd) => {
                    if let Some(r) = &fd.returns {
                        let t = simple_type(&r.to_string());
                        if !t.is_empty() {
                            info.returns.insert(fd.name.to_string(), t);
                        }
                    }
                }
                ast::Stmt::AsyncFunctionDef(fd) => {
                    if let Some(r) = &fd.returns {
                        let t = simple_type(&r.to_string());
                        if !t.is_empty() {
                            info.returns.insert(fd.name.to_string(), t);
                        }
                    }
                }
                _ => {}
            }
        }
        // 方法 id 表（含静态/异步方法）
        for stmt in &cls.body {
            let mname = match stmt {
                ast::Stmt::FunctionDef(m) => Some(m.name.to_string()),
                ast::Stmt::AsyncFunctionDef(m) => Some(m.name.to_string()),
                _ => None,
            };
            if let Some(m) = mname {
                info.methods
                    .insert(m.clone(), format!("{}.{}.{}", f.module, cls.name, m));
            }
        }

        // 第二轮：self.x 的简单类型与待定来源
        let mut pending: Vec<(String, Recipe)> = Vec::new();
        for stmt in &cls.body {
            let (body, params): (&[ast::Stmt], BTreeMap<String, String>) = match stmt {
                ast::Stmt::FunctionDef(m) => (&m.body, self.arg_annots(&m.args)),
                ast::Stmt::AsyncFunctionDef(m) => (&m.body, self.arg_annots(&m.args)),
                _ => continue,
            };
            for node in walk::own_body(body) {
                match node {
                    Node::S(ast::Stmt::Assign(a)) => {
                        for t in &a.targets {
                            let Some(d) = dotted_name(t) else { continue };
                            let Some(fname) = self_field(&d) else { continue };
                            let t = simple_type(&a.value.to_string());
                            if !t.is_empty() {
                                info.fields
                                    .entry(fname)
                                    .or_insert_with(|| self.canonical(f, &t));
                            } else if let ast::Expr::Call(c) = &*a.value {
                                pending.push((fname, self.recipe_for(f, c)));
                            } else if let ast::Expr::Name(n) = &*a.value {
                                if let Some(ann) = params.get(&n.id.to_string()) {
                                    pending.push((fname, Recipe::ParamAnn(ann.clone())));
                                }
                            }
                        }
                    }
                    Node::S(ast::Stmt::AnnAssign(a)) => {
                        let Some(d) = dotted_name(&a.target) else { continue };
                        let Some(fname) = self_field(&d) else { continue };
                        let ann = simple_type(&a.annotation.to_string());
                        let val = a
                            .value
                            .as_ref()
                            .map(|v| simple_type(&v.to_string()))
                            .unwrap_or_default();
                        let t = if ann.is_empty() { val } else { ann };
                        if !t.is_empty() {
                            info.fields
                                .entry(fname)
                                .or_insert_with(|| self.canonical(f, &t));
                        }
                    }
                    _ => {}
                }
            }
        }
        // 第三轮：把待定来源落到返回注解上
        for (fname, recipe) in pending {
            let t = match recipe {
                Recipe::Func {
                    imported,
                    local_name,
                    own_module,
                } => {
                    let mut found = String::new();
                    if let Some((m, s)) = imported {
                        found = self.func_return(&m, &s);
                    }
                    if found.is_empty() {
                        found = self.func_return(&own_module, &local_name);
                    }
                    if found.is_empty() {
                        // 兜底：同名函数出现在别处
                        for (m, rets) in &self.module_returns {
                            if let Some(t) = rets.get(&local_name) {
                                found = t.clone();
                                let _ = m;
                                break;
                            }
                        }
                    }
                    found
                }
                Recipe::ParamAnn(ann) => simple_type(&ann),
            };
            if !t.is_empty() {
                info.fields
                    .entry(fname)
                    .or_insert_with(|| self.canonical(f, &t));
            }
        }
        info
    }

    fn arg_annots(&self, args: &ast::Arguments) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for a in args.posonlyargs.iter().chain(args.args.iter()) {
            if let Some(ann) = &a.def.annotation {
                out.insert(a.def.arg.to_string(), ann.to_string());
            }
        }
        for a in &args.kwonlyargs {
            if let Some(ann) = &a.def.annotation {
                out.insert(a.def.arg.to_string(), ann.to_string());
            }
        }
        out
    }

    fn recipe_for(&self, f: &PyFile, call: &ast::ExprCall) -> Recipe {
        match &*call.func {
            ast::Expr::Name(n) => {
                let name = n.id.to_string();
                let imported = f.imports.get(&name).and_then(|v| {
                    v.split_once(':')
                        .map(|(m, s)| (m.to_string(), s.to_string()))
                });
                Recipe::Func {
                    imported,
                    local_name: name,
                    own_module: f.module.clone(),
                }
            }
            ast::Expr::Attribute(a) => {
                // self.other().method() 这类少见，交给 Result 为空处理
                Recipe::Func {
                    imported: None,
                    local_name: a.attr.to_string(),
                    own_module: f.module.clone(),
                }
            }
            _ => Recipe::Func {
                imported: None,
                local_name: String::new(),
                own_module: f.module.clone(),
            },
        }
    }

    // ---------------- 查询 ----------------

    /// 顺着导入别名还原真实类名，如 Qwen3Attn -> RopeAttn
    pub fn canonical(&self, f: &PyFile, name: &str) -> String {
        let mut cur = name.to_string();
        for _ in 0..4 {
            if cur.is_empty() || self.classes.contains_key(&cur) {
                return cur;
            }
            let Some(imp) = f.imports.get(&cur) else {
                return cur;
            };
            match imp.split_once(':') {
                Some((m, s)) => {
                    cur = match self.module_symbol(m, s) {
                        Some(sid) => sid.rsplit('.').next().unwrap_or(s).to_string(),
                        None => s.to_string(),
                    };
                }
                None => return imp.to_string(),
            }
        }
        cur
    }

    pub fn field_type(&self, cls: &str, field_name: &str) -> String {
        let mut seen: Vec<String> = Vec::new();
        let mut queue: Vec<String> = vec![cls.to_string()];
        while let Some(cur) = queue.pop() {
            if cur.is_empty() || seen.contains(&cur) {
                continue;
            }
            seen.push(cur.clone());
            if let Some(info) = self.classes.get(&cur) {
                if let Some(t) = info.fields.get(field_name) {
                    return t.clone();
                }
                for b in &info.bases {
                    queue.push(base_last(b));
                }
            }
        }
        String::new()
    }

    pub fn method_id(&self, cls: &str, method: &str) -> Option<String> {
        let mut seen: Vec<String> = Vec::new();
        let mut queue: Vec<String> = vec![cls.to_string()];
        while let Some(cur) = queue.pop() {
            if cur.is_empty() || seen.contains(&cur) {
                continue;
            }
            seen.push(cur.clone());
            if let Some(info) = self.classes.get(&cur) {
                if let Some(sid) = info.methods.get(method) {
                    return Some(sid.clone());
                }
                for b in &info.bases {
                    queue.push(base_last(b));
                }
            }
        }
        None
    }

    pub fn method_return(&self, cls: &str, method: &str) -> String {
        let mut seen: Vec<String> = Vec::new();
        let mut queue: Vec<String> = vec![cls.to_string()];
        while let Some(cur) = queue.pop() {
            if cur.is_empty() || seen.contains(&cur) {
                continue;
            }
            seen.push(cur.clone());
            if let Some(info) = self.classes.get(&cur) {
                if let Some(t) = info.returns.get(method) {
                    return t.clone();
                }
                for b in &info.bases {
                    queue.push(base_last(b));
                }
            }
        }
        String::new()
    }

    /// 穿透导入再导出，拿到最终符号 id
    pub fn module_symbol(&self, module: &str, name: &str) -> Option<String> {
        let mut mod_name = module.to_string();
        let mut sym = name.to_string();
        for _ in 0..8 {
            let defs = self.module_defs.get(&mod_name)?;
            let v = defs.get(&sym)?;
            if let Some(rest) = v.strip_prefix('@') {
                match rest.split_once(':') {
                    Some((m, s)) => {
                        mod_name = m.to_string();
                        sym = s.to_string();
                        continue;
                    }
                    None => return None,
                }
            }
            return Some(v.clone());
        }
        None
    }

    /// owner 可以是类名或模块点号名
    pub fn func_return(&self, owner: &str, func: &str) -> String {
        if self.classes.contains_key(owner) {
            return self.method_return(owner, func);
        }
        if let Some(rets) = self.module_returns.get(owner) {
            if let Some(t) = rets.get(func) {
                return t.clone();
            }
        }
        String::new()
    }

    pub fn method_exists(&self, cls: &str, method: &str) -> bool {
        self.method_id(cls, method).is_some()
    }

    /// 类是否在索引里（含别名还原后）
    pub fn is_class(&self, name: &str) -> bool {
        self.classes.contains_key(name)
    }

    pub fn find_file(&self, module: &str, files: &[PyFile]) -> Option<usize> {
        self.by_module.get(module).copied().filter(|i| *i < files.len())
    }
}

/// 从 self.foo 里取出 foo，只处理一层
fn self_field(dotted: &str) -> Option<String> {
    let rest = dotted.strip_prefix("self.")?;
    if rest.contains('.') {
        return None;
    }
    Some(rest.to_string())
}

fn base_name(e: &ast::Expr) -> String {
    e.to_string()
}

fn base_last(s: &str) -> String {
    let head = s.split('[').next().unwrap_or(s);
    head.rsplit('.').next().unwrap_or(head).trim().to_string()
}

fn collect_classes<'a>(body: &'a [ast::Stmt], out: &mut Vec<&'a ast::StmtClassDef>) {
    for stmt in body {
        match stmt {
            ast::Stmt::ClassDef(c) => {
                out.push(c);
                collect_classes(&c.body, out);
            }
            ast::Stmt::FunctionDef(f) => collect_classes(&f.body, out),
            ast::Stmt::AsyncFunctionDef(f) => collect_classes(&f.body, out),
            ast::Stmt::If(s) => {
                collect_classes(&s.body, out);
                collect_classes(&s.orelse, out);
            }
            ast::Stmt::Try(s) => {
                collect_classes(&s.body, out);
                collect_classes(&s.orelse, out);
                collect_classes(&s.finalbody, out);
            }
            ast::Stmt::With(s) => collect_classes(&s.body, out),
            ast::Stmt::For(s) => collect_classes(&s.body, out),
            ast::Stmt::While(s) => collect_classes(&s.body, out),
            _ => {}
        }
    }
}

/// 供 assert 文本切片使用
pub fn assert_text(src: &str, node: &impl rustpython_ast::Ranged) -> String {
    let (s, e) = span(node);
    src.get(s as usize..e as usize).unwrap_or("").to_string()
}
