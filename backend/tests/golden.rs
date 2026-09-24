//! 与 golden 快照的结构对等测试。
//!
//! golden 来自 `tools/reference-extractor/extract.py`（独立实现的 Python 版，
//! 已通过 tools/verify.py 的事实校验）。Rust 移植的正确性由本测试守住：
//! 结构性字段要求完全一致，少数已知且已记录的差异按上限容忍。
//!
//! 运行：`cargo test --test golden`（需要 ../mini-sglang 存在，或用 MINISGL_SRC 指定）

use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn mini_sglang_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MINISGL_SRC") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let guess = manifest().join("../../mini-sglang");
    guess.exists().then_some(guess)
}

fn load(path: &Path) -> Value {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("读取 {} 失败: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("解析 {} 失败: {e}", path.display()))
}

fn arr(v: &Value, key: &str) -> Vec<Value> {
    v.get(key)
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default()
}

fn obj_keys(v: &Value) -> BTreeSet<String> {
    v.as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

fn norm(s: &str) -> String {
    s.replace('"', "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// 一次抽取，返回数据目录
fn run_extract() -> Option<PathBuf> {
    let root = mini_sglang_root()?;
    let out = std::env::temp_dir().join("minisgl-viz-golden");
    let _ = std::fs::remove_dir_all(&out);
    minisgl_viz::extract::extract(&root, &out).expect("抽取失败");
    Some(out)
}

#[test]
fn golden_parity() {
    let Some(out) = run_extract() else {
        eprintln!("跳过：找不到 mini-sglang 源码，用 MINISGL_SRC 指定");
        return;
    };
    let golden = manifest().join("tests/golden");

    let rs = load(&out.join("symbols.json"));
    let gs = load(&golden.join("symbols.json"));
    let re = load(&out.join("edges.json"));
    let ge = load(&golden.join("edges.json"));

    // 1. 符号集合必须完全一致
    let rs_ids = obj_keys(&rs);
    let gs_ids = obj_keys(&gs);
    let missing: Vec<&String> = gs_ids.difference(&rs_ids).collect();
    let extra: Vec<&String> = rs_ids.difference(&gs_ids).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "符号集合不一致：缺失 {} 个（{:?}），多出 {} 个（{:?}）",
        missing.len(),
        &missing[..missing.len().min(5)],
        extra.len(),
        &extra[..extra.len().min(5)]
    );

    // 2. 逐符号的结构性字段必须一致
    let mut field_diffs: Vec<String> = Vec::new();
    let mut text_diffs: Vec<String> = Vec::new();
    let mut call_diffs: Vec<String> = Vec::new();
    let mut unresolved_diffs: Vec<String> = Vec::new();
    let mut external_diffs: Vec<String> = Vec::new();
    let mut attr_diffs: Vec<String> = Vec::new();
    let mut assert_diffs: Vec<String> = Vec::new();

    for id in &gs_ids {
        let (r, g) = (&rs[id], &gs[id]);
        for f in ["kind", "name", "qualname", "module", "group", "file", "lineno",
                  "end_lineno", "loc", "is_dataclass", "is_property"] {
            if r.get(f) != g.get(f) {
                field_diffs.push(format!("{id}.{f}: {} vs {}", r.get(f).unwrap_or(&Value::Null), g.get(f).unwrap_or(&Value::Null)));
            }
        }
        for f in ["signature", "returns"] {
            let a = norm(r.get(f).and_then(|x| x.as_str()).unwrap_or(""));
            let b = norm(g.get(f).and_then(|x| x.as_str()).unwrap_or(""));
            if a != b {
                text_diffs.push(format!("{id}.{f}: {a} vs {b}"));
            }
        }
        let cs = |v: &Value, key: &str, f: fn(&Value) -> String| -> BTreeSet<String> {
            arr(v, key).iter().map(f).collect()
        };
        let d = |a: BTreeSet<String>, b: BTreeSet<String>| a.symmetric_difference(&b).count();

        let calls = |x: &Value| cs(x, "calls", |c| {
            format!("{}|{}|{}|{}", c["line"], c["callee"], c["target"], c["confidence"])
        });
        let unres = |x: &Value| cs(x, "unresolved", |c| format!("{}|{}", c["line"], c["callee"]));
        let ext = |x: &Value| cs(x, "external", |c| format!("{}|{}|{}", c["line"], c["callee"], c["lib"]));
        let attrs = |x: &Value| cs(x, "attrs", |c| format!("{}|{}|{}", c["name"], norm(c["type"].as_str().unwrap_or("")), c["line"]));
        let asserts = |x: &Value| cs(x, "asserts", |c| format!("{}|{}", c["line"], norm(c["text"].as_str().unwrap_or(""))));

        if d(calls(r), calls(g)) > 0 {
            call_diffs.push(id.clone());
        }
        if d(unres(r), unres(g)) > 0 {
            unresolved_diffs.push(id.clone());
        }
        if d(ext(r), ext(g)) > 0 {
            external_diffs.push(id.clone());
        }
        if d(attrs(r), attrs(g)) > 0 {
            attr_diffs.push(id.clone());
        }
        if d(asserts(r), asserts(g)) > 0 {
            assert_diffs.push(id.clone());
        }
    }

    // 3. 调用边：golden 的边不能丢；Rust 允许多出已记录的两条
    let key = |e: &Value| format!("{}|{}|{}", e["from"], e["to"], e["confidence"]);
    let re_set: BTreeSet<String> = re.as_array().unwrap().iter().map(key).collect();
    let ge_set: BTreeSet<String> = ge.as_array().unwrap().iter().map(key).collect();
    let lost: Vec<&String> = ge_set.difference(&re_set).collect();
    let gained: Vec<&String> = re_set.difference(&ge_set).collect();

    // 4. 数据结构与统计
    let rd = load(&out.join("datastructs.json"));
    let gd = load(&golden.join("datastructs.json"));
    let r_ids: BTreeSet<String> = rd.as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap_or("").to_string()).collect();
    let g_ids: BTreeSet<String> = gd.as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap_or("").to_string()).collect();
    assert_eq!(r_ids, g_ids, "数据结构清单不一致");

    let rst = load(&out.join("stats.json"));
    let gst = load(&golden.join("stats.json"));
    for k in ["py_files", "py_loc", "symbols", "classes", "functions", "methods",
              "datastructs", "modules", "triton_symbols"] {
        assert_eq!(rst[k], gst[k], "统计项 {k} 不一致");
    }

    // 5. 已记录的差异上限
    let report = |name: &str, v: &Vec<String>, cap: usize| -> usize {
        if !v.is_empty() {
            eprintln!("{name}: {} 个符号有差异（上限 {cap}）{:?}", v.len(), &v[..v.len().min(4)]);
        }
        v.len()
    };
    let text_bad = text_diffs.len();
    if text_bad > 0 {
        eprintln!("签名/返回文本差异 {} 条，前几条：{:?}", text_bad, &text_diffs[..text_bad.min(4)]);
    }
    eprintln!(
        "结构性字段差异 {}，签名文本差异 {}，边：丢失 {} 多出 {}",
        field_diffs.len(), text_bad, lost.len(), gained.len()
    );
    for m in field_diffs.iter().take(6) {
        eprintln!("  字段 {m}");
    }
    for m in lost.iter().take(6) {
        eprintln!("  丢边 {m}");
    }
    for m in gained.iter().take(6) {
        eprintln!("  多边 {m}");
    }

    assert!(field_diffs.is_empty(), "结构性字段必须完全一致，实际 {} 处", field_diffs.len());
    assert!(lost.is_empty(), "golden 的调用边不能丢失，丢了 {} 条", lost.len());
    assert!(gained.len() <= 2, "多出的边应不超过 2 条（已知改进），实际 {}", gained.len());
    // 上限取当前已核对的实际值：这些是两边启发式的取舍差异，不是回归。
    // 任何一项超过上限都说明移植引入了新问题。
    let caps = [
        ("calls", &call_diffs, 2usize),
        ("unresolved", &unresolved_diffs, 4),
        ("external", &external_diffs, 2),
        ("attrs", &attr_diffs, 2),
        ("asserts", &assert_diffs, 3),
    ];
    let mut over: Vec<String> = Vec::new();
    for (name, v, cap) in &caps {
        let n = report(name, v, *cap);
        if n > *cap {
            over.push(format!("{name}: {n} > {cap}"));
        }
    }
    assert!(over.is_empty(), "差异超出已记录的上限：{over:?}");
}
