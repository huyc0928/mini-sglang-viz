// 视图公共小工具：标题栏。

import { el } from "./dom";

/** 在视图根节点前插入标题栏（外壳只生成 .view-body） */
export function mountHead(root: HTMLElement, title: string, subtitle: string): HTMLElement {
  const head = el("div", { class: "view-head" }, el("h1", { text: title }), el("p", { text: subtitle }));
  const parent = root.parentElement;
  if (parent) parent.insertBefore(head, root);
  else root.append(head);
  return head;
}
