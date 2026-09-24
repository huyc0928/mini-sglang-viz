// 轻量语法高亮与源码块渲染。仅覆盖阅读所需的 token 类别，不做完整解析。

import type { SourceLine } from "../types";
import { el } from "./dom";

export type Lang = "python" | "c" | "text";

/** 按扩展名选择高亮语言 */
export function langFor(path: string): Lang {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (ext === ".py" || ext === ".pyi") return "python";
  if ([".cu", ".cpp", ".cc", ".c", ".h", ".cuh", ".hpp"].includes(ext)) return "c";
  return "text";
}

export interface Tok {
  text: string;
  cls?: string;
}

const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
  "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return",
  "try", "while", "with", "yield", "match", "case",
]);

const PY_BUILTINS = new Set([
  "abs", "all", "any", "bool", "bytes", "callable", "dict", "enumerate", "filter", "float",
  "format", "frozenset", "getattr", "hasattr", "hash", "int", "isinstance", "issubclass",
  "iter", "len", "list", "map", "max", "min", "next", "object", "open", "ord", "print",
  "property", "range", "repr", "reversed", "round", "set", "setattr", "slice", "sorted",
  "staticmethod", "classmethod", "str", "sum", "super", "tuple", "type", "zip", "self",
  "NotImplementedError", "RuntimeError", "ValueError", "AssertionError", "Exception", "TypeError",
]);

const C_KEYWORDS = new Set([
  "alignas", "auto", "bool", "break", "case", "catch", "char", "class", "const", "constexpr",
  "continue", "default", "delete", "do", "double", "else", "enum", "explicit", "extern",
  "false", "float", "for", "friend", "goto", "if", "inline", "int", "long", "mutable",
  "namespace", "new", "noexcept", "nullptr", "operator", "private", "protected", "public",
  "return", "short", "signed", "sizeof", "static", "struct", "switch", "template", "this",
  "throw", "true", "try", "typedef", "typename", "union", "unsigned", "using", "virtual",
  "void", "volatile", "while", "nullptr_t", "size_t", "uint32_t", "uint64_t", "int32_t", "int64_t",
]);

