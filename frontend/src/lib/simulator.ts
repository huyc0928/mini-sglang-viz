// 教学用的 KV 池与 Radix 前缀缓存模拟器。
// 逐条对应真实实现：scheduler/cache.py 的 CacheManager、table.py 的 TableManager、
// kvcache/radix_cache.py 的 RadixPrefixCache。这是重写，不是真实运行的抓取。

import type { SimOp } from "../types";

export interface SimParams {
  page_size: number;
  num_pages: number;
  max_running_req: number;
}

export function alignDown(a: number, b: number): number {
  return Math.floor(a / b) * b;
}
export function divCeil(a: number, b: number): number {
  return Math.ceil(a / b);
}
export function commonPrefix(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

let nodeCounter = 0;

export class RadixNode {
  readonly id: number;
  key: number[];
  value: number[];
  ref = 0;
  ts: number;
  parent: RadixNode | null = null;
  children = new Map<string, RadixNode>();

  constructor(key: number[], value: number[], ts: number) {
    this.id = nodeCounter++;
    this.key = key;
    this.value = value;
    this.ts = ts;
  }

  get length(): number {
    return this.key.length;
  }
  isLeaf(): boolean {
    return this.children.size === 0;
  }
}

class MinHeap {
  private a: RadixNode[] = [];
  push(n: RadixNode): void {
    this.a.push(n);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p].ts <= this.a[i].ts) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  pop(): RadixNode | undefined {
    if (this.a.length === 0) return undefined;
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length > 0) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let s = i;
        if (l < this.a.length && this.a[l].ts < this.a[s].ts) s = l;
        if (r < this.a.length && this.a[r].ts < this.a[s].ts) s = r;
        if (s === i) break;
        [this.a[s], this.a[i]] = [this.a[i], this.a[s]];
        i = s;
      }
    }
    return top;
  }
  get size(): number {
    return this.a.length;
  }
}

export class RadixTree {
  readonly root: RadixNode;
  evictableSize = 0;
  protectedSize = 0;
  private tic = 0;
  private readonly pageSize: number;

  constructor(pageSize: number) {
    this.pageSize = pageSize;
    this.root = new RadixNode([], [], 0);
    this.root.ref = 1; // 根节点永远受保护
  }

  private nextTic(): number {
    return ++this.tic;
  }

  /** page_size=1 时键是单个 token，否则是一页 token，与 _get_key_fn 一致 */
  keyFn(tokens: number[]): string {
    return this.pageSize === 1 ? String(tokens[0]) : tokens.slice(0, this.pageSize).join(",");
  }

  private splitAt(node: RadixNode, pos: number): RadixNode {
    if (!(pos > 0 && pos < node.length)) throw new Error(`split_at 位置非法：${pos}`);
    const parent = node.parent!;
    const nn = new RadixNode(node.key.slice(0, pos), node.value.slice(0, pos), node.ts);
    nn.parent = parent;
    parent.children.set(this.keyFn(nn.key), nn);
    nn.ref = node.ref;
    node.key = node.key.slice(pos);
    node.value = node.value.slice(pos);
    node.parent = nn;
    return nn;
  }

  private walk(tokens: number[]): { node: RadixNode; len: number } {
    let prefix = 0;
    let node = this.root;
    const tic = this.nextTic();
    while (prefix < tokens.length) {
      const child = node.children.get(this.keyFn(tokens.slice(prefix)));
      if (!child) return { node, len: prefix };
      const prev = node;
      node = child;
      let m = alignDown(commonPrefix(node.key, tokens.slice(prefix)), this.pageSize);
      if (m === 0) {
        node = prev;
        return { node, len: prefix };
      }
      prefix += m;
      if (m !== node.length) {
        node = this.splitAt(node, m);
        node.ts = tic;
        return { node, len: prefix };
      }
      node.ts = tic;
    }
    return { node, len: prefix };
  }

  matchPrefix(tokens: number[]): { node: RadixNode; len: number; indices: number[] } {
    const r = this.walk(tokens);
    return { node: r.node, len: r.len, indices: this.pathIndices(r.node) };
  }

  /** 从节点沿父指针收到根的 KV 索引序列 */
  pathIndices(node: RadixNode | null): number[] {
    const out: number[] = [];
    let n = node;
    while (n && n.parent) {
      out.unshift(...n.value);
      n = n.parent;
    }
    return out;
  }

