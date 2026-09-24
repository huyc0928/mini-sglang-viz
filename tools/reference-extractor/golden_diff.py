#!/usr/bin/env python3
"""对比 Rust 抽取结果与 golden 快照，报告结构性差异。

golden 来自 tools/reference-extractor/extract.py（Python 版，已通过 verify.py 校验）。
对比规则：
- id、行号、边集合、confidence 要求完全一致
- signature / 注解 / 默认值 等文本按空白归一化后比较
- assignments / attrs / asserts / methods 按集合比较（顺序无关）

用法：python3 tools/golden_diff.py [rust 数据目录] [golden 目录]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUST = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/rust-data")
GOLD = Path(sys.argv[2] if len(sys.argv) > 2 else ROOT / "backend/tests/golden")

report: list[str] = []
counters: dict[str, int] = {}


def load(base: Path, name: str):
    return json.loads((base / name).read_text(encoding="utf-8"))


def norm(text: str) -> str:
    """文本归一化：抹平空白与引号风格差异（unparse 用单引号，源码切片用双引号）"""
    return re.sub(r"\s+", " ", (text or "").replace('"', "'").strip())


def note(cat: str, msg: str, limit: int = 6) -> None:
    counters[cat] = counters.get(cat, 0) + 1
    if counters[cat] <= limit:
        report.append(f"[{cat}] {msg}")
    elif counters[cat] == limit + 1:
        report.append(f"[{cat}] ... 其余同类差异省略")


def cmp_set(cat: str, label: str, a, b) -> None:
    sa, sb = set(a), set(b)
    for x in sorted(sa - sb):
        note(cat, f"{label} 仅存在于 Rust: {x}")
    for x in sorted(sb - sa):
        note(cat, f"{label} 仅存在于 golden: {x}")


def main() -> int:
    rsym = load(RUST, "symbols.json")
    gsym = load(GOLD, "symbols.json")
    redge = load(RUST, "edges.json")
    gedge = load(GOLD, "edges.json")
    rstat = load(RUST, "stats.json")
    gstat = load(GOLD, "stats.json")

    print("== 规模 ==")
    for k in ("symbols", "classes", "functions", "methods", "edges", "resolved_edges",
              "inferred_edges", "unresolved_calls", "external_calls", "datastructs",
              "py_files", "modules", "triton_symbols"):
        a, b = rstat.get(k), gstat.get(k)
        flag = "" if a == b else "   <-- 不一致"
        print(f"  {k:18} rust={a}  golden={b}{flag}")
    print(f"  {'csrc_symbols':18} rust={rstat.get('csrc_symbols')}  golden={gstat.get('csrc_symbols')}")

    print("\n== 符号集合 ==")
    cmp_set("符号", "符号", rsym.keys(), gsym.keys())

    print("\n== 逐符号结构 ==")
    exact_fields = ["kind", "name", "qualname", "module", "group", "file",
                    "lineno", "end_lineno", "loc", "is_dataclass", "is_property"]
    text_fields = ["signature", "returns"]
    for sid in sorted(set(rsym) & set(gsym)):
        r, g = rsym[sid], gsym[sid]
        for f in exact_fields:
            if r.get(f) != g.get(f):
                note("字段值", f"{sid}.{f}: rust={r.get(f)!r} golden={g.get(f)!r}")
        for f in text_fields:
            if norm(r.get(f, "")) != norm(g.get(f, "")):
                note("文本", f"{sid}.{f}:\n      rust  ={norm(r.get(f,''))[:110]}\n      golden={norm(g.get(f,''))[:110]}")
        cmp_set("bases", f"{sid}.bases", [norm(x) for x in r.get("bases", [])],
                [norm(x) for x in g.get("bases", [])])
        cmp_set("decorators", f"{sid}.decorators", [norm(x) for x in r.get("decorators", [])],
                [norm(x) for x in g.get("decorators", [])])
        cmp_set("methods", f"{sid}.methods", r.get("methods", []), g.get("methods", []))
        cmp_set(
            "fields",
            f"{sid}.fields",
            [(x["name"], norm(x["annotation"]), x["init"], x["origin"]) for x in r.get("fields", [])],
            [(x["name"], norm(x["annotation"]), x["init"], x["origin"]) for x in g.get("fields", [])],
        )
        cmp_set(
            "calls",
            f"{sid}.calls",
            [(x["line"], x["callee"], x["target"], x["confidence"]) for x in r.get("calls", [])],
            [(x["line"], x["callee"], x["target"], x["confidence"]) for x in g.get("calls", [])],
        )
        cmp_set(
            "unresolved",
            f"{sid}.unresolved",
            sorted({(x["line"], x["callee"]) for x in r.get("unresolved", [])}),
            sorted({(x["line"], x["callee"]) for x in g.get("unresolved", [])}),
        )
        cmp_set(
            "external",
            f"{sid}.external",
            sorted({(x["line"], x["callee"], x["lib"]) for x in r.get("external", [])}),
            sorted({(x["line"], x["callee"], x["lib"]) for x in g.get("external", [])}),
        )
        cmp_set(
            "module_refs",
            f"{sid}.module_refs",
            sorted({(x["line"], x["callee"]) for x in r.get("module_refs", [])}),
            sorted({(x["line"], x["callee"]) for x in g.get("module_refs", [])}),
        )
        cmp_set("attrs", f"{sid}.attrs",
                sorted({(a["name"], norm(a["type"]), a["line"]) for a in r.get("attrs", [])}),
                sorted({(a["name"], norm(a["type"]), a["line"]) for a in g.get("attrs", [])}))
        cmp_set("asserts", f"{sid}.asserts",
                sorted({(a["line"], norm(a["text"])) for a in r.get("asserts", [])}),
                sorted({(a["line"], norm(a["text"])) for a in g.get("asserts", [])}))
        cmp_set("assignments", f"{sid}.assignments",
                sorted({(a["method"], a["line"], a["target"]) for a in r.get("assignments", [])}),
                sorted({(a["method"], a["line"], a["target"]) for a in g.get("assignments", [])}))

    print("\n== 调用边集合 ==")
    re_set = {(e["from"], e["to"], e["confidence"]) for e in redge}
    ge_set = {(e["from"], e["to"], e["confidence"]) for e in gedge}
    for x in sorted(re_set - ge_set):
        note("边", f"仅存在于 Rust: {x[0]} -> {x[1]} ({x[2]})")
    for x in sorted(ge_set - re_set):
        note("边", f"仅存在于 golden: {x[0]} -> {x[1]} ({x[2]})")

    print("\n== 数据结构清单 ==")
    rd, gd = load(RUST, "datastructs.json"), load(GOLD, "datastructs.json")
    cmp_set("数据结构", "datastructs", [d["id"] for d in rd], [d["id"] for d in gd])

    print("\n== 模块清单 ==")
    rm, gm = load(RUST, "modules.json"), load(GOLD, "modules.json")
    cmp_set("模块", "modules", [(m["name"], m["loc"]) for m in rm], [(m["name"], m["loc"]) for m in gm])

    print("\n" + "=" * 64)
    if report:
        print(f"{len(report)} 条差异（同类最多显示 6 条）\n")
        for line in report:
            print("  " + line)
        print()
    total = sum(counters.values())
    print(f"差异总数 {total}")
    for k, v in sorted(counters.items(), key=lambda kv: -kv[1]):
        print(f"  {k:12} {v}")
    return 1 if total else 0


if __name__ == "__main__":
    raise SystemExit(main())
