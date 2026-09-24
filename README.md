# mini-sglang 源码可视化

一个用来读 [mini-sglang](https://github.com/sgl-project/mini-sglang) 源码的交互式工具。后端用 Rust 静态解析 8095 行 Python，前端用 TypeScript 把结果画成可操作的图。

六个视图分别回答：一次请求经过哪些进程、某个函数调用了谁、一个结构体有哪些字段和不变量、一遍请求生命周期里每一步对应哪几行代码、显存页怎么分配和淘汰、某一行源码在哪个文件里。

被分析的仓库只读，工具不改它一个字节。

## 快速开始

需要 Rust 与 Node。本机用 Rust 1.98、Node 22.19 验证通过。

```bash
# 1. 抽取：解析源码，写出 data/*.json
cd backend
cargo run --release -- extract --src ../mini-sglang --out ../data

# 2. 构建前端
cd ../frontend
npm install
npm run build

# 3. 起服务（同时提供 API 与前端静态文件）
cd ../backend
cargo run --release -- serve --data ../data --dist ../frontend/dist --port 8787
```

打开 <http://127.0.0.1:8787>。左上角的按钮可以把左侧导航收起（状态会记住），这样画面能更宽。

改前端时不必每次构建，用 Vite 的开发服务器（它会把 `/api` 代理到 8787）：

```bash
cd frontend && npm run dev     # 打开 http://127.0.0.1:5173
```

源码根目录默认按 `../mini-sglang` 猜，也可以用环境变量指定：`MINISGL_SRC=/path/to/mini-sglang`。

## 六个视图

每个符号都配了一句 5–15 字的功能描述（`content/descriptions.json`，550 条）。它显示在图节点的第二行、调用与被调用列表、符号详情、时序回放的步骤面板和数据结构页上，鼠标悬停可以看到完整文字。

**总览**：进程拓扑（API Server、tokenize worker、detokenizer、每个 TP rank 一个 Scheduler 进程，以及它们之间的 ZMQ 通道与 NCCL 链路）、按行数排的模块地图、六条建议阅读路径、每个模块的职责说明。拓扑图上的长文字都收进了图下方的编号列表：边上只留一个序号徽标，鼠标移到徽标或列表行上两边一起高亮，这样无论窗口多窄文字都不会叠在一起。

**调用链追踪器**：主力视图，三栏布局，左栏选文件，右栏是符号详情，中间是按调用深度分层的图。左右两栏都可以收起，收起后只留一条竖排标签的窄条，按钮留在原处；收起状态记在浏览器里，两栏都收起时中间的图占满整屏。

图会铺满面板。层的深度超过两三档时整张图放不下，这时缩放停在 0.85 倍以保证文字可读，画面以当前根节点为中心，其余部分拖动着看。

点任意节点就把它设为新的根。三种边分开画，方便区分信息的可靠程度：实线是静态解析到的调用，虚线是经字段类型推断出的调用，紫色虚线是抽象基类方法与实现类方法的对应关系。最后这种是接口实现，能把 `BasePrefixCache.evict` 追到 `RadixPrefixCache.evict` 的只有它。

还能选起点和终点找最短调用路径；找不到时会说明没有静态调用路径，并指出常见原因是链路跨了进程边界。

**数据结构检查器**：字段表、实例属性表、构造函数里的不变式、类型归属图。选中 `Req` 时会多一个生命周期滑块，拖动就能看到 `cached_len`、`device_len`、`max_device_len` 三个长度怎么决定请求处于 prefill、chunked、decode 还是结束状态。

**时序回放**：八条流程逐步走，每一步都定位到真实的行号并显示那段源码。整张时序图画在固定尺寸的图框里、尺寸只由流程决定，所以播放时画面不会移动——定位源码那一行也只滚动代码块内部，不动整个页面。流程包括在线请求从 HTTP 到 SSE、离线单进程路径、一个 prefill 步、一个 decode 步（含 overlap 调度的双流与事件同步）、CUDA Graph 的捕获与回放、chunked prefill 跨轮推进、Radix 缓存的匹配与淘汰、张量并行里一次 all_reduce 的两个 rank 时序。

**KV / Radix 模拟器**：把 `CacheManager` 与 `RadixPrefixCache` 的算法重新实现成一个小模型，逐步执行一段预设脚本，同时显示页表网格、物理页池、Radix 树和每一步对应的源码。默认脚本是两个请求共享前缀、第三个请求被空间卡住的过程，`page_size` 与 `num_pages` 可以改。

图的尺寸做得稳定：树的画布在参数变化时按整段脚本预演一遍量出上限，播放每一步都不改变缩放比例；层的间距是固定值，图框的高度由画布长宽比推出，所以图上没有多余的空白。页表与物理页池共用同一个格子尺寸。

**源码浏览器**：按文件浏览带高亮的源码，行号可点，支持 `#/source?file=...&line=N` 深链接。其他视图里的每个 `file:line` 都跳到这里。

## 数据从哪来

分成两层。

**静态抽取**（`backend/src/`）用 `rustpython-parser` 解析全部 Python 文件，抽出每个类与函数的签名、字段、实例属性、不变式和调用边。调用边的解析是这套工具的核心：它按导入关系、参数注解、`self.x = SomeClass(...)` 推断出的字段类型，以及工厂函数的返回注解来解析被调用者；解析不掉的如实标成未解析，不猜。当前结果是 624 个符号、523 条调用边（其中 99 条是推断出来的）、111 条接口实现边。

**手工内容**是抽取器拿不到的东西，分两份：

- `content/flows.json`：模块职责、建议阅读顺序、八条时序流程、模拟器的预设脚本。每个引用都用符号 id。
- `content/descriptions.json`：550 条符号功能描述，覆盖全部非魔术方法。

`cargo test --test content` 会核对两份内容的每个符号引用都真实存在、描述长度落在 4–15 个汉字、非魔术符号没有遗漏。

数据流向：

```
mini-sglang 源码
  └─ backend: extract ──> data/*.json ──> backend: serve ──> /api/* ──> frontend 六个视图
  content/flows.json ────────────────────────┘
```

`data/` 里的 JSON 已随目录保存，只想看结果的话可以跳过抽取直接起服务。

## 怎么验证

```bash
# 后端：抽取结果与冻结快照逐字段比对，以及内容引用检查
cd backend && cargo test

# 前端：类型检查与构建
cd frontend && npm run build

# 模拟器：把预设脚本跑一遍，检查每一步的实际结果与脚本说明是否一致
cd frontend && npm run check:scenario

# 配色：检查主题的对比度是否够读（亮色主题最容易把浅字留在浅底上）
cd frontend && npm run check:contrast

# 六个视图：在 jsdom 里真实渲染并对主要交互做点击验证（需要后端在 8787 运行）
cd frontend && npm run check:views
```

`npm run check:views` 除了渲染六个视图，还会做四组检查，结果逐条打印：

- 进程拓扑的坐标：节点框与边徽标之间不得相交，节点文字不得超出框宽；
- 播放时画面会不会跳：把时序回放推进 6 步、把模拟器走完 24 步，图内 SVG 的 `viewBox` 必须不变，全程不得调用 `scrollIntoView`；
- 图在面板里占多大：把面板尺寸喂给视图（jsdom 没有排版），算出实际缩放倍数并设下限。当前的下限是调用链默认入口 ≥ 0.95、层数多的图 ≥ 0.85、时序图 ≥ 0.95、模拟器树 ≥ 1.4；
- 折叠能不能用：侧栏收起与展开、状态写入 `localStorage`、两栏收起后窄条按钮仍可点回来、收起不会丢掉已加载的内容。

模拟器另有一条检查，确认内容没有被裁掉：画布按实测上限定尺寸，所以逐步走完 24 步、并换到 `page_size=8`，确认每个节点都落在画布内。

`cargo test --test golden` 是移植正确性的主要保障：它要求 624 个符号的 kind、name、qualname、module、group、file、lineno、end_lineno、loc、is_dataclass、is_property 全部一致，签名与返回类型文本一致，golden 里的调用边一条都不能丢。允许的差异是 2 条多出的调用边，另外五类（推断出的调用、未解析调用、外部库归类、实例属性类型、断言文本）各有少量差异，每类的上限与原因都写在测试代码里。

## 已知限制

**有些调用解析不出来。** 通过抽象基类的调用只会落到接口方法上，需要靠接口实现边再往下走一层。`getattr`、把方法存进字段再调用、字典分派这类动态写法解析不出来，会出现在「未解析」列表里，界面不会把它们当成调用显示。属性类型的推断基于 `self.x = Foo(...)` 与参数注解，推断不出的留空。

**有一处类型会被标错。** `Scheduler.eos_token_id = self.tokenizer.eos_token_id` 会让 `eos_token_id` 的类型标成 `PreTrainedTokenizerBase`，实际它是整数。从属性链上取字段时容易这样，Python 参考实现在这里也留空。界面上实例属性的类型列已标注为推断值。

**模拟器按源码重写了算法。** 它照 `scheduler/cache.py` 与 `kvcache/radix_cache.py` 的逻辑实现，用来对照着读代码；步数与页数按参数算出，不代表任何一次真实运行。

**没有跑过浏览器交互测试。** 本机环境没有可用的浏览器后端（`agent.browsers.list()` 返回空），所以交互是用 jsdom 无头渲染加点击验证的，覆盖渲染是否报错、数据是否绑上、点击后状态是否变化；文字叠加这类问题改成量坐标来判断，配色改成算对比度。**间距、对齐、动画这些只能靠眼睛看的部分没有经过确认。** 首次打开时请留意布局。

**主题是亮色。** 页面配色集中在 `styles.css` 的 `:root` 变量里，图元颜色（调用边、接口实现边、进程拓扑的四种通道、节点填充）也从同一批变量取，所以改主题只改这一处。`npm run check:contrast` 会按 WCAG 公式核对 34 组前景/背景的对比度。

**`kernel/csrc/` 的 C/CUDA 清单用启发式扫描**（只有 Python 走真正的 AST），函数名可能多认或漏认，当前是 103 条。

## 目录

```
mini-sglang-viz/
├── backend/                 Rust：抽取 + 查询服务
│   ├── src/
│   │   ├── main.rs          CLI（extract / serve）
│   │   ├── extract.rs       抽取流程与产物写出
│   │   ├── model.rs         输出的数据结构
│   │   ├── pyextract/       Python 解析：walk 遍历、index 建索引、scan 扫符号
│   │   ├── csrc.rs          C/CUDA 与 Triton 清单
│   │   ├── store.rs         查询层：图、路径、搜索、源码切片
│   │   └── api.rs           axum 路由，可选托管前端产物
│   └── tests/               与 golden 快照对等测试、内容引用检查
├── frontend/                Vite + TypeScript
│   ├── src/views/           六个视图
│   ├── src/lib/             DOM/SVG 工具、布局、高亮、模拟器
│   └── tools/               模拟器脚本检查、六视图无头渲染检查
├── content/flows.json       手工整理的教学内容
├── data/                    抽取产物
└── tools/reference-extractor/  移植期用的 Python 参考实现，运行不需要，可删
```

## 改了 mini-sglang 之后

重新跑一遍抽取即可，前端不用动：

```bash
cd backend && cargo run --release -- extract --src ../mini-sglang --out ../data
cargo test          # 如果上游改了代码，golden 对比会报出差异，据此判断是上游变化还是抽取器回归
```

如果上游确实改了结构，`cargo test --test golden` 会失败——这时要区分两种情况：上游的正常演进（更新 `backend/tests/golden/` 快照）还是抽取器的回归（修代码）。差异报告会指出具体是哪些符号、哪些字段，`tools/reference-extractor/golden_diff.py` 能给出更细的报告。
