// 简单分层布局工具。

export interface Pt {
  x: number;
  y: number;
}

/**
 * 分层网格布局：按层从左到右，层内自上而下均匀铺开并垂直居中。
 * layers[i] 是第 i 层的节点 id 列表（已排好序）。
 */
export function layerLayout(
  layers: string[][],
  nodeW: number,
  nodeH: number,
  gapX: number,
  gapY: number,
): Map<string, Pt> {
  const pos = new Map<string, Pt>();
  const maxRows = layers.reduce((m, l) => Math.max(m, l.length), 0);
  const pitchY = nodeH + gapY;
  layers.forEach((layer, li) => {
    const offset = ((maxRows - layer.length) * pitchY) / 2;
    layer.forEach((id, ri) => {
      pos.set(id, { x: li * (nodeW + gapX), y: offset + ri * pitchY });
    });
  });
  return pos;
}

/** 计算一组节点的包围盒（用于 fit） */
export function boundsOf(pts: Iterable<Pt>, nodeW: number, nodeH: number): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + nodeW);
    maxY = Math.max(maxY, p.y + nodeH);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: nodeW, h: nodeH };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 稳定排序：先按 group 再按 name */
export function byGroupThenName<T extends { group?: string; name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.group ?? "").localeCompare(b.group ?? "") || a.name.localeCompare(b.name));
}
