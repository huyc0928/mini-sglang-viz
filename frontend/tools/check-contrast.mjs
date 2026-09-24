// 检查主题配色的对比度是否够读。
//
// 亮色主题最容易犯的错是把浅色文字留在浅色底上。这里把 styles.css 里的
// 变量与关键前景色取出来，按 WCAG 的相对亮度公式算对比度，低于阈值就报错。
//
// 用法：npm run check:contrast

import { readFileSync } from "node:fs";

const cssPath = new URL("../src/styles.css", import.meta.url);
const css = readFileSync(cssPath, "utf8");

function vars() {
  const block = /:root\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
  const out = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})/g)) out[m[1]] = m[2];
  return out;
}

function rgb(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
}

/** WCAG 相对亮度 */
function lum(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const V = vars();
const need = (name) => {
  if (!V[name]) throw new Error(`styles.css 里找不到变量 --${name}`);
  return V[name];
};

// 正文阈值 4.5，大字与非正文（图元、强调色）阈值 3
const cases = [
  ["正文/页面底", need("fg"), need("bg"), 4.5],
  ["正文/卡片底", need("fg"), need("bg-1"), 4.5],
  ["次级文字/卡片底", need("fg-dim"), need("bg-1"), 4.5],
  ["弱化文字/卡片底", need("fg-faint"), need("bg-1"), 3.0],
  ["弱化文字/输入框底", need("fg-faint"), need("bg-2"), 3.0],
  ["强调色/卡片底", need("accent"), need("bg-1"), 3.0],
  ["成功色/卡片底", need("accent-2"), need("bg-1"), 3.0],
  ["告警色/卡片底", need("warn"), need("bg-1"), 3.0],
  ["危险色/卡片底", need("danger"), need("bg-1"), 3.0],
  ["接口实现色/卡片底", need("override"), need("bg-1"), 3.0],
  // 图元
  ["静态调用边/卡片底", need("edge-resolved"), need("bg-1"), 2.0],
  ["推断边/卡片底", need("edge-inferred"), need("bg-1"), 3.0],
  ["接口实现边/卡片底", need("edge-override"), need("bg-1"), 3.0],
  ["高亮边/卡片底", need("edge-hl"), need("bg-1"), 3.0],
  ["ZMQ 通道/卡片底", need("k-zmq"), need("bg-1"), 3.0],
  ["HTTP 通道/卡片底", need("k-http"), need("bg-1"), 3.0],
  ["NCCL 通道/卡片底", need("k-nccl"), need("bg-1"), 3.0],
  ["进程内通道/卡片底", need("k-inproc"), need("bg-1"), 3.0],
  ["未归属色/卡片底", need("neutral"), need("bg-1"), 2.0],
  ["节点描边/卡片底", need("node-stroke"), need("bg-1"), 1.5],
  ["边框/卡片底", need("line"), need("bg-1"), 1.2],
];

/** 把 var(--x) 解析成具体颜色，方便对 CSS 规则做检查 */
function resolve(value) {
  const m = /var\(--([\w-]+)\)/.exec(value);
  return m ? need(m[1]) : value;
}

// 代码高亮：从 .tok-* 规则里取色
const tokRules = [...css.matchAll(/\.(tok-[a-z]+)\s*\{\s*\n?\s*color:\s*(#[0-9a-fA-F]{6}|var\(--[\w-]+\))/g)];
for (const [, cls, value] of tokRules) {
  cases.push([`语法高亮 ${cls}/代码底`, resolve(value), need("bg-1"), 4.5]);
}

// 标签（pill）：小号等宽字，按正文阈值要求
const pillRules = [...css.matchAll(/\.pill\.([\w-]+)\s*\{[^}]*?color:\s*(#[0-9a-fA-F]{6}|var\(--[\w-]+\))/g)];
for (const [, cls, value] of pillRules) {
  cases.push([`标签 .pill.${cls}/面板底`, resolve(value), need("bg-2"), 4.5]);
}

let failed = 0;
const rows = [];
for (const [label, fg, bg, min] of cases) {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) failed++;
  rows.push(`${ok ? "通过" : "不足"}  ${r.toFixed(2).padStart(5)}  (需 ≥ ${min})  ${label}  ${fg} on ${bg}`);
}
for (const r of rows) console.log(r);

console.log(`\n共 ${cases.length} 项，${cases.length - failed} 项达标，${failed} 项不足`);
if (failed > 0) {
  console.error("\n对比度不足，需调整 styles.css 里的配色");
  process.exit(1);
}
