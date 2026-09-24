#!/usr/bin/env python3
"""从 mini-sglang 源码静态抽取符号、字段与调用关系，输出 data/*.json。

只读方式运行，不修改被分析仓库。输出是确定性的：所有列表都排序。
"""

from __future__ import annotations

import ast
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = ROOT.parent / "mini-sglang"
OUT_DIR = ROOT / "data"

PY_PACKAGE_ROOT = SRC_ROOT / "python"
CSRC_ROOT = SRC_ROOT / "python" / "minisgl" / "kernel" / "csrc"
TRITON_ROOT = SRC_ROOT / "python" / "minisgl" / "kernel" / "triton"

SKIP_DIRS = {"__pycache__", ".git", ".venv", ".idea"}

EXTERNAL_ROOTS = {
    "torch", "F", "flashinfer", "triton", "tl", "logging", "os", "sys", "math", "time",
    "heapq", "re", "json", "functools", "itertools", "collections", "dataclasses",
    "contextlib", "typing", "asyncio", "signal", "struct", "gc", "inspect", "copy",
    "msgpack", "zmq", "numpy", "np", "enum", "abc", "warnings", "traceback", "argparse",
    "partial", "logger", "uvicorn", "fastapi", "openai", "transformers", "safetensors",
    "modelscope", "huggingface_hub", "pytest", "tqdm", "multiprocessing", "subprocess",
}

BUILTINS = {
    "len", "super", "isinstance", "issubclass", "range", "max", "min", "getattr", "setattr",
    "str", "int", "float", "bool", "bytes", "list", "dict", "set", "tuple", "type", "sorted",
    "sum", "all", "any", "zip", "enumerate", "map", "filter", "print", "repr", "hash", "id",
    "abs", "round", "divmod", "next", "iter", "open", "format", "vars", "dir", "callable",
    "ValueError", "RuntimeError", "TypeError", "KeyError", "IndexError", "AssertionError",
    "NotImplementedError", "Exception", "StopIteration", "AttributeError", "ZeroDivisionError",
    "FileNotFoundError", "OverflowError", "OSError", "ImportError", "KeyboardInterrupt",
    "object", "frozenset", "sorted", "reversed", "slice", "property", "staticmethod",
    "classmethod", "hasattr", "globals", "locals", "exec", "eval", "input",
}

CONTAINER_METHODS = {
    "append", "extend", "insert", "remove", "pop", "clear", "copy", "count", "index",
    "sort", "reverse", "get", "keys", "values", "items", "update", "setdefault",
    "add", "discard", "union", "intersection", "difference", "push", "put", "join",
    "split", "strip", "lower", "upper", "startswith", "endswith", "getvalue",
}

# 第三方类型名归到它所属的库，避免统计里出现一堆单类型条目
LIB_ALIASES = {
    "Tensor": "torch", "Module": "torch", "Event": "torch", "CUDAGraph": "torch",
    "Stream": "torch", "nn": "torch", "device": "torch", "dtype": "torch",
    "Any": "typing", "Dict": "typing", "List": "typing", "Final": "typing",
    "None": "typing", "TypeAlias": "typing", "Tuple": "typing", "Set": "typing",
    "AutoTokenizer": "transformers", "AutoConfig": "transformers",
    "OpenAI": "openai", "Queue": "multiprocessing", "Request": "fastapi",
    "StreamingResponse": "fastapi", "PromptSession": "prompt_toolkit",
}


def normalize_lib(label: str) -> str:
    """把 external 标签收敛成库名。"""
    if label.startswith("external:"):
        label = label.split(":", 1)[1]
    label = label.split(":")[0]
    root = label.split(".")[-1]
    return LIB_ALIASES.get(root, root or label)


# ---------------------------------------------------------------- 工具函数


def module_name_of(path: Path) -> str:
    rel = path.relative_to(PY_PACKAGE_ROOT).with_suffix("")
    parts = list(rel.parts)
    if parts and parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts) or "__root__"


def unparse(node: ast.AST | None) -> str:
    if node is None:
        return ""
    try:
        return ast.unparse(node)
    except Exception:
        return "?"


def dotted_name(node: ast.AST) -> str | None:
    parts: list[str] = []
    cur = node
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        parts.append(cur.id)
    else:
        return None
    return ".".join(reversed(parts))


GENERIC_HEADS = {
    "Optional", "List", "Dict", "Set", "Tuple", "Iterator", "Iterable", "Sequence",
    "Callable", "Type", "Mapping", "list", "dict", "set", "tuple", "frozenset", "ClassVar",
}


def simple_type(text: str) -> str:
    """从注解或赋值右侧表达式里取出简单类型名。

    能处理 "GraphRunner(**kwargs)" 这类构造调用、泛型注解，以及带模块前缀的点号名。
    """
    if not text:
        return ""
    text = text.strip().lstrip("*& ")
    m = re.match(r"^([A-Za-z_][\w\.]*)\[(.*)\]$", text)
    if m and m.group(1).split(".")[-1] in GENERIC_HEADS:
        for part in _split_top_level(m.group(2)):
            t = simple_type(part)
            if t:
                return t
        return ""
    # 剥掉调用参数与下标
    head = re.split(r"[\(\[]", text)[0].strip()
    if not head:
        return ""
    head = head.split(".")[-1]
    if not re.fullmatch(r"[A-Za-z_]\w*", head):
        return ""
    return head if head[:1].isupper() else ""


