// 远程图片落盘（Smart Paste，#220）
//
// 网页富文本粘贴后，图片节点先以远程 URL 插入（粘贴即时可见，不被网络阻塞），
// 随后后台下载并写入文档同目录的 assets/，成功后把节点 src 换成相对路径。
//
// - 位置跟踪：待替换节点的位置记在插件 state 里，随每个事务的 mapping 映射；
//   替换前再校验「该位置仍是 src 相同的图片节点」，用户中途删改不会误伤其他内容
// - 撤销语义：src 替换事务不进撤销历史（addToHistory=false），一次粘贴仍是一个撤销步
// - 失败降级：下载失败/超时/超限/403 时保留远程 URL（不产生空引用），汇总后一次性提示
// - SVG 不下载（可含脚本），保持远程引用；未保存草稿没有 assets 目录，同样保持远程引用
// - 去重：写盘走 saveImageAsset，assets/ 里已有相同内容时复用（重复粘贴不产生副本）

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { downloadRemoteImage, mapRemoteImageError, type RemoteImage } from "../../lib/fs";
import { extensionForMime, genAssetName, saveImageAsset } from "../../lib/assetStore";
import { showMessage } from "../../lib/dialogs";
import { isUntitledPath } from "./image-upload";

/** 单次粘贴最多下载的远程图片数（超出部分保留远程引用） */
export const MAX_REMOTE_IMAGES_PER_PASTE = 30;
/** 并发下载数 */
const DOWNLOAD_CONCURRENCY = 3;

export interface RemoteImageDeps {
  documentPath: string;
  /** 以下可注入，便于单测 */
  download?: (url: string) => Promise<RemoteImage>;
  save?: (documentPath: string, data: Uint8Array, fileName: string) => Promise<string>;
  notify?: (message: string) => void;
}

interface PendingImage {
  id: number;
  pos: number;
  src: string;
}

interface RemoteImageState {
  pending: PendingImage[];
}

interface RemoteImageMeta {
  add?: PendingImage[];
  done?: number[];
}

export const remoteImageKey = new PluginKey<RemoteImageState>("inkling-remote-image");

export function isRemoteImageSrc(src: unknown): src is string {
  return typeof src === "string" && /^https?:\/\//i.test(src.trim());
}

/** URL 路径以 .svg 结尾的直接跳过（服务端返回的 SVG 由 Rust 侧再兜底拒绝） */
function isSvgUrl(src: string): boolean {
  try {
    return /\.svgz?$/i.test(new URL(src).pathname);
  } catch {
    return false;
  }
}

/** 收集 [from, to) 范围内的远程图片节点位置 */
export function collectRemoteImages(doc: PMNode, from: number, to: number): { pos: number; src: string }[] {
  const out: { pos: number; src: string }[] = [];
  doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node, pos) => {
    if (node.type.name === "image" && isRemoteImageSrc(node.attrs.src)) {
      out.push({ pos, src: node.attrs.src as string });
    }
    return true;
  });
  return out;
}

function shortUrl(url: string): string {
  return url.length > 80 ? `${url.slice(0, 77)}...` : url;
}

function describeFailure(error: unknown): string {
  const e = mapRemoteImageError(error);
  switch (e.kind) {
    case "forbidden":
      return "站点拒绝下载（HTTP 403，常见于防盗链；InklingMD 按 no-referrer 策略不发送来源页）";
    case "timeout":
      return "下载超时";
    case "too-large":
      return "图片超过 10MB 上限";
    case "not-image":
      return "响应内容不是可识别的图片";
    case "bad-url":
      return "图片地址无效";
    case "http-status":
      return `下载失败（${e.message.replace(/^REMOTE_IMAGE_HTTP_STATUS:\s*/, "")}）`;
    default:
      return "网络错误";
  }
}

class Runner {
  cancelled = false;
  private nextId = 1;

  constructor(
    private readonly view: EditorView,
    private readonly deps: Required<RemoteImageDeps>,
  ) {}

  enqueue(items: { pos: number; src: string }[]): Promise<void> {
    if (this.cancelled || isUntitledPath(this.deps.documentPath)) return Promise.resolve();
    const candidates = items.filter((i) => isRemoteImageSrc(i.src) && !isSvgUrl(i.src));
    const srcs = [...new Set(candidates.map((i) => i.src))].slice(0, MAX_REMOTE_IMAGES_PER_PASTE);
    const accepted = new Set(srcs);
    const add = candidates
      .filter((i) => accepted.has(i.src))
      .map((i) => ({ id: this.nextId++, pos: i.pos, src: i.src }));
    if (add.length === 0) return Promise.resolve();
    this.dispatchMeta({ add });
    return this.run(srcs);
  }

