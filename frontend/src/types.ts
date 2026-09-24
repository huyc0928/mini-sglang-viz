// 与后端 API 对应的类型定义。字段名与 Rust 侧的 model.rs 一致。

export interface Param {
  name: string;
  annotation: string;
  default: string;
  kind: string;
}

export interface FieldInfo {
  name: string;
  annotation: string;
  default: string;
  init: boolean;
  origin: string;
  line: number;
}

export interface AttrInfo {
  name: string;
  type: string;
  line: number;
  value: string;
}

export interface AssertInfo {
  line: number;
  text: string;
  message: string;
}

export interface AssignmentOut {
  target: string;
  method: string;
  line: number;
  value: string;
}

export interface CallOut {
  line: number;
  callee: string;
  target: string;
  confidence: string;
  text: string;
}

export interface SimpleCall {
  line: number;
  callee: string;
  text?: string;
}

export interface ExternalCall {
  line: number;
  callee: string;
  lib: string;
}

export interface SymbolOut {
  id: string;
  name: string;
  qualname: string;
  kind: "class" | "function" | "method";
  module: string;
  group: string;
  file: string;
  lineno: number;
  end_lineno: number;
  signature: string;
  params: Param[];
  returns: string;
  decorators: string[];
  bases: string[];
  docstring: string;
  fields: FieldInfo[];
  methods: string[];
  assignments: AssignmentOut[];
  attrs: AttrInfo[];
  asserts: AssertInfo[];
  is_dataclass: boolean;
  is_property: boolean;
  loc: number;
  calls: CallOut[];
  unresolved: SimpleCall[];
  external: ExternalCall[];
  module_refs: SimpleCall[];
  imports: string[];
}

export interface EdgeOut {
  from: string;
  to: string;
  count: number;
  confidence: string;
  lines: number[];
}

export interface ModuleOut {
  name: string;
  files: string[];
  loc: number;
  other_files: string[];
  description: string;
  path_hint: string;
}

export interface DataStructOut {
  id: string;
  name: string;
  module: string;
  group: string;
  file: string;
  lineno: number;
  end_lineno: number;
  docstring: string;
  bases: string[];
  kind: "dataclass" | "namedtuple" | "class";
  fields: FieldInfo[];
  attrs: AttrInfo[];
  methods: string[];
  asserts: AssertInfo[];
  assignments: AssignmentOut[];
}

export interface Stats {
  py_files: number;
  py_loc: number;
  symbols: number;
  classes: number;
  functions: number;
  methods: number;
  edges: number;
  resolved_edges: number;
  inferred_edges: number;
  unresolved_calls: number;
  external_calls: number;
  datastructs: number;
  csrc_symbols: number;
  triton_symbols: number;
  modules: number;
  external_top: [string, number][];
}

export interface Neighbor {
  id: string;
  name: string;
  kind: string;
  group: string;
  file: string;
  lineno: number;
  confidence: string;
  count: number;
}

export interface SymbolDetail {
  symbol: SymbolOut;
  callees: Neighbor[];
  callers: Neighbor[];
  source: SourceChunk | null;
}

export interface Hit {
  id: string;
  name: string;
  qualname: string;
  kind: string;
  group: string;
  file: string;
  lineno: number;
  signature: string;
  score: number;
  why: string;
}

export interface GraphNode {
  id: string;
  name: string;
  kind: string;
  group: string;
  file: string;
  lineno: number;
  depth: number;
  loc: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  confidence: string;
  count: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface SourceLine {
  n: number;
  text: string;
}

export interface SourceChunk {
  path: string;
  start: number;
  end: number;
  total?: number;
  lines: SourceLine[];
}

export interface KernelItem {
  name: string;
  kind: string;
  file: string;
  line: number;
  end_line: number;
  signature: string;
  base: string;
  decorators: string[];
  docstring: string;
  params: Param[];
  ext: string;
}

export interface FileMeta {
  path: string;
  module: string;
  group: string;
  loc: number;
  symbols: string[];
}

// ---- 手工内容（content/flows.json） ----

export interface ContentStep {
  label: string;
  symbol?: string;
  hint?: string;
}

export interface ReadingPath {
  title: string;
  goal: string;
  steps: ContentStep[];
}

export interface ModuleNote {
  role: string;
  entry: string;
  key_symbols: string[];
  notes: string[];
}

export interface FlowStep {
  from: string;
  to: string;
  label: string;
  detail?: string;
  symbol?: string;
  hint?: string;
}

export interface Flow {
  id: string;
  title: string;
  summary: string;
  actors: string[];
  steps: FlowStep[];
}

export interface TopoNode {
  id: string;
  label: string;
  kind: string;
  note: string;
  symbol?: string;
}

export interface TopoLink {
  from: string;
  to: string;
  label: string;
  kind: string;
}

export interface SimOp {
  op: string;
  text: string;
  symbol?: string;
  hint?: string;
  uid?: number;
  prompt?: number;
  output?: number;
  pages?: number;
  hit?: number;
  length?: number;
  need_pages?: number;
}

export interface KvScenario {
  title: string;
  desc: string;
  params: { page_size: number; num_pages: number; max_running_req: number };
  ops: SimOp[];
}

export interface Content {
  module_notes: Record<string, ModuleNote>;
  reading_order: ReadingPath[];
  process_topology: { nodes: TopoNode[]; links: TopoLink[] };
  flows: Flow[];
  kv_scenario: KvScenario;
}
