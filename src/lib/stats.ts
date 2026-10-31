// 字数统计工具
// 中文按字计，英文按词计，混合时取中文数 + 英文词数

import { perfProbeEnd, perfProbeStart } from "./perf-probe";

export interface DocStats {
  /** 字数（中文按字，英文按词，数字串算一个词） */
  words: number;
  /** 字符数（含空格和换行） */
  chars: number;
  /** 行数 */
  lines: number;
  /** 预计阅读时长（分钟） */
  readingMinutes: number;
}

const WORDS_PER_MINUTE = 300; // 中文阅读速度，约 300 字/分钟

/** 统计 Markdown 文本的字数等信息 */
export function countStats(text: string): DocStats {
  const probeStart = perfProbeStart();
  if (!text) {
    perfProbeEnd("stats", probeStart);
    return { words: 0, chars: 0, lines: 0, readingMinutes: 0 };
  }

  const chars = text.length;
  const lines = text.split("\n").length;

  // 提取中文字符数
  const cjkMatches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // 去掉中文字符后，按空白分词统计英文/数字词数
  const nonCjk = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, " ");
  const enWords = nonCjk
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const words = cjkCount + enWords.length;
  const readingMinutes = words > 0 ? Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)) : 0;

  perfProbeEnd("stats", probeStart);
  return { words, chars, lines, readingMinutes };
}