  private dispatchMeta(meta: RemoteImageMeta) {
    const tr = this.view.state.tr.setMeta(remoteImageKey, meta).setMeta("addToHistory", false);
    this.view.dispatch(tr);
  }

  private async run(srcs: string[]): Promise<void> {
    const failures: { src: string; reason: string }[] = [];
    const queue = [...srcs];
    const worker = async () => {
      for (let src = queue.shift(); src !== undefined; src = queue.shift()) {
        let image: RemoteImage;
        try {
          image = await this.deps.download(src);
        } catch (error) {
          this.replace(src, null);
          // SVG 是设计上的「不下载」，不算失败
          if (mapRemoteImageError(error).kind !== "svg") {
            failures.push({ src, reason: describeFailure(error) });
          }
          continue;
        }
        if (this.cancelled) return;
        try {
          const rel = await this.deps.save(
            this.deps.documentPath,
            image.data,
            genAssetName(extensionForMime(image.mime)),
          );
          this.replace(src, rel);
        } catch (error) {
          this.replace(src, null);
          const reason = error instanceof Error ? error.message : String(error);
          failures.push({ src, reason: `保存到 assets/ 失败（${reason}）` });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, srcs.length) }, worker));
    if (failures.length > 0 && !this.cancelled) {
      const lines = failures.map((f) => `• ${shortUrl(f.src)}：${f.reason}`).join("\n");
      this.deps.notify(
        `${failures.length} 张远程图片未能保存到本地 assets/，已保留远程链接：\n${lines}`,
      );
    }
  }

  /** 把仍指向 src 的待替换节点改为本地相对路径；rel 为 null 表示放弃（保留远程 URL） */
  private replace(src: string, rel: string | null) {
    if (this.cancelled || this.view.isDestroyed) return;
    const state = remoteImageKey.getState(this.view.state);
    const targets = state?.pending.filter((p) => p.src === src) ?? [];
    if (targets.length === 0) return;
    const tr = this.view.state.tr;
    if (rel) {
      for (const t of targets) {
        const node = tr.doc.nodeAt(t.pos);
        if (node?.type.name === "image" && node.attrs.src === src) {
          tr.setNodeMarkup(t.pos, undefined, { ...node.attrs, src: rel });
        }
      }
    }
    tr.setMeta(remoteImageKey, { done: targets.map((t) => t.id) } satisfies RemoteImageMeta);
    tr.setMeta("addToHistory", false);
    this.view.dispatch(tr);
  }
}

const runners = new WeakMap<EditorView, Runner>();

/**
 * 把粘贴插入的远程图片交给后台落盘。编辑器未装配 remoteImagePlugin 时静默忽略。
 * 返回的 Promise 在本批全部处理完（成功或降级）后 resolve，供测试等待。
 */
export function queueRemoteImages(
  view: EditorView,
  items: { pos: number; src: string }[],
): Promise<void> {
  return runners.get(view)?.enqueue(items) ?? Promise.resolve();
}

export const remoteImagePlugin = (deps: RemoteImageDeps) => {
  const resolved: Required<RemoteImageDeps> = {
    documentPath: deps.documentPath,
    download: deps.download ?? downloadRemoteImage,
    save: deps.save ?? saveImageAsset,
    notify: deps.notify ?? ((message) => void showMessage(message, { kind: "warning" })),
  };
  return new Plugin<RemoteImageState>({
    key: remoteImageKey,
    state: {
      init: () => ({ pending: [] }),
      apply: (tr, prev) => {
        let pending = prev.pending;
        if (tr.docChanged && pending.length > 0) {
          pending = pending.flatMap((p) => {
            const r = tr.mapping.mapResult(p.pos, 1);
            return r.deleted ? [] : [{ ...p, pos: r.pos }];
          });
        }
        const meta = tr.getMeta(remoteImageKey) as RemoteImageMeta | undefined;
        if (meta?.add) pending = [...pending, ...meta.add];
        if (meta?.done) {
          const done = new Set(meta.done);
          pending = pending.filter((p) => !done.has(p.id));
        }
        return pending === prev.pending ? prev : { pending };
      },
    },
    view: (view) => {
      const runner = new Runner(view, resolved);
      runners.set(view, runner);
      return {
        destroy: () => {
          runner.cancelled = true;
          runners.delete(view);
        },
      };
    },
  });
};
