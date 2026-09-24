//! 静态抽取：把 mini-sglang 源码变成 data/*.json。

use crate::csrc;
use crate::model::*;
use crate::pyextract::index::Index;
use crate::pyextract::scan;
use crate::pyextract::{module_of_path, PyFile};
use anyhow::{Context, Result};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const MODULE_INFO: &[(&str, &str, &str)] = &[
    ("core", "全局上下文，以及 Req / Batch / SamplingParams 等核心结构", "core.py"),
    ("env", "环境变量读取与默认值", "env.py"),
    ("shell", "交互式 shell 入口", "shell.py"),
    ("attention", "三种 attention 后端与元数据准备", "attention/"),
    ("distributed", "TP 信息与通信实现切换", "distributed/"),
    ("engine", "模型执行、KV 池、CUDA Graph、采样", "engine/"),
    ("kernel", "Triton 与 CUDA 算子及其加载", "kernel/"),
    ("kvcache", "KV 池与 Radix 前缀缓存", "kvcache/"),
    ("layers", "线性层、归一化、RoPE、词嵌入", "layers/"),
    ("llm", "离线单进程推理入口", "llm/"),
    ("message", "跨进程消息定义与序列化", "message/"),
    ("models", "模型结构与权重加载", "models/"),
    ("moe", "MoE 后端", "moe/"),
    ("scheduler", "调度主循环与资源管理器", "scheduler/"),
    ("server", "HTTP 服务与进程拉起", "server/"),
    ("tokenizer", "分词与增量解码", "tokenizer/"),
    ("utils", "通用工具：ZMQ 队列、日志、注册表", "utils/"),
    ("benchmark", "压测工具与指标统计", "benchmark/"),
];

/// 取基类名里最后一段，如 BaseOP[T] -> BaseOP
fn base_last(s: &str) -> String {
    let head = s.split('[').next().unwrap_or(s);
    head.rsplit('.').next().unwrap_or(head).trim().to_string()
}

pub fn collect_py_files(python_root: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = walkdir::WalkDir::new(python_root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().map(|x| x == "py").unwrap_or(false))
        .map(|e| e.into_path())
        .filter(|p| {
            !p.components().any(|c| {
                let s = c.as_os_str().to_string_lossy();
                s == "__pycache__" || s == ".venv" || s == ".idea" || s.ends_with(".egg-info")
            })
        })
        .collect();
    out.sort();
    out
}

