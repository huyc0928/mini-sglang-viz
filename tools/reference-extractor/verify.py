#!/usr/bin/env python3
"""校验抽取结果与源码事实一致，并对关键调用边做人工可复核的抽查。

用法：python3 tools/verify.py
退出码非 0 表示有断言失败。
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SRC = ROOT.parent / "mini-sglang"

failures: list[str] = []


def load(name: str):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def check(cond: bool, msg: str) -> None:
    if cond:
        print(f"  通过  {msg}")
    else:
        print(f"  失败  {msg}")
        failures.append(msg)


def main() -> int:
    symbols = load("symbols.json")
    edges = load("edges.json")
    stats = load("stats.json")
    dstructs = load("datastructs.json")
    sources = load("sources.json")

    print("== 规模断言 ==")
    check(stats["py_loc"] > 7000, f"Python 行数 {stats['py_loc']} > 7000")
    check(stats["symbols"] > 400, f"符号数 {stats['symbols']} > 400")
    check(stats["edges"] > 450, f"调用边数 {stats['edges']} > 450")
    check(stats["modules"] >= 17, f"模块数 {stats['modules']} >= 17")
    resolved_ratio = (stats["resolved_edges"] + stats["inferred_edges"]) / max(stats["edges"], 1)
    check(resolved_ratio > 0.9, f"已解析边占比 {resolved_ratio:.1%} > 90%")

    print("\n== 关键符号存在性 ==")
    required = [
        "minisgl.scheduler.scheduler.Scheduler.run_forever",
        "minisgl.scheduler.scheduler.Scheduler.overlap_loop",
        "minisgl.scheduler.scheduler.Scheduler._prepare_batch",
        "minisgl.scheduler.prefill.PrefillAdder.try_add_one",
        "minisgl.scheduler.prefill.PrefillManager.schedule_next_batch",
        "minisgl.scheduler.cache.CacheManager._allocate",
        "minisgl.scheduler.cache.CacheManager._page_to_token",
        "minisgl.scheduler.table.TableManager.allocate",
        "minisgl.engine.engine.Engine.forward_batch",
        "minisgl.engine.engine.Engine.__init__",
        "minisgl.engine.graph.GraphRunner.replay",
        "minisgl.engine.sample.Sampler.sample",
        "minisgl.kvcache.radix_cache.RadixPrefixCache.evict",
        "minisgl.kvcache.radix_cache.RadixPrefixCache.match_prefix",
        "minisgl.kvcache.radix_cache.RadixTreeNode.split_at",
        "minisgl.kvcache.mha_pool.MHAKVCache.store_kv",
        "minisgl.models.qwen3.Qwen3ForCausalLM.forward",
        "minisgl.models.utils.RopeAttn.forward",
        "minisgl.layers.attention.AttentionLayer.forward",
        "minisgl.attention.base.HybridBackend.forward",
        "minisgl.layer0.this.is.a.bogus.symbol",
    ]
    for rid in required[:-1]:
        check(rid in symbols, f"存在 {rid}")

    print("\n== 调用边数（对照源码人工核对）==")
    # 每条断言写成 (调用者, 被调用者)；被调用者为 None 时只检查该符号有调用边
    expected_edges = [
        ("minisgl.engine.engine.Engine.forward_batch", "minisgl.engine.graph.GraphRunner.replay"),
        ("minisgl.engine.engine.Engine.forward_batch", "minisgl.engine.sample.Sampler.sample"),
        ("minisgl.scheduler.scheduler.Scheduler._prepare_batch",
         "minisgl.scheduler.cache.CacheManager.allocate_paged"),
        ("minisgl.scheduler.scheduler.Scheduler._forward", "minisgl.engine.engine.Engine.forward_batch"),
        # prefix_cache 的静态类型是抽象基类 BasePrefixCache，所以落到 ABC 的方法上
        ("minisgl.scheduler.cache.CacheManager._allocate",
         "minisgl.kvcache.base.BasePrefixCache.evict"),
        ("minisgl.scheduler.prefill.PrefillManager.schedule_next_batch",
         "minisgl.scheduler.prefill.PrefillAdder.try_add_one"),
        ("minisgl.scheduler.decode.DecodeManager.schedule_next_batch", "minisgl.core.Batch"),
        ("minisgl.kvcache.radix_cache.RadixPrefixCache.evict",
         "minisgl.kvcache.radix_cache.RadixPrefixCache._collect_leave_nodes_for_evict"),
        ("minisgl.kvcache.radix_cache.RadixPrefixCache.insert_prefix",
         "minisgl.kvcache.radix_cache.RadixPrefixCache._tree_walk"),
        ("minisgl.kvcache.radix_cache.RadixPrefixCache.match_prefix",
         "minisgl.kvcache.radix_cache.RadixPrefixCache._tree_walk"),
        ("minisgl.kvcache.radix_cache.RadixTreeNode.get_match_len",
         "minisgl.kernel.radix.fast_compare_key"),
        ("minisgl.kvcache.mha_pool.MHAKVCache.store_kv", "minisgl.kernel.store.store_cache"),
        # attn_backend 的静态类型是抽象基类 BaseAttnBackend
        ("minisgl.layers.attention.AttentionLayer.forward",
         "minisgl.attention.base.BaseAttnBackend.forward"),
        ("minisgl.models.utils.RopeAttn.forward", "minisgl.layers.attention.AttentionLayer.forward"),
        ("minisgl.models.qwen3.Qwen3DecoderLayer.forward",
         "minisgl.models.utils.RopeAttn.forward"),
        ("minisgl.models.qwen3.Qwen3DecoderLayer.forward", "minisgl.models.utils.GatedMLP.forward"),
        ("minisgl.models.utils.GatedMLP.forward",
         "minisgl.layers.linear.LinearRowParallel.forward"),
        ("minisgl.layers.linear.LinearRowParallel.forward",
         "minisgl.distributed.impl.DistributedCommunicator.all_reduce"),
        ("minisgl.engine.graph.GraphRunner.replay", None),
        ("minisgl.scheduler.scheduler.Scheduler._process_last_data", None),
        ("minisgl.kvcache.radix_cache.RadixTreeNode.split_at", None),
    ]
    edge_keys = {(e["from"], e["to"]) for e in edges}
    for a, b in expected_edges:
        if b is None:
            check(bool(symbols[a]["calls"]), f"{a} 解析出调用边（{len(symbols[a]['calls'])} 条）")
        else:
            check((a, b) in edge_keys, f"{a} -> {b}")

    print("\n== 按字段类型推断出的调用（标注为 inferred）==")
    inferred = {(e["from"], e["to"]) for e in edges if e["confidence"] == "inferred"}
    for a, b in [
        ("minisgl.models.qwen3.Qwen3DecoderLayer.forward", "minisgl.models.utils.RopeAttn.forward"),
        ("minisgl.scheduler.scheduler.Scheduler._forward", "minisgl.engine.engine.Engine.forward_batch"),
    ]:
        check((a, b) in inferred, f"{a} -> {b} 标为 inferred")

    print("\n== 动态分发（推断极限，如实记录）==")
    hb = symbols["minisgl.attention.base.HybridBackend.forward"]
    callees = {c["callee"] for c in hb["calls"]}
    check("backend.forward" in callees, f"记录了三元表达式后的调用 backend.forward：{sorted(callees)}")
    ab = symbols["minisgl.attention.base.HybridBackend"]
    check(len(ab["attrs"]) >= 2, f"HybridBackend 的两个后端字段被记录：{[a['name'] for a in ab['attrs']]}")

    print("\n== file:line 抽查（随机 10 个符号）==")
    rng = random.Random(20260924)
    sample = rng.sample(sorted(symbols), 10)
    for sid in sample:
        s = symbols[sid]
        lines = sources.get(s["file"])
        if lines is None:
            check(False, f"{sid} 的源文件 {s['file']} 未收录")
            continue
        # 起始行应包含符号名
        head = lines[s["lineno"] - 1]
        ok = s["name"].rstrip("_") in head or s["name"] in head
        check(ok, f"{sid} 起始行 {s['lineno']} 含符号名：{head.strip()[:70]}")

    print("\n== 行号范围抽查 ==")
    for sid in sample:
        s = symbols[sid]
        lines = sources[s["file"]]
        seg = lines[s["lineno"] - 1: s["end_lineno"]]
        check(len(seg) == s["loc"] and len(seg) > 0,
              f"{sid} 行区间 {s['lineno']}-{s['end_lineno']} 长度 {len(seg)} 与 loc {s['loc']} 一致")

    print("\n== 数据结构字段抽查 ==")
    by_name = {d["name"]: d for d in dstructs}
    for nm in ("Req", "Batch", "Context", "SamplingParams", "EngineConfig", "SchedulerConfig",
               "RadixTreeNode", "ForwardInput", "PendingReq"):
        check(nm in by_name, f"收录了 {nm}")
    if "Batch" in by_name:
        fields = {f["name"] for f in by_name["Batch"]["fields"]}
        check(fields == {"reqs", "phase", "input_ids", "positions", "out_loc",
                         "padded_reqs", "attn_metadata"},
              f"Batch 字段与源码一致：{sorted(fields)}")
    if "Req" in by_name:
        fields = {f["name"] for f in by_name["Req"]["fields"]}
        check({"input_ids", "table_idx", "cached_len", "output_len", "uid",
               "sampling_params", "cache_handle"} <= fields,
              f"Req 必备字段齐全：{sorted(fields)}")
    if "RadixTreeNode" in by_name:
        node = by_name["RadixTreeNode"]
        names = {f["name"] for f in node["fields"]} | {a["name"] for a in node["attrs"]}
        check({"ref_count", "children", "timestamp", "_key", "_value"} <= names,
              f"RadixTreeNode 的实例属性齐全：{sorted(names)}")

    print("\n== Req 的不变式 ==")
    if "Req" in by_name:
        texts = " ".join(a["text"] for a in by_name["Req"]["asserts"])
        check("cached_len" in texts and "device_len" in texts,
              f"抓到 Req 的断言：{texts[:120]}")

    print("\n== 非 Python 产物 ==")
    kernels = load("kernels.json")
    check(len(kernels["triton"]) >= 2, f"Triton 符号 {len(kernels['triton'])} >= 2")
    check(len(kernels["csrc"]) >= 8, f"C/CUDA 符号 {len(kernels['csrc'])} >= 8")

    print("\n" + "=" * 60)
    if failures:
        print(f"{len(failures)} 项失败")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