def _split_top_level(text: str) -> list[str]:
    out, depth, cur = [], 0, []
    for ch in text:
        if ch in "[(":
            depth += 1
        elif ch in "])":
            depth -= 1
        if ch == "," and depth == 0:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    out.append("".join(cur))
    return out


def collect_py_files() -> list[Path]:
    out = []
    for p in sorted((SRC_ROOT / "python").rglob("*.py")):
        if any(part in SKIP_DIRS or part.endswith(".egg-info") for part in p.parts):
            continue
        out.append(p)
    return out


def module_of_path(rel: str) -> str:
    parts = rel.split("/")
    if len(parts) >= 3 and parts[0] == "python" and parts[1] == "minisgl":
        return Path(parts[2]).stem if len(parts) == 3 else parts[2]
    return "other"


def _iter_own_body(node: ast.AST):
    """遍历函数体，不进入嵌套的 def/class。"""
    stack = list(getattr(node, "body", []))
    while stack:
        cur = stack.pop()
        if isinstance(cur, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        yield cur
        stack.extend(ast.iter_child_nodes(cur))


# ---------------------------------------------------------------- 数据结构


@dataclass
class Param:
    name: str
    annotation: str
    default: str
    kind: str


@dataclass
class FieldInfo:
    name: str
    annotation: str = ""
    default: str = ""
    init: bool = True
    origin: str = ""
    line: int = 0


@dataclass
class CallSite:
    line: int
    text: str
    callee: str
    target: str | None = None
    confidence: str = "unresolved"
    external: str = ""


@dataclass
class Symbol:
    id: str
    name: str
    qualname: str
    kind: str
    module: str
    file: str
    lineno: int
    end_lineno: int
    signature: str = ""
    params: list[Param] = field(default_factory=list)
    returns: str = ""
    decorators: list[str] = field(default_factory=list)
    bases: list[str] = field(default_factory=list)
    docstring: str = ""
    fields: list[FieldInfo] = field(default_factory=list)
    methods: list[str] = field(default_factory=list)
    calls: list[CallSite] = field(default_factory=list)
    assignments: list[dict] = field(default_factory=list)
    attrs: list[dict] = field(default_factory=list)
    asserts: list[dict] = field(default_factory=list)
    is_dataclass: bool = False
    is_property: bool = False
    loc: int = 0
    imports: list[str] = field(default_factory=list)


# ---------------------------------------------------------------- 全局索引


class Index:
    """跨文件的名字索引，供调用解析查询。"""

    def __init__(self) -> None:
        self.collectors: list[FileCollector] = []
        self.by_module: dict[str, FileCollector] = {}
        self.classes: dict[str, tuple[FileCollector, ast.ClassDef]] = {}
        self.module_defs: dict[str, dict[str, str]] = {}        # module -> name -> sid
        self.class_fields: dict[str, dict[str, str]] = {}        # cls -> field -> type
        self.class_returns: dict[str, dict[str, str]] = {}       # cls -> method -> ret
        self.module_returns: dict[str, dict[str, str]] = {}      # module -> func -> ret
        self.class_bases: dict[str, list[str]] = {}
        self.local_returns: dict[str, dict[str, str]] = {}       # module -> qualname -> ret

    def add(self, fc: "FileCollector") -> None:
        self.collectors.append(fc)
        self.by_module[fc.module] = fc
        defs: dict[str, str] = {}
        for node in fc.tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defs[node.name] = f"{fc.module}.{node.name}"
            elif isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Name):
                        defs[t.id] = f"{fc.module}.{t.id}"
            elif isinstance(node, ast.ImportFrom):
                mod = fc._resolve_relative(node.level, node.module)
                for alias in node.names:
                    if alias.name != "*":
                        # "@mod:sym" 表示再导出，解析时递归穿透
                        defs[alias.asname or alias.name] = f"@{mod}:{alias.name}"
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    defs[alias.asname or alias.name.split(".")[0]] = f"@{alias.name}"
        self.module_defs[fc.module] = defs

    def build(self) -> None:
        for fc in self.collectors:
            for node in ast.walk(fc.tree):
                if isinstance(node, ast.ClassDef):
                    self.classes.setdefault(node.name, (fc, node))
                    self.class_bases.setdefault(node.name, [unparse(b) for b in node.bases])
        # 第一步：注解能给出的类型
        call_fields: dict[str, dict[str, ast.AST]] = {}
        for name, (fc, node) in self.classes.items():
            fmap: dict[str, str] = {}
            rmap: dict[str, str] = {}
            pending: dict[str, tuple[ast.AST, ast.AST]] = {}
            for stmt in node.body:
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                    t = simple_type(unparse(stmt.annotation))
                    if t:
                        fmap[stmt.target.id] = self.canonical(fc, t)
                if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and stmt.returns is not None:
                    t = simple_type(unparse(stmt.returns))
                    if t:
                        rmap[stmt.name] = t
            for m in node.body:
                if not isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                for sub in _iter_own_body(m):
                    if isinstance(sub, ast.Assign):
                        for tgt in sub.targets:
                            d = dotted_name(tgt)
                            if not d or not d.startswith("self."):
                                continue
                            fname = d.split(".", 1)[1]
                            if "." in fname:
                                continue
                            t = simple_type(unparse(sub.value))
                            if t:
                                fmap.setdefault(fname, self.canonical(fc, t))
                            else:
                                pending.setdefault(fname, (sub.value, m))
                    elif isinstance(sub, ast.AnnAssign) and isinstance(sub.target, ast.Attribute):
                        d = dotted_name(sub.target)
                        if d and d.startswith("self."):
                            fname = d.split(".", 1)[1]
                            if "." not in fname:
                                t = simple_type(unparse(sub.annotation)) or simple_type(unparse(sub.value))
                                if t:
                                    fmap.setdefault(fname, self.canonical(fc, t))
            self.class_fields[name] = fmap
            self.class_returns[name] = rmap
            call_fields[name] = pending
        # 第二步：模块返回类型就绪后，用工厂调用的返回注解补字段类型
        for fc in self.collectors:
            mret: dict[str, str] = {}
            for q, t in fc.return_types.items():
                mret.setdefault(q.split(".")[-1], t)
            self.module_returns[fc.module] = mret
        for name, pending in call_fields.items():
            fc, _ = self.classes[name]
            for fname, (value, method) in pending.items():
                t = ""
                if isinstance(value, ast.Call):
                    t = self._return_of_call_in(fc, value, name)
                elif isinstance(value, ast.Name):
                    # self.x = param，参数上的注解就是字段类型
                    a = method.args
                    for arg in list(a.posonlyargs) + list(a.args) + list(a.kwonlyargs):
                        if arg.arg == value.id:
                            t = simple_type(unparse(arg.annotation))
                            break
                if t:
                    self.class_fields[name].setdefault(fname, self.canonical(fc, t))

    def _return_of_call_in(self, fc: "FileCollector", call: ast.Call, cls_name: str) -> str:
        tgt = call.func
        if isinstance(tgt, ast.Name):
            imp = fc.imports.get(tgt.id)
            if imp and ":" in imp:
                mod, sym = imp.split(":", 1)
                t = self.func_return(mod, sym)
                if t:
                    return t
            t = self.func_return(fc.module, tgt.id)
            if t:
                return t
        elif isinstance(tgt, ast.Attribute):
            base = self._static_type(fc, tgt.value, cls_name)
            if base:
                t = self.func_return(base, tgt.attr)
                if t:
                    return t
        return ""

    def _static_type(self, fc: "FileCollector", node: ast.AST, cls_name: str) -> str:
        if isinstance(node, ast.Name):
            if node.id in {"self", "cls"}:
                return cls_name
            imp = fc.imports.get(node.id)
            if imp:
                return imp.split(":", 1)[1] if ":" in imp else imp
            return ""
        if isinstance(node, ast.Attribute):
            base = self._static_type(fc, node.value, cls_name)
            if base:
                return self.field_type(base, node.attr)
        return ""

    # -- 查询 ---------------------------------------------------------

    def field_type(self, cls: str, field_name: str) -> str:
        seen = set()
        cur = cls
        while cur and cur not in seen:
            seen.add(cur)
            t = self.class_fields.get(cur, {}).get(field_name)
            if t:
                return t
            bases = self.class_bases.get(cur, [])
            cur = bases[0].split("[")[0].split(".")[-1] if bases else ""
        return ""

    def canonical(self, fc: "FileCollector", name: str, depth: int = 0) -> str:
        """把导入别名还原成真实类名，如 Qwen3Attn -> RopeAttn。"""
        if not name or depth > 4:
            return name
        if name in self.classes:
            return name
        imp = fc.imports.get(name)
        if not imp:
            return name
        if ":" in imp:
            mod, sym = imp.split(":", 1)
            sid = self.module_symbol(mod, sym)
            return sid.split(".")[-1] if sid else sym
        return imp

    def method_id(self, cls: str, method: str) -> str | None:
        seen = set()
        cur = cls
        while cur and cur not in seen:
            seen.add(cur)
            if cur in self.classes:
                fc, node = self.classes[cur]
                for m in node.body:
                    if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and m.name == method:
                        return f"{fc.module}.{cur}.{method}"
                for base in node.bases:
                    bn = unparse(base).split("[")[0].split(".")[-1]
                    found = self.method_id(bn, method)
                    if found:
                        return found
            break
        return None

    def method_return(self, cls: str, method: str) -> str:
        seen = set()
        cur = cls
        while cur and cur not in seen:
            seen.add(cur)
            t = self.class_returns.get(cur, {}).get(method)
            if t:
                return t
            bases = self.class_bases.get(cur, [])
            cur = bases[0].split("[")[0].split(".")[-1] if bases else ""
        return ""

    def module_symbol(self, module: str, name: str) -> str | None:
        seen = set()
        mod, sym = module, name
        while mod and (mod, sym) not in seen:
            seen.add((mod, sym))
            v = self.module_defs.get(mod, {}).get(sym)
            if v is None:
                return None
            if v.startswith("@"):
                rest = v[1:]
                if ":" not in rest:
                    return None
                mod, sym = rest.split(":", 1)
                continue
            return v
        return None

    def func_return(self, owner: str, func: str) -> str:
        """owner 可以是类名或模块点号名。"""
        if owner in self.classes:
            return self.method_return(owner, func)
        if owner in self.by_module:
            return self.module_returns.get(owner, {}).get(func, "")
        return ""