pub fn extract(src: &Path, out: &Path) -> Result<PathBuf> {
    let src_root = src.to_path_buf();
    let python_root = src.join("python");
    anyhow::ensure!(python_root.exists(), "{} 下没有 python 目录", src.display());

    let mut files: Vec<PyFile> = Vec::new();
    for p in collect_py_files(&python_root) {
        match PyFile::load(&p, &src_root) {
            Ok(f) => files.push(f),
            Err(e) => eprintln!("跳过：{e}"),
        }
    }
    let index = Index::build(&files);

    let mut symbols: BTreeMap<String, SymbolOut> = BTreeMap::new();
    let mut file_out: BTreeMap<String, FileOut> = BTreeMap::new();
    let mut edges: BTreeMap<(String, String), EdgeAgg> = BTreeMap::new();
    let mut external_counts: BTreeMap<String, u32> = BTreeMap::new();

    for f in &files {
        let syms = scan::scan_file(f, &index);
        let ids: Vec<String> = syms.iter().map(|s| s.id.clone()).collect();
        file_out.insert(
            f.rel.clone(),
            FileOut {
                path: f.rel.clone(),
                module: f.module.clone(),
                group: module_of_path(&f.rel),
                loc: f.lines.len() as u32,
                symbols: ids,
            },
        );
        for s in syms {
            for c in &s.calls {
                let key = (s.id.clone(), c.target.clone());
                let e = edges.entry(key).or_insert_with(|| EdgeAgg {
                    from: s.id.clone(),
                    to: c.target.clone(),
                    count: 0,
                    confidence: c.confidence.clone(),
                    lines: Vec::new(),
                });
                e.count += 1;
                if e.lines.len() < 8 {
                    e.lines.push(c.line);
                }
                if e.confidence != c.confidence {
                    e.confidence = "inferred".to_string();
                }
            }
            for e in &s.external {
                *external_counts.entry(e.lib.clone()).or_insert(0) += 1;
            }
            symbols.insert(s.id.clone(), s);
        }
    }

    let mut edge_out: Vec<EdgeOut> = edges
        .into_values()
        .map(|e| EdgeOut {
            from: e.from,
            to: e.to,
            count: e.count,
            confidence: e.confidence,
            lines: e.lines,
        })
        .collect();
    edge_out.sort_by(|a, b| (&a.from, &a.to).cmp(&(&b.from, &b.to)));

    // 抽象基类方法与实现类方法之间补一条 override 边。
    // 静态调用解析只能看到 ABC 上的接口方法，读代码时真正想跳的是实现，
    // 所以这里显式建立这条边，由前端画成虚线区分。
    let mut overrides: Vec<EdgeOut> = Vec::new();
    // 类 -> 方法名 -> 符号 id
    let mut method_of: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    let mut bases_of: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for sym in symbols.values() {
        if sym.kind != "class" {
            continue;
        }
        bases_of.insert(sym.name.clone(), sym.bases.iter().map(|b| base_last(b)).collect());
        let entry = method_of.entry(sym.name.clone()).or_default();
        for m in &sym.methods {
            if let Some(last) = m.rsplit('.').next() {
                entry.insert(last.to_string(), m.clone());
            }
        }
    }
    for (cls, methods) in &method_of {
        // 沿基类链向上找同名方法
        let mut seen: Vec<String> = Vec::new();
        let mut queue: Vec<String> = bases_of.get(cls).cloned().unwrap_or_default();
        while let Some(b) = queue.pop() {
            if b.is_empty() || seen.contains(&b) {
                continue;
            }
            seen.push(b.clone());
            if let Some(bm) = method_of.get(&b) {
                for (name, id) in methods {
                    if let Some(base_id) = bm.get(name) {
                        overrides.push(EdgeOut {
                            from: base_id.clone(),
                            to: id.clone(),
                            count: 1,
                            confidence: "override".to_string(),
                            lines: Vec::new(),
                        });
                    }
                }
            }
            queue.extend(bases_of.get(&b).cloned().unwrap_or_default());
        }
    }
    overrides.sort_by(|a, b| (&a.from, &a.to).cmp(&(&b.from, &b.to)));
    overrides.dedup_by(|a, b| a.from == b.from && a.to == b.to);

    // 数据结构：dataclass、NamedTuple，以及有实例属性或注解字段的普通类
    let mut datastructs: Vec<DataStructOut> = Vec::new();
    for s in symbols.values() {
        if s.kind != "class" {
            continue;
        }
        let is_nt = s.bases.iter().any(|b| b.contains("NamedTuple"));
        let ann_fields = s.fields.iter().filter(|f| f.origin == "annotation").count();
        if !(s.is_dataclass || is_nt || ann_fields >= 2 || s.attrs.len() >= 3) {
            continue;
        }
        datastructs.push(DataStructOut {
            id: s.id.clone(),
            name: s.name.clone(),
            module: s.module.clone(),
            group: s.group.clone(),
            file: s.file.clone(),
            lineno: s.lineno,
            end_lineno: s.end_lineno,
            docstring: s.docstring.clone(),
            bases: s.bases.clone(),
            kind: if is_nt {
                "namedtuple".to_string()
            } else if s.is_dataclass {
                "dataclass".to_string()
            } else {
                "class".to_string()
            },
            fields: s.fields.clone(),
            attrs: s.attrs.clone(),
            methods: s.methods.clone(),
            asserts: s.asserts.clone(),
            assignments: s.assignments.clone(),
        });
    }
    datastructs.sort_by(|a, b| (&a.group, &a.name).cmp(&(&b.group, &b.name)));

    // 模块清单
    let mut groups: BTreeMap<String, ModuleOut> = BTreeMap::new();
    for (rel, info) in &file_out {
        let g = info.group.clone();
        let entry = groups.entry(g.clone()).or_insert_with(|| {
            let meta = MODULE_INFO.iter().find(|(n, _, _)| *n == g);
            ModuleOut {
                name: g.clone(),
                files: Vec::new(),
                loc: 0,
                other_files: Vec::new(),
                description: meta.map(|m| m.1.to_string()).unwrap_or_default(),
                path_hint: meta.map(|m| m.2.to_string()).unwrap_or_else(|| g.clone()),
            }
        });
        entry.files.push(rel.clone());
        entry.loc += info.loc;
    }
    let csrc_root = python_root.join("minisgl/kernel/csrc");
    let triton_root = python_root.join("minisgl/kernel/triton");
    for sub in [&csrc_root, &triton_root] {
        if let Some(entry) = groups.get_mut("kernel") {
            if sub.exists() {
                let mut others: Vec<String> = walkdir::WalkDir::new(sub)
                    .into_iter()
                    .filter_map(|e| e.ok())
                    .filter(|e| e.file_type().is_file())
                    .map(|e| {
                        e.path()
                            .strip_prefix(&src_root)
                            .unwrap_or(e.path())
                            .to_string_lossy()
                            .replace('\\', "/")
                    })
                    .collect();
                others.sort();
                entry.other_files.extend(others);
            }
        }
    }
    for entry in groups.values_mut() {
        entry.files.sort();
        entry.other_files.sort();
    }
    let mut modules: Vec<ModuleOut> = groups.into_values().collect();
    modules.sort_by(|a, b| b.loc.cmp(&a.loc).then(a.name.cmp(&b.name)));

    // 源码
    let mut sources: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for f in &files {
        sources.insert(f.rel.clone(), f.lines.clone());
    }
    if let Some(kernel) = modules.iter().find(|m| m.name == "kernel") {
        for rel in &kernel.other_files {
            if let Ok(text) = std::fs::read_to_string(src_root.join(rel)) {
                sources.insert(
                    rel.clone(),
                    text.lines().map(|l| l.to_string()).collect(),
                );
            }
        }
    }

    let kernels_csrc = csrc::scan_csrc_files(&csrc_root, &src_root);
    let kernels_triton = csrc::scan_triton_files(&triton_root, &src_root, &index)?;

    let mut external_top: Vec<(String, u32)> = external_counts.iter().map(|(k, v)| (k.clone(), *v)).collect();
    external_top.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    external_top.truncate(20);

    let stats = Stats {
        py_files: files.len() as u32,
        py_loc: files.iter().map(|f| f.lines.len() as u32).sum(),
        symbols: symbols.len() as u32,
        classes: symbols.values().filter(|s| s.kind == "class").count() as u32,
        functions: symbols.values().filter(|s| s.kind == "function").count() as u32,
        methods: symbols.values().filter(|s| s.kind == "method").count() as u32,
        edges: edge_out.len() as u32,
        resolved_edges: edge_out.iter().filter(|e| e.confidence == "resolved").count() as u32,
        inferred_edges: edge_out.iter().filter(|e| e.confidence == "inferred").count() as u32,
        unresolved_calls: symbols.values().map(|s| s.unresolved.len() as u32).sum(),
        external_calls: external_top.iter().map(|x| x.1).sum::<u32>(),
        datastructs: datastructs.len() as u32,
        csrc_symbols: kernels_csrc.len() as u32,
        triton_symbols: kernels_triton.len() as u32,
        modules: modules.len() as u32,
        external_top,
    };

    std::fs::create_dir_all(out).with_context(|| format!("创建 {}", out.display()))?;
    write_json(&out.join("symbols.json"), &symbols)?;
    write_json(&out.join("edges.json"), &edge_out)?;
    write_json(&out.join("files.json"), &file_out)?;
    write_json(&out.join("modules.json"), &modules)?;
    write_json(&out.join("datastructs.json"), &datastructs)?;
    write_json(&out.join("sources.json"), &sources)?;
    write_json(
        &out.join("kernels.json"),
        &serde_json::json!({ "csrc": kernels_csrc, "triton": kernels_triton }),
    )?;
    write_json(&out.join("overrides.json"), &overrides)?;
    write_json(&out.join("stats.json"), &stats)?;

    println!("{}", serde_json::to_string_pretty(&stats)?);
    Ok(out.to_path_buf())
}

pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let text = serde_json::to_string(value)?;
    let kb = text.len() / 1024;
    std::fs::write(path, text).with_context(|| format!("写出 {}", path.display()))?;
    println!("  {} ({} KB)", path.display(), kb);
    Ok(())
}


/// 把抽取产物读回来（供服务使用）
pub fn load_output(data: &Path) -> Result<ExtractOutput> {
    let read = |name: &str| -> Result<serde_json::Value> {
        let p = data.join(name);
        let text = std::fs::read_to_string(&p).with_context(|| format!("读取 {}", p.display()))?;
        Ok(serde_json::from_str(&text)?)
    };
    Ok(ExtractOutput {
        symbols: serde_json::from_value(read("symbols.json")?)?,
        edges: serde_json::from_value(read("edges.json")?)?,
        files: serde_json::from_value(read("files.json")?)?,
        modules: serde_json::from_value(read("modules.json")?)?,
        datastructs: serde_json::from_value(read("datastructs.json")?)?,
        sources: serde_json::from_value(read("sources.json")?)?,
        kernels_csrc: Vec::new(),
        kernels_triton: Vec::new(),
        overrides: {
            let p = data.join("overrides.json");
            if p.exists() {
                serde_json::from_str(&std::fs::read_to_string(&p)?)?
            } else {
                Vec::new()
            }
        },
        stats: serde_json::from_value(read("stats.json")?)?,
    })
}