  insertPrefix(tokens: number[], indices: number[]): { node: RadixNode; len: number } {
    const insertLen = alignDown(tokens.length, this.pageSize);
    const t = tokens.slice(0, insertLen);
    const idx = indices.slice(0, insertLen);
    const r = this.walk(t);
    let node = r.node;
    if (r.len !== insertLen) {
      const nn = new RadixNode(t.slice(r.len), idx.slice(r.len), this.nextTic());
      nn.parent = node;
      node.children.set(this.keyFn(nn.key), nn);
      this.evictableSize += nn.length;
      node = nn;
    }
    return { node, len: insertLen };
  }

  lock(node: RadixNode | null, unlock = false): void {
    let n = node;
    if (unlock) {
      while (n && n !== this.root) {
        n.ref -= 1;
        if (n.ref <= 0) {
          n.ref = 0;
          this.evictableSize += n.length;
          this.protectedSize -= n.length;
        }
        n = n.parent;
      }
    } else {
      while (n && n !== this.root) {
        if (n.ref === 0) {
          this.evictableSize -= n.length;
          this.protectedSize += n.length;
        }
        n.ref += 1;
        n = n.parent;
      }
    }
  }

  private collectLeaves(): RadixNode[] {
    const out: RadixNode[] = [];
    const stack: RadixNode[] = [this.root];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.isLeaf()) {
        if (node !== this.root && node.ref === 0) out.push(node);
      } else {
        for (const c of node.children.values()) stack.push(c);
      }
    }
    return out;
  }

  /** 返回被淘汰的 KV token 索引；可淘汰量不足时抛错，与真实实现的断言一致 */
  evict(size: number): number[] {
    if (size === 0) return [];
    if (size > this.evictableSize) {
      throw new Error(`assert size <= self.evictable_size 失败：要淘汰 ${size} 个 token，可淘汰量只有 ${this.evictableSize}`);
    }
    const heap = new MinHeap();
    for (const n of this.collectLeaves()) heap.push(n);
    const out: number[] = [];
    let evicted = 0;
    while (evicted < size) {
      const node = heap.pop();
      if (!node) throw new Error(`缓存不够淘汰：需要 ${size}，已淘汰 ${evicted}`);
      if (node.ref !== 0 || !node.isLeaf() || node === this.root) throw new Error("淘汰候选状态不合法");
      evicted += node.length;
      out.push(...node.value);
      this.evictableSize -= node.length;
      const parent = node.parent!;
      parent.children.delete(this.keyFn(node.key));
      node.parent = null;
      if (parent.isLeaf() && parent.ref === 0 && parent !== this.root) heap.push(parent);
    }
    return out;
  }

  sizeInfo(): { evictable: number; protected: number } {
    return { evictable: this.evictableSize, protected: this.protectedSize };
  }

  /** 整棵树的 token 总数，用于完整性自检 */
  totalSize(): number {
    let total = 0;
    const stack: RadixNode[] = [this.root];
    while (stack.length) {
      const n = stack.pop()!;
      if (n !== this.root) total += n.length;
      for (const c of n.children.values()) stack.push(c);
    }
    return total;
  }

  nodes(): { node: RadixNode; depth: number }[] {
    const out: { node: RadixNode; depth: number }[] = [];
    const visit = (n: RadixNode, d: number): void => {
      out.push({ node: n, depth: d });
      for (const c of n.children.values()) visit(c, d + 1);
    };
    visit(this.root, 0);
    return out;
  }
}

export interface ReqSim {
  uid: number;
  prompt: number[];
  inputIds: number[];
  outputLen: number;
  cachedLen: number;
  deviceLen: number;
  maxDeviceLen: number;
  tableIdx: number;
  allocatedTokens: number;
  handle: RadixNode | null;
  locked: boolean;
  finished: boolean;
  rejected: boolean;
  /** token 位置 → 物理 KV 位置；与 page_table 的一行对应 */
  cells: Map<number, number>;
}

export interface SimSnapshot {
  freePages: number[];
  rows: number;
  cols: number;
  pageTable: (number | null)[][];
  evictable: number;
  protectedSize: number;
  cachePages: number;
  /** 已分配但尚未进树的页数：运行中请求持有的扩展页 */
  inflightPages: number;
  /** 空闲 + 缓存 恰好等于总页数，也就是真实代码调用 check_integrity 时该成立的条件 */
  integrityStrict: boolean;
  integrity: string | null;
}

export interface OpResult {
  message: string;
  error: string | null;
  /** 与 ops[i].text 的描述不一致时的说明 */
  divergence: string | null;
  highlightCells: { row: number; col: number }[];
  highlightPages: number[];
  highlightNodes: number[];
  newNodes: number[];
}