# ---------------------------------------------------------------- 单文件收集


class FileCollector:
    def __init__(self, path: Path, index: Index) -> None:
        self.path = path
        self.rel = str(path.relative_to(SRC_ROOT))
        self.module = module_name_of(path)
        self.source = path.read_text(encoding="utf-8")
        self.lines = self.source.splitlines()
        self.tree = ast.parse(self.source, filename=str(path))
        self.is_package = path.name == "__init__.py"
        self.index = index
        self.imports: dict[str, str] = {}
        self.star_imports: list[str] = []
        self.return_types: dict[str, str] = {}
        self.symbols: list[Symbol] = []

    # -- 导入 ---------------------------------------------------------

    def _resolve_relative(self, level: int, modname: str | None) -> str:
        if level == 0:
            return modname or ""
        parts = self.module.split(".")
        # 包内的 __init__.py 用 level=1 指自己，普通模块则要退一层
        strip = level - (1 if self.is_package else 0)
        base = parts[: len(parts) - strip] if strip > 0 else parts
        if modname:
            base = base + modname.split(".")
        return ".".join(base)

    def collect_imports(self) -> None:
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    local = alias.asname or alias.name.split(".")[0]
                    self.imports[local] = alias.name
            elif isinstance(node, ast.ImportFrom):
                mod = self._resolve_relative(node.level, node.module)
                for alias in node.names:
                    if alias.name == "*":
                        self.star_imports.append(mod)
                        continue
                    self.imports[alias.asname or alias.name] = f"{mod}:{alias.name}" if mod else alias.name

    def import_map(self) -> list[str]:
        return [f"{k} -> {v}" for k, v in sorted(self.imports.items())]

    def collect_returns(self) -> None:
        """先于全局索引建立：把每个函数的返回注解按函数名收集起来。"""
        for node in ast.walk(self.tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.returns is not None:
                t = simple_type(unparse(node.returns))
                if t:
                    self.return_types.setdefault(node.name, t)

    # -- 作用域内的类型推断 -------------------------------------------

    def scope_types(self, node: ast.AST, cls_name: str) -> dict[str, str]:
        """函数的参数与局部变量类型。分两遍，第二遍用第一遍的结果推断调用与三元表达式。"""
        table: dict[str, str] = {}
        a = getattr(node, "args", None)
        if a is not None:
            for arg in list(a.posonlyargs) + list(a.args) + list(a.kwonlyargs):
                t = simple_type(unparse(arg.annotation))
                if t:
                    table[arg.arg] = t
        assigns: list[tuple[str, ast.AST]] = []
        for sub in _iter_own_body(node):
            if isinstance(sub, ast.AnnAssign) and isinstance(sub.target, ast.Name):
                t = simple_type(unparse(sub.annotation))
                if t:
                    table[sub.target.id] = t
            elif isinstance(sub, ast.Assign):
                for tgt in sub.targets:
                    if isinstance(tgt, ast.Name):
                        assigns.append((tgt.id, sub.value))
        for name, value in assigns:
            if name in table:
                continue
            t = self.type_of_expr(value, table, cls_name)
            if t:
                table[name] = t
        return table

    def type_of_expr(self, node: ast.AST, scope: dict[str, str], cls_name: str) -> str:
        """推断表达式表示的类名或模块点号名。"""
        if isinstance(node, ast.Name):
            if node.id in {"self", "cls"} and cls_name:
                return cls_name
            if node.id in scope:
                return scope[node.id]
            return self.name_type(node.id)
        if isinstance(node, ast.Attribute):
            base = self.type_of_expr(node.value, scope, cls_name)
            if base:
                if base in self.index.by_module:
                    return self.index.module_symbol(base, node.attr) or ""
                t = self.index.field_type(base, node.attr)
                if t:
                    return self.index.canonical(self, t)
                if node.attr[:1].isupper() and node.attr in self.index.classes:
                    return node.attr
                if base not in self.index.classes:
                    # 外部库类型，继续向外传播，供调用点归类
                    return base
            return ""
        if isinstance(node, ast.Call):
            return self.return_of_call(node, scope, cls_name)
        if isinstance(node, ast.IfExp):
            return (self.type_of_expr(node.body, scope, cls_name)
                    or self.type_of_expr(node.orelse, scope, cls_name))
        if isinstance(node, (ast.Subscript, ast.Starred)):
            return self.type_of_expr(node.value, scope, cls_name)
        if isinstance(node, ast.Await):
            return self.type_of_expr(node.value, scope, cls_name)
        return ""

    def name_type(self, name: str) -> str:
        imp = self.imports.get(name)
        if imp:
            if ":" in imp:
                return self.index.canonical(self, name)
            return imp
        if name in self.index.module_defs.get(self.module, {}):
            sid = self.index.module_defs[self.module][name]
            last = sid.split(".")[-1]
            return last if last[:1].isupper() else ""
        if name in self.index.classes:
            return name
        return ""

    def return_of_call(self, call: ast.Call, scope: dict[str, str], cls_name: str) -> str:
        tgt = call.func
        if isinstance(tgt, ast.Name):
            if tgt.id in BUILTINS:
                return ""
            # 直接构造本项目里的类
            local_cls = simple_type(tgt.id)
            if local_cls:
                canonical = self.index.canonical(self, local_cls)
                if canonical in self.index.classes:
                    return canonical
            imp = self.imports.get(tgt.id)
            if imp and ":" in imp:
                mod, sym = imp.split(":", 1)
                t = self.index.func_return(mod, sym)
                if t:
                    return t
            if imp:
                # 外部模块的工厂，返回模块名以便归类为 external
                return imp if imp not in self.index.by_module else ""
            t = self.index.func_return(self.module, tgt.id)
            if t:
                return t
            for fc in self.index.collectors:
                t = self.index.func_return(fc.module, tgt.id)
                if t:
                    return t
            return ""
        if isinstance(tgt, ast.Attribute):
            base = self.type_of_expr(tgt.value, scope, cls_name)
            if base:
                return self.index.func_return(base, tgt.attr)
        return ""

    # -- 调用解析 -----------------------------------------------------

    def resolve_callee(self, call: ast.Call, scope: dict[str, str], cls_name: str, fn_q: str
                       ) -> tuple[str | None, str]:
        tgt = call.func
        root = (dotted_name(tgt) or unparse(tgt)).split(".")[0]
        if root in EXTERNAL_ROOTS:
            return None, f"external:{root}"

        if isinstance(tgt, ast.Name):
            name = tgt.id
            if name in BUILTINS:
                return None, "external:builtins"
            sid = self.index.module_symbol(self.module, name)
            if sid:
                return sid, "resolved"
            imp = self.imports.get(name)
            if imp:
                mod = imp.split(":", 1)[0]
                if mod in self.index.by_module:
                    if ":" in imp:
                        inner = self.index.module_symbol(mod, imp.split(":", 1)[1])
                        return (inner, "resolved") if inner else (None, "module-ref")
                    # 引用的是本项目模块本身
                    return None, "module-ref"
                return None, f"external:{normalize_lib(mod or name)}"
            return None, "unresolved"

        if isinstance(tgt, ast.Attribute):
            attr = tgt.attr
            base_expr = tgt.value
            # super().__init__() 之类的内置构造
            if isinstance(base_expr, ast.Call):
                inner = base_expr.func
                if isinstance(inner, ast.Name) and inner.id in BUILTINS:
                    return None, "external:builtins"
            base = self.type_of_expr(base_expr, scope, cls_name)
            if base:
                if base in self.index.by_module:
                    sid = self.index.module_symbol(base, attr)
                    return (sid, "resolved") if sid else (None, "module-ref")
                sid = self.index.method_id(base, attr)
                if sid:
                    d = dotted_name(base_expr)
                    conf = "inferred" if (d and d.startswith("self.")) else "resolved"
                    return sid, conf
                ft = self.index.field_type(base, attr)
                if ft and ft in self.index.classes:
                    call_sid = self.index.method_id(ft, "__call__")
                    if call_sid:
                        return call_sid, "inferred"
                if base not in self.index.classes:
                    # 类型来自第三方库，例如 AutoTokenizer.encode
                    return None, f"external:{normalize_lib(base)}"
            # 无类型的属性调用：容器与字典方法不计入未解析
            if attr in CONTAINER_METHODS:
                return None, "external:builtin-method"
            return None, "unresolved"

        return None, "unresolved"

    # -- 扫描 ---------------------------------------------------------

    def _decorators(self, node) -> list[str]:
        return [unparse(d) for d in node.decorator_list]

    def _signature(self, node) -> tuple[str, list[Param], str]:
        a = node.args
        params: list[Param] = []
        positional = list(a.posonlyargs) + list(a.args)
        for i, arg in enumerate(positional):
            if i == 0 and arg.arg in {"self", "cls"}:
                continue
            params.append(Param(name=arg.arg, annotation=unparse(arg.annotation),
                                default="", kind="pos"))
        if a.defaults:
            for p, d in zip(params[-len(a.defaults):], a.defaults):
                p.default = unparse(d)
        for arg, d in zip(a.kwonlyargs, a.kw_defaults):
            params.append(Param(name=arg.arg, annotation=unparse(arg.annotation),
                                default=unparse(d) if d is not None else "", kind="kw"))
        if a.vararg:
            params.append(Param(name="*" + a.vararg.arg, annotation="", default="", kind="varargs"))
        if a.kwarg:
            params.append(Param(name="**" + a.kwarg.arg, annotation="", default="", kind="kwargs"))
        ret = unparse(node.returns)
        text = ", ".join(p.name + (f": {p.annotation}" if p.annotation else "")
                         + (f" = {p.default}" if p.default else "") for p in params)
        return f"{node.name}({text})" + (f" -> {ret}" if ret else ""), params, ret

    def scan(self) -> None:
        self.collect_imports()
        for node in self.tree.body:
            if isinstance(node, ast.ClassDef):
                self._scan_class(node)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._scan_function(node, parent=None, kind="function")

    def _scan_class(self, node: ast.ClassDef) -> None:
        decs = self._decorators(node)
        is_dc = any(d.split("(")[0].endswith("dataclass") for d in decs)
        sid = f"{self.module}.{node.name}"
        sym = Symbol(
            id=sid, name=node.name, qualname=node.name, kind="class", module=self.module,
            file=self.rel, lineno=node.lineno, end_lineno=node.end_lineno or node.lineno,
            decorators=decs, bases=[unparse(b) for b in node.bases],
            docstring=ast.get_docstring(node, clean=True) or "",
            is_dataclass=is_dc,
            loc=(node.end_lineno or node.lineno) - node.lineno + 1,
            imports=self.import_map(),
        )
        for stmt in node.body:
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                default = unparse(stmt.value)
                sym.fields.append(FieldInfo(
                    name=stmt.target.id,
                    annotation=unparse(stmt.annotation),
                    default="" if default.startswith("field()") else default,
                    init="init=False" not in default,
                    origin="annotation",
                    line=stmt.lineno,
                ))
            elif isinstance(stmt, ast.Assign):
                for tgt in stmt.targets:
                    if isinstance(tgt, ast.Name) and tgt.id.isidentifier():
                        sym.fields.append(FieldInfo(
                            name=tgt.id, annotation="", default=unparse(stmt.value),
                            init=not is_dc, origin="class_attr", line=stmt.lineno,
                        ))
        for m in node.body:
            if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._scan_function(m, parent=node.name, kind="method", owner=sym)
        # 把构造期设定的实例属性与不变式汇总到类符号上，数据结构视图按类读取
        for sub_sym in self.symbols:
            if not sub_sym.qualname.startswith(f"{node.name}."):
                continue
            if sub_sym.name not in {"__init__", "__post_init__"}:
                continue
            known = {a["name"] for a in sym.attrs}
            for a in sub_sym.attrs:
                if a["name"] not in known:
                    sym.attrs.append(a)
                    known.add(a["name"])
            sym.asserts.extend(sub_sym.asserts)
        self.symbols.append(sym)

    def _scan_function(self, node, parent: str | None, kind: str, owner: Symbol | None = None) -> None:
        q = f"{parent}.{node.name}" if parent else node.name
        sig, params, ret = self._signature(node)
        decs = self._decorators(node)
        self.return_types[q] = simple_type(ret) or self.return_types.get(q, "")
        sym = Symbol(
            id=f"{self.module}.{q}", name=node.name, qualname=q, kind=kind,
            module=self.module, file=self.rel, lineno=node.lineno,
            end_lineno=node.end_lineno or node.lineno, signature=sig, params=params,
            returns=ret, decorators=decs,
            docstring=ast.get_docstring(node, clean=True) or "",
            is_property=any(d in {"property", "cached_property"} or d.endswith(".setter") for d in decs),
            loc=(node.end_lineno or node.lineno) - node.lineno + 1,
            imports=self.import_map(),
        )
        scope = self.scope_types(node, parent or "")
        for sub in _iter_own_body(node):
            if isinstance(sub, (ast.Assign, ast.AnnAssign)):
                targets = sub.targets if isinstance(sub, ast.Assign) else [sub.target]
                for tgt in targets:
                    d = dotted_name(tgt)
                    if d:
                        sym.assignments.append({
                            "target": d, "method": node.name, "line": sub.lineno,
                            "value": unparse(sub.value)[:100],
                        })
                    if d and d.startswith("self.") and "." not in d.split(".", 1)[1] \
                            and node.name in {"__init__", "__post_init__"}:
                        fname = d.split(".", 1)[1]
                        if fname not in {a["name"] for a in sym.attrs}:
                            ann = simple_type(unparse(sub.annotation)) if isinstance(sub, ast.AnnAssign) else ""
                            t = ann or self.type_of_expr(sub.value, scope, parent or "") \
                                or simple_type(unparse(sub.value))
                            sym.attrs.append({
                                "name": fname, "type": t, "line": sub.lineno,
                                "value": unparse(sub.value)[:100],
                            })
            elif isinstance(sub, ast.Assert):
                sym.asserts.append({
                    "line": sub.lineno, "text": unparse(sub),
                    "message": unparse(sub.msg) if sub.msg else "",
                })
            elif isinstance(sub, ast.Call):
                callee = dotted_name(sub.func) or unparse(sub.func)
                target, conf = self.resolve_callee(sub, scope, parent or "", q)
                cs = CallSite(line=sub.lineno, text=unparse(sub)[:200], callee=callee,
                              target=target, confidence=conf)
                if conf.startswith("external:"):
                    cs.external = conf.split(":", 1)[1]
                sym.calls.append(cs)
        sym.calls.sort(key=lambda c: (c.line, c.callee))
        self.symbols.append(sym)
        if owner is not None:
            owner.methods.append(sym.id)


# ---------------------------------------------------------------- C/CUDA 与 Triton

CSRC_STRUCT_RE = re.compile(r"^\s*(struct|class)\s+([A-Za-z_]\w*)\s*(?::\s*([\w:]+))?\s*\{")
CSRC_FUNC_RE = re.compile(
    r"^\s*(?:template\s*<[^>]*>\s*)?"
    r"(?:(?:__global__|__device__|__host__|static|inline|extern|constexpr)\s+)*"
    r"(?:void|int|float|double|bool|size_t|auto|[A-Za-z_][\w:]*\s*[*&]?)\s+"
    r"([A-Za-z_]\w*)\s*\("
)
CSRC_KEYWORDS = {"if", "for", "while", "switch", "return", "else", "sizeof", "catch", "throw"}


def scan_csrc() -> list[dict]:
    out: list[dict] = []
    if not CSRC_ROOT.exists():
        return out
    for path in sorted(p for p in CSRC_ROOT.rglob("*") if p.is_file()):
        rel = str(path.relative_to(SRC_ROOT))
        for i, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            m = CSRC_STRUCT_RE.match(line)
            if m:
                out.append({"name": m.group(2), "kind": m.group(1), "file": rel, "line": i,
                            "base": m.group(3) or "", "signature": line.strip()[:200],
                            "ext": path.suffix})
                continue
            m = CSRC_FUNC_RE.match(line)
            if m and m.group(1) not in CSRC_KEYWORDS:
                out.append({"name": m.group(1), "kind": "function", "file": rel, "line": i,
                            "base": "", "signature": line.strip()[:200], "ext": path.suffix})
    return out


def scan_triton() -> list[dict]:
    out: list[dict] = []
    if not TRITON_ROOT.exists():
        return out
    idx = Index()
    for path in sorted(TRITON_ROOT.rglob("*.py")):
        fc = FileCollector(path, idx)
        fc.collect_imports()
        idx.add(fc)
        for node in fc.tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                decs = fc._decorators(node)
                sig, params, _ = fc._signature(node)
                out.append({
                    "name": node.name,
                    "kind": "triton_kernel" if any("triton.jit" in d or d == "jit" for d in decs) else "function",
                    "file": fc.rel, "line": node.lineno, "end_line": node.end_lineno or node.lineno,
                    "signature": sig, "decorators": decs,
                    "docstring": ast.get_docstring(node, clean=True) or "",
                    "params": [{"name": p.name, "annotation": p.annotation} for p in params],
                })
    return out


# ---------------------------------------------------------------- 模块元信息

MODULE_INFO = {
    "core": ("全局上下文，以及 Req / Batch / SamplingParams 等核心结构", "core.py"),
    "env": ("环境变量读取与默认值", "env.py"),
    "shell": ("交互式 shell 入口", "shell.py"),
    "attention": ("三种 attention 后端与元数据准备", "attention/"),
    "distributed": ("TP 信息与通信实现切换", "distributed/"),
    "engine": ("模型执行、KV 池、CUDA Graph、采样", "engine/"),
    "kernel": ("Triton 与 CUDA 算子及其加载", "kernel/"),
    "kvcache": ("KV 池与 Radix 前缀缓存", "kvcache/"),
    "layers": ("线性层、归一化、RoPE、词嵌入", "layers/"),
    "llm": ("离线单进程推理入口", "llm/"),
    "message": ("跨进程消息定义与序列化", "message/"),
    "models": ("模型结构与权重加载", "models/"),
    "moe": ("MoE 后端", "moe/"),
    "scheduler": ("调度主循环与资源管理器", "scheduler/"),
    "server": ("HTTP 服务与进程拉起", "server/"),
    "tokenizer": ("分词与增量解码", "tokenizer/"),
    "utils": ("通用工具：ZMQ 队列、日志、注册表", "utils/"),
    "benchmark": ("压测工具与指标统计", "benchmark/"),
}


# ---------------------------------------------------------------- 主流程


def main() -> int:
    index = Index()
    for p in collect_py_files():
        try:
            fc = FileCollector(p, index)
        except SyntaxError as e:
            print(f"跳过无法解析的文件 {p}: {e}", file=sys.stderr)
            continue
        fc.collect_imports()
        fc.collect_returns()
        index.add(fc)
    index.build()
    for fc in index.collectors:
        fc.scan()

    symbols: dict[str, dict] = {}
    edges: dict[tuple[str, str], dict] = {}
    external_counts: dict[str, int] = {}
    file_index: dict[str, dict] = {}

    for fc in index.collectors:
        file_index[fc.rel] = {
            "path": fc.rel, "module": fc.module, "group": module_of_path(fc.rel),
            "loc": len(fc.lines), "symbols": [s.id for s in fc.symbols],
        }
        for s in fc.symbols:
            d = {
                "id": s.id, "name": s.name, "qualname": s.qualname, "kind": s.kind,
                "module": s.module, "group": module_of_path(s.file), "file": s.file,
                "lineno": s.lineno, "end_lineno": s.end_lineno, "signature": s.signature,
                "params": [p.__dict__ for p in s.params], "returns": s.returns,
                "decorators": s.decorators, "bases": s.bases, "docstring": s.docstring,
                "fields": [f.__dict__ for f in s.fields], "methods": sorted(s.methods),
                "assignments": s.assignments, "attrs": s.attrs, "asserts": s.asserts,
                "is_dataclass": s.is_dataclass, "is_property": s.is_property,
                "loc": s.loc, "calls": [], "unresolved": [], "external": [], "module_refs": [],
            }
            seen: set[tuple[int, str]] = set()
            for c in s.calls:
                key = (c.line, c.callee)
                if key in seen:
                    continue
                seen.add(key)
                if c.external:
                    d["external"].append({"line": c.line, "callee": c.callee, "lib": c.external})
                    external_counts[c.external] = external_counts.get(c.external, 0) + 1
                elif c.confidence == "module-ref" and not c.target:
                    d["module_refs"].append({"line": c.line, "callee": c.callee})
                elif c.target:
                    d["calls"].append({"line": c.line, "callee": c.callee, "target": c.target,
                                       "confidence": c.confidence, "text": c.text})
                    ekey = (s.id, c.target)
                    e = edges.setdefault(ekey, {"from": s.id, "to": c.target, "count": 0,
                                                "confidence": c.confidence, "lines": []})
                    e["count"] += 1
                    if len(e["lines"]) < 8:
                        e["lines"].append(c.line)
                    if e["confidence"] != c.confidence:
                        e["confidence"] = "inferred"
                else:
                    d["unresolved"].append({"line": c.line, "callee": c.callee, "text": c.text})
            symbols[s.id] = d

    # 结构体清单：dataclass、NamedTuple，以及有实例属性或类字段的普通类
    datastructs = []
    for sid, s in symbols.items():
        if s["kind"] != "class":
            continue
        is_nt = any("NamedTuple" in b for b in s["bases"])
        plain_fields = [f for f in s["fields"] if f["origin"] == "annotation"]
        interesting = s["is_dataclass"] or is_nt or len(plain_fields) >= 2 or len(s["attrs"]) >= 3
        if not interesting:
            continue
        datastructs.append({
            "id": sid, "name": s["name"], "module": s["module"], "group": s["group"],
            "file": s["file"], "lineno": s["lineno"], "end_lineno": s["end_lineno"],
            "docstring": s["docstring"], "bases": s["bases"],
            "kind": "namedtuple" if is_nt else ("dataclass" if s["is_dataclass"] else "class"),
            "fields": s["fields"], "attrs": s["attrs"], "methods": s["methods"],
            "asserts": s["asserts"], "assignments": s["assignments"],
        })
    datastructs.sort(key=lambda x: (x["group"], x["name"]))

    groups: dict[str, dict] = {}
    for rel, info in file_index.items():
        g = info["group"]
        entry = groups.setdefault(g, {
            "name": g, "files": [], "loc": 0, "other_files": [],
            "description": MODULE_INFO.get(g, ("", ""))[0],
            "path_hint": MODULE_INFO.get(g, ("", ""))[1] or g,
        })
        entry["files"].append(rel)
        entry["loc"] += info["loc"]
    for sub in ("kernel/csrc", "kernel/triton"):
        d = SRC_ROOT / "python" / "minisgl" / sub
        if d.exists():
            groups["kernel"]["other_files"].extend(
                str(p.relative_to(SRC_ROOT)) for p in sorted(d.rglob("*")) if p.is_file()
            )
    for k in groups:
        groups[k]["files"].sort()
        groups[k]["other_files"].sort()

    sources: dict[str, list[str]] = {fc.rel: fc.lines for fc in index.collectors}
    for rel in groups.get("kernel", {}).get("other_files", []):
        sources[rel] = (SRC_ROOT / rel).read_text(encoding="utf-8", errors="replace").splitlines()

    csrc = scan_csrc()
    triton = scan_triton()

    stats = {
        "py_files": len(index.collectors),
        "py_loc": sum(len(fc.lines) for fc in index.collectors),
        "symbols": len(symbols),
        "classes": sum(1 for s in symbols.values() if s["kind"] == "class"),
        "functions": sum(1 for s in symbols.values() if s["kind"] == "function"),
        "methods": sum(1 for s in symbols.values() if s["kind"] == "method"),
        "edges": len(edges),
        "resolved_edges": sum(1 for e in edges.values() if e["confidence"] == "resolved"),
        "inferred_edges": sum(1 for e in edges.values() if e["confidence"] == "inferred"),
        "unresolved_calls": sum(len(s["unresolved"]) for s in symbols.values()),
        "external_calls": sum(external_counts.values()),
        "datastructs": len(datastructs),
        "csrc_symbols": len(csrc),
        "triton_symbols": len(triton),
        "modules": len(groups),
        "external_top": sorted(external_counts.items(), key=lambda kv: -kv[1])[:20],
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    _dump("symbols.json", symbols)
    _dump("edges.json", sorted(edges.values(), key=lambda e: (e["from"], e["to"])))
    _dump("files.json", file_index)
    _dump("modules.json", sorted(groups.values(), key=lambda g: -g["loc"]))
    _dump("datastructs.json", datastructs)
    _dump("sources.json", sources)
    _dump("kernels.json", {"csrc": csrc, "triton": triton})
    _dump("stats.json", stats)

    print(json.dumps(stats, ensure_ascii=False, indent=2))
    return 0


def _dump(name: str, obj) -> None:
    path = OUT_DIR / name
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"写出 {path.relative_to(ROOT)}  {path.stat().st_size / 1024:.0f} KB", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
