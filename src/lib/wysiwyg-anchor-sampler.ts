// WYSIWYG 切换源码模式的「事前锚点采样」注册表（issue #212）
//
// 背景：#136（PR #139）为模式切换滚动恢复引入了滚动监听持续缓存视口顶部
// 内容锚点（cacheTopPos）——因为切换 effect 运行时 .md-editor-wysiwyg 已
// display:none，posAtCoords/scrollHeight 现场读被钳 0 不可靠。但「每滚动帧
// 采样」在大文档上是性能灾难：posAtCoords 内部 elementFromPoint 在懒挂载
// 持续脏化布局时每帧强制同步重排整篇文档（实测单次 6~7ms、完全脏化 32ms，
// 120Hz 帧预算 8.33ms），万行复杂文档滚动掉帧至 ~60fps（#212）。
//
// 解法：采样时机前移——在「切换指令触发时」（setTabSourceMode 翻转
// sourceMode 之前、编辑器仍可见）同步采样一次，此刻所有几何现场读都可靠。
// 切换由 click/keydown 离散事件触发，React 18 对离散事件同步 flush 渲染：
// 采样（store action 内）与消费（切换 layoutEffect）之间只隔一次同步渲染，
// 滚动事件（连续事件）无法插入其间，锚点在消费时刻必然新鲜——这是 #139
// B1「切换前同步 flush」语义的强化版（采样点直接贴到消费点）。
//
// 与滚动路径每帧采样（#139 引入）相比：
// - 准确性：消费时刻现场采样 ≥ 最后一次滚动帧采样的缓存值（不存在滞后一帧）
// - 性能：滚动路径零几何读取，不再逐帧强制布局
// - 这不是「debounce 降频采样」：滚动路径本来就不采样了，采样发生在消费
//   时刻本身（#212 质量红线禁止的是降频导致缓存陈旧——本方案的锚点在
//   消费时刻必然新鲜，不存在陈旧窗口）
//
// 注册表模式与 lib/source-mode-scroll.ts 同构：编辑器实例按 filePath 注册
// 采样器，store 的 setTabSourceMode 在进入源码方向前调用。

/** 每个文档路径一个采样器：同步读取当前视口锚点并写入编辑器侧缓存 ref */
export type WysiwygAnchorSampler = () => void;

const registry = new Map<string, WysiwygAnchorSampler>();

/** 注册指定文档的 WYSIWYG 锚点采样器（编辑器实例挂载/滚动容器就绪时） */
export function registerWysiwygAnchorSampler(
  filePath: string,
  sampler: WysiwygAnchorSampler,
): void {
  registry.set(filePath, sampler);
}

/** 取消注册（编辑器实例卸载时，防止泄漏与对旧实例的误采样） */
export function unregisterWysiwygAnchorSampler(filePath: string): void {
  registry.delete(filePath);
}

/**
 * 执行指定文档的锚点采样（setTabSourceMode 进入源码方向、翻转状态前调用）。
 * 未注册（编辑器尚未就绪/已卸载）时静默跳过，切换路径回退到缓存旧值。
 */
export function runWysiwygAnchorSampler(filePath: string): void {
  const sampler = registry.get(filePath);
  if (!sampler) return;
  try {
    sampler();
  } catch {
    // 采样失败（极端几何异常）不阻断模式切换：消费端回退缓存旧值/兜底映射
  }
}