const C_BUILTINS = new Set([
  "printf", "memcpy", "memset", "malloc", "free", "min", "max", "assert", "static_assert",
  "atomicAdd", "threadIdx", "blockIdx", "blockDim", "gridDim", "__syncthreads", "__shfl_sync",
]);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}
function isIdent(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/** 逐行高亮器。三引号字符串与 C 块注释需要跨行状态，因此保留实例。 */
export class Highlighter {
  private inTriple: string | null = null;
  private inBlockComment = false;
  constructor(private lang: Lang) {}

  line(text: string): Tok[] {
    if (this.lang === "python") return this.pyLine(text);
    if (this.lang === "c") return this.cLine(text);
    return [{ text }];
  }

  private pyLine(text: string): Tok[] {
    const toks: Tok[] = [];
    let i = 0;
    const push = (t: string, cls?: string): void => {
      if (t) toks.push(cls ? { text: t, cls } : { text: t });
    };
    if (this.inTriple) {
      const end = text.indexOf(this.inTriple);
      if (end < 0) {
        push(text, "tok-str");
        return toks;
      }
      push(text.slice(0, end + 3), "tok-str");
      this.inTriple = null;
      i = end + 3;
    }
    let afterDef = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "#") {
        push(text.slice(i), "tok-com");
        break;
      }
      // 字符串（含前缀 r/b/f/u）
      const strM = /^[rRbBuUfF]{0,3}("""|'''|"|')/.exec(text.slice(i));
      if (strM) {
        const prefix = strM[0];
        const quote = strM[1];
        const start = i;
        i += prefix.length;
        if (quote.length === 3) {
          const end = text.indexOf(quote, i);
          if (end < 0) {
            this.inTriple = quote;
            push(text.slice(start), "tok-str");
            break;
          }
          i = end + 3;
          push(text.slice(start, i), "tok-str");
        } else {
          i += quote.length;
          while (i < text.length && text[i] !== quote) {
            if (text[i] === "\\") i++;
            i++;
          }
          if (i < text.length) i++;
          push(text.slice(start, i), "tok-str");
        }
        continue;
      }
      if (ch === "@" && /^\s*$/.test(text.slice(0, i))) {
        let j = i + 1;
        while (j < text.length && (isIdent(text[j]) || text[j] === ".")) j++;
        push(text.slice(i, j), "tok-dec");
        i = j;
        continue;
      }
      if (isIdentStart(ch)) {
        let j = i;
        while (j < text.length && isIdent(text[j])) j++;
        const word = text.slice(i, j);
        if (PY_KEYWORDS.has(word)) {
          push(word, "tok-kw");
          afterDef = word === "def" || word === "class";
        } else if (afterDef) {
          push(word, "tok-def");
          afterDef = false;
        } else if (PY_BUILTINS.has(word)) {
          push(word, "tok-builtin");
        } else {
          push(word);
        }
        i = j;
        continue;
      }
      if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
        let j = i;
        while (j < text.length && /[0-9a-fA-FxXoObBeEjJ._]/.test(text[j])) j++;
        push(text.slice(i, j), "tok-num");
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < text.length && !isIdentStart(text[j]) && !/[0-9]/.test(text[j]) && text[j] !== "#" && text[j] !== "@" && !/["']/.test(text[j])) j++;
      push(text.slice(i, j));
      i = j;
    }
    return toks;
  }

  private cLine(text: string): Tok[] {
    const toks: Tok[] = [];
    const push = (t: string, cls?: string): void => {
      if (t) toks.push(cls ? { text: t, cls } : { text: t });
    };
    let i = 0;
    if (this.inBlockComment) {
      const end = text.indexOf("*/");
      if (end < 0) {
        push(text, "tok-com");
        return toks;
      }
      push(text.slice(0, end + 2), "tok-com");
      this.inBlockComment = false;
      i = end + 2;
    }
    if (/^\s*#/.test(text)) {
      push(text.trimEnd(), "tok-dec");
      return toks;
    }
    while (i < text.length) {
      const ch = text[i];
      if (text.startsWith("//", i)) {
        push(text.slice(i), "tok-com");
        break;
      }
      if (text.startsWith("/*", i)) {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) {
          this.inBlockComment = true;
          push(text.slice(i), "tok-com");
          break;
        }
        push(text.slice(i, end + 2), "tok-com");
        i = end + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const start = i;
        i++;
        while (i < text.length && text[i] !== ch) {
          if (text[i] === "\\") i++;
          i++;
        }
        if (i < text.length) i++;
        push(text.slice(start, i), "tok-str");
        continue;
      }
      if (isIdentStart(ch)) {
        let j = i;
        while (j < text.length && isIdent(text[j])) j++;
        const word = text.slice(i, j);
        if (C_KEYWORDS.has(word)) push(word, "tok-kw");
        else if (C_BUILTINS.has(word)) push(word, "tok-builtin");
        else push(word);
        i = j;
        continue;
      }
      if (/[0-9]/.test(ch)) {
        let j = i;
        while (j < text.length && /[0-9a-fA-FxX._uUlL]/.test(text[j])) j++;
        push(text.slice(i, j), "tok-num");
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < text.length && !isIdentStart(text[j]) && !/[0-9]/.test(text[j]) && !"/\"'".includes(text[j])) j++;
      push(text.slice(i, j));
      i = j;
    }
    return toks;
  }
}

export interface SourceBlockOptions {
  /** 需要强调的行号闭区间 */
  highlight?: [number, number][];
  /** 点击行号的回调；给出则行号可点 */
  onLineClick?: (n: number) => void;
  /** 滚动到该行并加 .hit */
  focusLine?: number;
}

/** 渲染一段带行号与高亮的源码 */
export function sourceBlock(lines: SourceLine[], path: string, opts: SourceBlockOptions = {}): HTMLElement {
  const hl = new Highlighter(langFor(path));
  const box = el("div", { class: "src" });
  for (const ln of lines) {
    const toks = hl.line(ln.text);
    const textNode = el("span", { class: "text" });
    for (const t of toks) textNode.append(t.cls ? el("span", { class: t.cls, text: t.text }) : document.createTextNode(t.text));
    const gutter = el("span", {
      class: "gutter",
      text: String(ln.n),
      onclick: opts.onLineClick ? () => opts.onLineClick?.(ln.n) : undefined,
    });
    const row = el("div", { class: "ln" }, gutter, textNode);
    if (opts.highlight?.some(([a, b]) => ln.n >= a && ln.n <= b)) row.classList.add("hit");
    if (opts.focusLine === ln.n) {
      row.classList.add("hit");
      row.dataset.focus = "1";
    }
    box.append(row);
  }
  return box;
}