export class CacheSim {
  readonly pageSize: number;
  readonly numPages: number;
  readonly maxRunningReq: number;
  readonly tree: RadixTree;
  freeSlots: number[];
  tableFree: number[];
  reqs = new Map<number, ReqSim>();
  rows: number;
  cols: number;

  private fresh = 0;
  private pending = new Map<number, { prompt: number; output: number }>();
  private pendingHit = new Map<number, number>();

  constructor(params: SimParams) {
    this.pageSize = params.page_size;
    this.numPages = params.num_pages;
    this.maxRunningReq = params.max_running_req;
    // free_slots 保存页对齐的 token 偏移：CacheManager.__init__
    this.freeSlots = Array.from({ length: params.num_pages }, (_, i) => i * params.page_size);
    // TableManager 的槽位池是 list(range(max_running_req))，allocate 从末尾弹出
    this.tableFree = Array.from({ length: params.max_running_req }, (_, i) => i);
    this.tree = new RadixTree(params.page_size);
    this.rows = params.max_running_req + 1; // 真实 page_table 多一行留给 dummy 请求
    this.cols = Math.max(8, params.page_size * 4);
  }

  /** 先扫一遍脚本，记下每条请求的 prompt/output 长度与命中长度 */
  prime(ops: SimOp[]): void {
    for (const op of ops) {
      if (op.op === "submit" && op.uid !== undefined) this.pending.set(op.uid, { prompt: op.prompt ?? 0, output: op.output ?? 0 });
      if ((op.op === "match" || op.op === "admit") && op.uid !== undefined && op.hit) this.pendingHit.set(op.uid, op.hit);
    }
  }

  private freshTokens(n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(this.fresh++);
    return out;
  }

  /** 沿树取一条路径的前 n 个 token，用来构造「命中已有前缀」的请求 */
  private treePrefixTokens(n: number): number[] {
    const out: number[] = [];
    let node: RadixNode | null = this.tree.root;
    while (node && out.length < n) {
      let next: RadixNode | undefined;
      for (const c of node.children.values()) {
        next = c;
        break;
      }
      if (!next) break;
      const take = Math.min(next.length, n - out.length);
      out.push(...next.key.slice(0, take));
      node = next;
    }
    return out;
  }

  private ensureReq(uid: number, promptLen: number, outputLen: number): ReqSim {
    let req = this.reqs.get(uid);
    if (!req) {
      const hit = this.pendingHit.get(uid) ?? 0;
      const shared = hit > 0 ? this.treePrefixTokens(hit) : [];
      while (shared.length < hit) shared.push(this.fresh++);
      const prompt = [...shared, ...this.freshTokens(Math.max(0, promptLen - shared.length))];
      req = {
        uid,
        prompt,
        inputIds: prompt.slice(),
        outputLen,
        cachedLen: 0,
        deviceLen: 0,
        maxDeviceLen: promptLen + outputLen,
        tableIdx: -1,
        allocatedTokens: 0,
        handle: null,
        locked: false,
        finished: false,
        rejected: false,
        cells: new Map(),
      };
      this.reqs.set(uid, req);
    }
    return req;
  }

  private reqFor(op: SimOp): ReqSim {
    const uid = op.uid ?? 0;
    const known = this.pending.get(uid);
    return this.ensureReq(uid, known?.prompt ?? op.prompt ?? 0, known?.output ?? op.output ?? 0);
  }

