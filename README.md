# mini-sglang 源码可视化

给 [mini-sglang](https://github.com/sgl-project/mini-sglang) 用的交互式源码阅读器。后端用 Rust 解析源码并建索引，前端用 TypeScript 把结果画成可操作的图，用来对照着读推理引擎的调度、显存管理与模型前向。

这是个个人学习项目。被分析的仓库只读，本工具不修改它。

## 功能

六个视图，都在同一个页面里：

| 视图 | 看什么 |
|---|---|
| 总览 | 进程拓扑、各模块代码量、六条建议阅读路径 |
| 调用链追踪器 | 点一个函数看它调用了谁、被谁调用，也可以追两个函数之间的最短调用路径 |
| 数据结构检查器 | 字段、实例属性、构造函数里的不变式，以及 `Req` 的生命周期 |
| 时序回放 | 八条流程逐步播放，每一步定位到真实源码行 |
| KV / Radix 模拟器 | 分页分配、淘汰与前缀缓存的逐步演示，`page_size` 与 `num_pages` 可调 |
| 源码浏览器 | 按文件读高亮源码，行号可点 |

调用图上的三种边分开画：实线是静态解析到的调用，虚线是经字段类型推断出的调用，紫色虚线是抽象基类方法与实现类方法的对应关系。每个符号另配一句 5–15 字的功能描述，显示在图的节点与调用列表里。

## 快速开始

需要 Rust 与 Node，本机用 Rust 1.98、Node 22.19 验证。

```bash
# 解析源码，写出 data/*.json
cd backend && cargo run --release -- extract --src ../mini-sglang --out ../data

# 构建前端
cd ../frontend && npm install && npm run build

# 起服务，同时提供 API 与前端文件
cd ../backend && cargo run --release -- serve --data ../data --dist ../frontend/dist --port 8787
```

打开 <http://127.0.0.1:8787>。

改前端时不必每次构建，Vite 开发服务器会把 `/api` 代理到 8787：

```bash
cd frontend && npm run dev
```

源码目录默认取 `../mini-sglang`，也可以用 `MINISGL_SRC` 指定。`data/` 里的抽取结果已随仓库保存，只想看界面可以跳过第一步。常用命令收在 `Makefile` 里，`make` 列出全部。

## 工作原理

数据来自两层。

**静态抽取**（`backend/`）用 `rustpython-parser` 解析全部 Python 文件，抽出类与函数的签名、字段、实例属性、不变式和调用边。调用边按导入关系、参数注解、`self.x = SomeClass(...)` 推断出的字段类型以及工厂函数的返回注解来解析；解析不掉的标成未解析，不猜。当前覆盖 8095 行 Python，得到 624 个符号、523 条调用边、111 条接口实现边。

**手工内容**（`content/`）是抽取器拿不到的部分：模块职责、建议阅读顺序、八条时序流程、模拟器的预设脚本，以及 550 条符号功能描述。

```
mini-sglang 源码
  └─ backend: extract ──> data/*.json ──> backend: serve ──> /api/* ──> 前端六个视图
  content/*.json ───────────────────────────┘
```

## 项目结构

```
backend/          Rust：抽取与查询服务
  src/pyextract/    Python 解析：遍历、建索引、扫符号
  src/store.rs      查询层：图、路径、搜索、源码切片
  src/api.rs        axum 路由
  tests/            与冻结快照的对等测试、内容校验
frontend/         Vite + TypeScript
  src/views/        六个视图
  src/lib/          DOM 与 SVG 工具、布局、代码高亮、模拟器
  tools/            无头渲染检查、配色检查、模拟器脚本检查
content/          手工整理的教学内容与功能描述
data/             抽取产物
tools/reference-extractor/   移植期用的 Python 参考实现，运行不需要
```

## 开发与验证

| 命令 | 检查什么 |
|---|---|
| `cd backend && cargo test` | 抽取结果与冻结快照逐字段比对；手工内容的符号引用与描述长度 |
| `cd frontend && npm run build` | 类型检查与构建 |
| `cd frontend && npm run check:views` | 在 jsdom 里渲染六个视图并驱动交互，断言拓扑不重叠、播放时画面不跳、图占面板的比例、折叠可用、内容未被裁掉 |
| `cd frontend && npm run check:contrast` | 页面配色按 WCAG 公式核对 34 组前景与背景的对比度 |
| `cd frontend && npm run check:scenario` | 模拟器脚本逐步对照算法，确认每一步的实际结果与说明一致 |

`check:views` 需要后端在 8787 运行。`make check` 跑其中不依赖服务的几项，`make check-all` 自己起停服务跑完全部。

移植正确性由 `backend/tests/golden.rs` 守：它要求 624 个符号的结构性字段与签名文本一致、调用边一条不丢。上游改了代码导致比对失败时，先判断是上游演进还是抽取器回归，差异报告会指出具体是哪些符号与字段；`tools/reference-extractor/golden_diff.py` 能给出更细的报告。

## 已知限制

- **动态写法解析不出来**。`getattr`、把方法存进字段再调用、字典分派这类都落在「未解析」列表里，界面不会把它们当成调用显示。`kernel/csrc/` 下的 C/CUDA 清单用启发式扫描，函数名可能多认或漏认。
- **有一处类型会被标错**。`Scheduler.eos_token_id` 的类型标成了 `PreTrainedTokenizerBase`，实际是整数。从属性链上取字段时容易这样，界面上实例属性的类型列已标注为推断值。
- **模拟器按源码重写了算法**，用来对照着读代码；步数与页数按参数算出，不代表任何一次真实运行。
- **排版与配色没有经过人眼确认**。本机没有可用的浏览器后端，交互验证是在 jsdom 里做的，覆盖渲染报错、数据绑定与点击后的状态变化。

## 致谢

被分析的项目是 [sgl-project/mini-sglang](https://github.com/sgl-project/mini-sglang)（MIT 许可）。本仓库只把它作为分析对象引用。

## 许可证

尚未选择许可证。
