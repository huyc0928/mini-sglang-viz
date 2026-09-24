//! 手工内容（content/flows.json）的一致性检查。
//!
//! 内容是手写的，最容易出的错是引用了不存在的符号 id。这里把每个引用
//! 都对一遍抽取产物，顺便检查时序步骤的必填字段。

use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;

fn manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn load(p: &std::path::Path) -> Value {
    let t = std::fs::read_to_string(p).unwrap_or_else(|e| panic!("读取 {} 失败: {e}", p.display()));
    serde_json::from_str(&t).unwrap_or_else(|e| panic!("解析 {} 失败: {e}", p.display()))
}

/// 只收集真正表示符号引用的两种位置：`"symbol": "..."` 与 `"key_symbols": [...]`
fn refs(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(m) => {
            for (k, val) in m {
                if k == "symbol" {
                    if let Some(s) = val.as_str() {
                        out.push(s.to_string());
                    }
                } else if k == "key_symbols" {
                    for x in val.as_array().cloned().unwrap_or_default() {
                        if let Some(s) = x.as_str() {
                            out.push(s.to_string());
                        }
                    }
                } else {
                    refs(val, out);
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| refs(x, out)),
        _ => {}
    }
}

#[test]
fn content_references_exist() {
    let content_path = manifest().join("../content/flows.json");
    let golden = manifest().join("tests/golden/symbols.json");
    if !content_path.exists() || !golden.exists() {
        eprintln!("跳过：缺少 content/flows.json 或 golden 快照");
        return;
    }
    let content = load(&content_path);
    let symbols: BTreeSet<String> = load(&golden)
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();

    let mut all: Vec<String> = Vec::new();
    refs(&content, &mut all);
    let dangling: Vec<&String> = all.iter().filter(|id| !symbols.contains(*id)).collect();
    assert!(
        dangling.is_empty(),
        "内容里引用了 {} 个不存在的符号：{:?}",
        dangling.len(),
        &dangling[..dangling.len().min(8)]
    );

    // 结构完整性
    let modules = content["module_notes"].as_object().expect("module_notes").len();
    assert!(modules >= 18, "模块说明应覆盖全部模块，实际 {modules}");

    let flows = content["flows"].as_array().expect("flows");
    assert_eq!(flows.len(), 8, "时序流程数应为 8");
    for f in flows {
        let steps = f["steps"].as_array().unwrap_or_else(|| panic!("{} 缺少 steps", f["id"]));
        assert!(!steps.is_empty(), "{} 没有步骤", f["id"]);
        for s in steps {
            for k in ["from", "to", "label"] {
                assert!(
                    s[k].as_str().map(|x| !x.is_empty()).unwrap_or(false),
                    "{} 的某一步缺少 {k}",
                    f["id"]
                );
            }
        }
        // 参与者必须被声明过
        let actors: BTreeSet<&str> = f["actors"]
            .as_array()
            .expect("actors")
            .iter()
            .map(|a| a.as_str().unwrap_or(""))
            .collect();
        for s in steps {
            for k in ["from", "to"] {
                let a = s[k].as_str().unwrap_or("");
                assert!(actors.contains(a), "{} 的步骤用了未声明的参与者 {a}", f["id"]);
            }
        }
    }

    // ---- 功能描述：每条都要对得上符号、长度合适 ----
    let desc_path = manifest().join("../content/descriptions.json");
    let desc = load(&desc_path);
    let desc_map = desc.as_object().expect("descriptions.json 应是对象");
    assert!(desc_map.len() > 400, "描述条目偏少：{}", desc_map.len());
    let mut bad_id: Vec<&String> = Vec::new();
    let mut bad_len: Vec<(&String, usize)> = Vec::new();
    let mut empty: Vec<&String> = Vec::new();
    for (id, v) in desc_map {
        if !symbols.contains(id) {
            bad_id.push(id);
        }
        let text = v.as_str().unwrap_or("");
        // 图上的第二行要放得下，所以只数汉字
        let n = text.chars().filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c)).count();
        if text.is_empty() {
            empty.push(id);
        } else if !(4..=15).contains(&n) {
            bad_len.push((id, n));
        }
    }
    assert!(bad_id.is_empty(), "描述里有不存在的符号 id：{:?}", &bad_id[..bad_id.len().min(5)]);
    assert!(empty.is_empty(), "有描述是空的：{:?}", &empty[..empty.len().min(5)]);
    assert!(bad_len.is_empty(), "描述汉字数超出 4–15：{:?}", &bad_len[..bad_len.len().min(5)]);

    // 非魔术方法必须都有描述，否则图上会退回到显示类型与模块
    let uncovered: Vec<&String> = symbols
        .iter()
        .filter(|id| {
            let name = id.rsplit('.').next().unwrap_or("");
            !(name.starts_with("__") && name.ends_with("__")) && !desc_map.contains_key(*id)
        })
        .collect();
    assert!(uncovered.is_empty(), "有 {} 个非魔术符号没有描述：{:?}", uncovered.len(), &uncovered[..uncovered.len().min(5)]);

    let ops = content["kv_scenario"]["ops"].as_array().expect("kv_scenario.ops");
    assert!(ops.len() >= 15, "模拟器脚本步骤偏少：{}", ops.len());
    let topo = content["process_topology"]["nodes"].as_array().expect("topology");
    assert!(topo.len() >= 8, "进程拓扑节点偏少：{}", topo.len());
    let order = content["reading_order"].as_array().expect("reading_order");
    assert!(order.len() >= 5, "建议阅读顺序条目偏少：{}", order.len());

    eprintln!(
        "内容检查通过：{} 模块说明，{} 条时序 / {} 步，{} 个模拟器步骤，{} 条功能描述",
        modules,
        flows.len(),
        flows.iter().map(|f| f["steps"].as_array().unwrap().len()).sum::<usize>(),
        ops.len(),
        desc_map.len()
    );
}
