// 符号的一句话功能描述。整份表一次取回（约二十万个字符的十分之一量级），
// 之后按 id 查表，避免每显示一个节点就请求一次。

import { api } from "../api";

let table: Record<string, string> | null = null;
let pending: Promise<Record<string, string>> | null = null;

/** 取回描述表；同一页面生命周期内只请求一次 */
export async function loadDescriptions(): Promise<Record<string, string>> {
  if (table) return table;
  pending ??= api.descriptions().then((d) => {
    table = d;
    return d;
  });
  try {
    return await pending;
  } catch {
    // 拿不到就退化：视图会改用类型与模块显示
    table = {};
    return table;
  }
}

/** 同步查询。没加载过或没有该符号时返回空串。 */
export function describe(id: string | undefined): string {
  if (!id || !table) return "";
  return table[id] ?? "";
}

/** 按显示宽度截断：汉字算一个单位，拉丁词折算半个单位 */
export function trimDesc(text: string, max: number): string {
  if (!text) return "";
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = /[\u4e00-\u9fff]/.test(ch) ? 1 : /[A-Za-z0-9_]/.test(ch) ? 0.55 : 0.3;
    if (width + w > max) return `${out}…`;
    width += w;
    out += ch;
  }
  return out;
}
