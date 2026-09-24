// 视图契约。每个视图导出一个实现该接口的对象，由 main.ts 挂载。

export interface ViewContext {
  /** 视图内容根节点，已带 .view-body 或 .view 结构 */
  root: HTMLElement;
  /** 路由参数，例如 #/source?file=...&line=28 */
  params: URLSearchParams;
  /** 切换视图，route 形如 "source?file=python/minisgl/core.py&line=28" */
  navigate(route: string): void;
  /** 生成跳到源码视图的链接串 */
  sourceRoute(file: string, line?: number): string;
  /** 生成跳到调用链视图的链接串 */
  graphRoute(symbolId: string, depth?: number): string;
}

export interface View {
  id: string;
  /** 导航里显示的名字 */
  title: string;
  /** 一句话说明这个视图能做什么 */
  subtitle: string;
  render(ctx: ViewContext): Promise<void> | void;
  destroy?(): void;
}