  private pageTable(): (number | null)[][] {
    const t: (number | null)[][] = Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => null));
    for (const req of this.reqs.values()) {
      if (req.tableIdx < 0 || req.tableIdx >= this.rows) continue;
      for (const [col, phys] of req.cells) {
        if (col < this.cols) t[req.tableIdx][col] = phys;
      }
    }
    return t;
  }

  snapshot(): SimSnapshot {
    const info = this.tree.sizeInfo();
    const cachePages = Math.floor(this.tree.totalSize() / this.pageSize);
    const free = this.freeSlots.length;
    const inflight = this.numPages - free - cachePages;
    const ok = free + cachePages === this.numPages;
    return {
      freePages: [...this.freeSlots].sort((a, b) => a - b),
      rows: this.rows,
      cols: this.cols,
      pageTable: this.pageTable(),
      evictable: info.evictable,
      protectedSize: info.protected,
      cachePages,
      inflightPages: inflight,
      integrityStrict: ok,
      // 运行中请求的扩展页既不在空闲里也不在树上，所以这条恒等式只在全部请求停下时成立。
      // 真实代码也只在 run_when_idle 里调用 check_integrity，这里如实把三项都列出来。
      integrity: ok
        ? `空闲 ${free} 页 + 缓存 ${cachePages} 页 == 总 ${this.numPages} 页`
        : `空闲 ${free} + 运行中占用 ${inflight} + 缓存 ${cachePages} == 总 ${this.numPages} 页`,
    };
  }

  private pageToToken(pages: number[]): number[] {
    if (this.pageSize === 1) return pages;
    const out: number[] = [];
    for (const p of pages) for (let k = 0; k < this.pageSize; k++) out.push(p + k);
    return out;
  }

  /** 对应 CacheManager._allocate：不够就先淘汰，再从头取页 */
  private allocatePages(needed: number): { pages: number[]; evictedPages: number[] } {
    const evictedPages: number[] = [];
    if (needed > this.freeSlots.length) {
      const missing = needed - this.freeSlots.length;
      const evicted = this.tree.evict(missing * this.pageSize);
      for (let i = 0; i < evicted.length; i += this.pageSize) evictedPages.push(evicted[i]);
      this.freeSlots = [...this.freeSlots, ...evictedPages].sort((a, b) => a - b);
      if (this.freeSlots.length < needed) throw new Error(`淘汰后仍不够：需要 ${needed} 页，只有 ${this.freeSlots.length} 页`);
    }
    const pages = this.freeSlots.slice(0, needed);
    this.freeSlots = this.freeSlots.slice(needed);
    return { pages, evictedPages };
  }

  private doMatch(req: ReqSim): { node: RadixNode; len: number } {
    const inputLen = req.prompt.length;
    const r = this.tree.matchPrefix(req.prompt.slice(0, Math.max(0, inputLen - 1)));
    req.cachedLen = r.len;
    req.handle = r.node;
    return { node: r.node, len: r.len };
  }

  runOp(op: SimOp): OpResult {
    const base: OpResult = { message: "", error: null, divergence: null, highlightCells: [], highlightPages: [], highlightNodes: [], newNodes: [] };
    try {
      switch (op.op) {
        case "note":
          return { ...base, message: op.text };
        case "submit": {
          const uid = op.uid ?? 0;
          this.pending.set(uid, { prompt: op.prompt ?? 0, output: op.output ?? 0 });
          const req = this.reqFor(op);
          this.cols = Math.max(this.cols, req.prompt.length + req.outputLen, this.pageSize * 2);
          return { ...base, message: `写入待入队：uid=${uid}，prompt ${req.prompt.length} token，最多再生成 ${req.outputLen} 个；table_idx 尚未分配。` };
        }
        case "admit":
        case "match": {
          const req = this.reqFor(op);
          const r = this.doMatch(req);
          const divergence = op.hit !== undefined && op.hit !== r.len ? `数据里写的是命中 ${op.hit}，按当前树状态实际命中 ${r.len}。` : null;
          return {
            ...base,
            divergence,
            highlightNodes: [r.node.id],
            message: `match_prefix(${req.prompt.length - 1} 个 token) 命中 ${r.len} 个 token；cached_len=${req.cachedLen}，extend_len=${req.prompt.length - req.cachedLen}。`,
          };
        }
        case "lock": {
          const req = this.reqFor(op);
          if (req.handle && !req.locked) {
            this.tree.lock(req.handle, false);
            req.locked = true;
            // 命中部分写进页表对应行：对应 _try_allocate_one 里的 copy_(handle.get_matched_indices())
            const seq = this.tree.pathIndices(req.handle);
            for (let c = 0; c < req.cachedLen && c < seq.length; c++) req.cells.set(c, seq[c]);
            // 命中的 token 已经占用了物理位置，之后新增的页从它后面接着写
            req.allocatedTokens = Math.max(req.allocatedTokens, req.cachedLen);
          }
          return { ...base, message: `lock_handle：沿路 ref_count +1，这 ${req.cachedLen} 个 token 从可淘汰量移到受保护量。`, highlightNodes: req.handle ? [req.handle.id] : [] };
        }
        case "allocate": {
          const req = this.reqFor(op);
          if (req.tableIdx < 0) req.tableIdx = this.tableFree.pop() ?? this.maxRunningReq;
          const pages = op.pages ?? 0;
          const wasFree = this.freeSlots.length;
          const { pages: got, evictedPages } = this.allocatePages(pages);
          const tokens = this.pageToToken(got);
          const start = req.allocatedTokens;
          for (let i = 0; i < tokens.length; i++) req.cells.set(start + i, tokens[i]);
          req.allocatedTokens += tokens.length;
          if (req.deviceLen < req.prompt.length) req.deviceLen = req.prompt.length;
          const cells: { row: number; col: number }[] = [];
          for (let c = start; c < req.allocatedTokens; c++) cells.push({ row: req.tableIdx, col: c });
          return {
            ...base,
            highlightPages: got,
            highlightCells: cells,
            message: `allocate(${pages})：申请 ${pages} 页（空闲 ${wasFree} → ${this.freeSlots.length}）${evictedPages.length ? `，先淘汰了 ${evictedPages.length} 页` : ""}；页起点展开成 token 级位置，写进页表第 ${req.tableIdx} 行的 [${start}, ${req.allocatedTokens})。`,
          };
        }
        case "decode": {
          const req = this.reqFor(op);
          const before = req.deviceLen;
          req.cachedLen = req.deviceLen;
          req.deviceLen += 1;
          const needMore = divCeil(req.deviceLen, this.pageSize) > divCeil(req.allocatedTokens, this.pageSize);
          return {
            ...base,
            message: `complete_one()：cached_len=${req.cachedLen}，device_len ${before} → ${req.deviceLen}。${needMore ? "已跨过页边界，还需要新页。" : "仍在已有页内，不需要新页。"}`,
          };
        }
        case "finish": {
          const req = this.reqFor(op);
          // 已分配页覆盖的 token 视为本轮结束时的 cached 区（模拟跨轮的 decode 结果）
          const target = req.allocatedTokens;
          while (req.inputIds.length < target) req.inputIds.push(this.fresh++);
          req.deviceLen = target;
          req.cachedLen = target;
          const idx: number[] = [];
          for (let c = 0; c < target; c++) idx.push(req.cells.get(c) ?? -1);
          const t = this.tree.insertPrefix(req.inputIds.slice(0, target), idx);
          if (req.locked) {
            this.tree.lock(req.handle, true);
            req.locked = false;
          }
          req.finished = true;
          return {
            ...base,
            highlightNodes: req.handle ? [t.node.id, req.handle.id] : [t.node.id],
            newNodes: [t.node.id],
            message: `cache_req(finished)：解锁原句柄，把新算出的 part 插进树；insert_prefix 在树上匹配到 ${t.len} 个 token。`,
          };
        }
        case "tree_insert": {
          const req = this.reqFor(op);
          const len = op.length ?? req.cachedLen;
          const idx: number[] = [];
          for (let c = 0; c < len; c++) idx.push(req.cells.get(c) ?? -1);
          const t = this.tree.insertPrefix(req.inputIds.slice(0, len), idx);
          return { ...base, highlightNodes: [t.node.id], newNodes: [t.node.id], message: `insert_prefix：先按页对齐取前 ${alignDown(len, this.pageSize)} 个 token，树上匹配到 ${t.len}。` };
        }
        case "evict": {
          const need = op.need_pages ?? 0;
          const free = this.freeSlots.length;
          if (need <= free) return { ...base, message: `需要 ${need} 页，已有 ${free} 页，无需淘汰。` };
          const missing = need - free;
          const evicted = this.tree.evict(missing * this.pageSize);
          const pages: number[] = [];
          for (let i = 0; i < evicted.length; i += this.pageSize) pages.push(evicted[i]);
          this.freeSlots = [...this.freeSlots, ...pages].sort((a, b) => a - b);
          return { ...base, highlightPages: pages, message: `evict(${missing * this.pageSize})：淘汰 ${pages.length} 页，空闲 ${free} → ${this.freeSlots.length}。只淘汰 ref_count 为 0 的叶子，按 timestamp 从旧到新。` };
        }
        case "degrade": {
          const req = this.reqFor(op);
          req.rejected = true;
          return { ...base, message: `准入失败：estimated_len + reserved_size > available_size，uid=${req.uid} 本轮不进批次。` };
        }
        case "integrity": {
          const s = this.snapshot();
          const running = s.inflightPages > 0;
          return {
            ...base,
            message: running
              ? `${s.integrity}。此刻还有请求在跑，它占着 ${s.inflightPages} 页，所以恒等式不成立；真实代码只在 run_when_idle 时调用这个检查。`
              : `${s.integrity}`,
            error: !s.integrityStrict && !running
              ? `完整性检查失败：${s.integrity}`
              : null,
          };
        }
        default:
          return { ...base, message: op.text || `未知操作：${op.op}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const divergence =
        op.op === "evict"
          ? "这一步的实际结果与上面的文字不同：文字假设 r1 留下的页此刻可淘汰，但它正被 r2 引用（lock_handle 把 ref_count 提到 1），因此属于受保护量，evict 按实现会直接断言失败。"
          : null;
      return { ...base, error: message, divergence };
    }
  }
}
