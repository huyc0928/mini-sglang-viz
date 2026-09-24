# Python 参考实现（移植对照，可删）

这里是从 Rust 版抽取器移植前写的一版实现，用的是 CPython 的 `ast` 模块。

保留它的唯一用途是当**对照物**：

- 冻结快照在 `backend/tests/golden/`，由 `cargo test --test golden` 拿 Rust 版的结果逐字段比对。
  结构性字段要求完全一致，允许的少量差异与原因写在测试里的注释里。
- `verify.py` 里是几条对源码事实的断言（符号存在性、关键调用边、行号区间、字段清单），
  当年用它验证 Python 版没写错，现在读起来仍是一份「我认为事实应该是什么」的清单。
- `golden_diff.py` 是更细的差异报告器，`cargo test` 报出差异时可以用它定位到具体符号。

运行环境用不到它：后端是纯 Rust，前端是 TypeScript。`cargo test --test golden`
依赖的是 `backend/tests/golden/` 里的 JSON 快照，删掉这个目录不影响任何检查。
