// 换行风格检测与还原（issue #368）
//
// 背景：编辑器内部统一用 LF 表示（Milkdown/remark 序列化与 CodeMirror 均把
// CRLF 归一为 \n），而 read_text_file 原样返回磁盘字节。若保存时直接写序列化
// 结果，CRLF 文件首次编辑保存就会被整体改写为 LF，产生整文件 diff。
//
// 方案：读取时检测主导换行风格存入 tab 元数据；保存写盘前把 LF 序列化结果
// 按原风格还原。转换只动换行符，不触碰正文、空白与编码。
//
// 混合换行的取舍：内部表示已经丢失逐行换行信息，无法逐行保真；按主导风格
// 整体归一是现有结构下可论证的最优解（与主流编辑器「detect dominant EOL」
// 策略一致）。检测时记录 mixed 标记，保存时 console.warn 告知用户。
//
// 文件末尾换行：序列化器恒以 \n 结尾，原文件若缺末尾换行，保存会补上——
// 这是修复前即存在的既有行为（LF 文件同样如此）。保存侧强删末尾换行会吞掉
// 源码模式用户刚输入的真实内容（数据损坏），风险大于收益，故不做强制，
// 保持既有语义不变。

/** 磁盘文件的换行风格 */
export type EolStyle = "crlf" | "lf";

/** 换行检测元数据 */
export interface EolMetadata {
  /**
   * 主导换行风格；文件不含任何换行符时为 null（无从判定，
   * 保存时不做转换）
   */
  eol: EolStyle | null;
  /** 原文件同时存在多种换行风格（CRLF / LF / 孤立 CR 至少两种） */
  mixed: boolean;
}

/**
 * 检测内容的换行风格
 *
 * - `\r\n` 计为 crlf；孤立 `\n` 计为 lf；孤立 `\r`（经典 Mac）并入 lf 侧
 *   （编辑器解析时同样把它归一为 \n，无法单独保真）；
 * - 主导风格按数量取多者，持平（如 1×CRLF + 1×LF）时取 crlf——两种选择
 *   都会改写一半行，取 crlf 只是为了确定性，无平台倾向；
 * - 无任何换行符 → eol 为 null。
 */
export function detectEol(content: string): EolMetadata {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    if (ch === 10) {
      // \n
      if (i > 0 && content.charCodeAt(i - 1) === 13) crlf++;
      else lf++;
    } else if (ch === 13 && (i + 1 >= content.length || content.charCodeAt(i + 1) !== 10)) {
      // 不属于 \r\n 的孤立 \r
      cr++;
    }
  }
  const lfTotal = lf + cr;
  if (crlf === 0 && lfTotal === 0) return { eol: null, mixed: false };
  return {
    eol: crlf >= lfTotal ? "crlf" : "lf",
    mixed: (crlf > 0 && lf > 0) || (crlf > 0 && cr > 0) || (lf > 0 && cr > 0),
  };
}

/**
 * 把内容的目标换行风格还原（保存写盘前调用）
 *
 * 先归一到 LF（防御性处理编辑器输出之外残留的 \r\n / 孤立 \r，
 * 如 reloadFile 后未经编辑器往返的原始内容），再按目标风格转换。
 * eol 为 null（原文件无换行符 / 新建文件）时原样返回。
 */
export function applyEol(content: string, eol: EolStyle | null): string {
  if (eol === null) return content;
  const lf = content.replace(/\r\n?/g, "\n");
  if (eol === "lf") return lf;
  return lf.replace(/\n/g, "\r\n");
}
