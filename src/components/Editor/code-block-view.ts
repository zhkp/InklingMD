import { EditorView, lineNumbers, drawSelection, keymap, highlightActiveLine, highlightSpecialChars } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { LanguageDescription, LanguageSupport, StreamLanguage, bracketMatching, indentOnInput } from "@codemirror/language";
import { indentWithTab } from "@codemirror/commands";
import { codeThemeExt, sharedCodeMirrorBaseTheme as baseTheme } from "../../lib/codemirror-shared";
import type { NodeView } from "@milkdown/kit/prose/view";
import { TextSelection } from "@milkdown/kit/prose/state";
import { exitCode } from "@milkdown/kit/prose/commands";
import { undo, redo } from "@milkdown/kit/prose/history";
import { $view } from "@milkdown/kit/utils";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView as PMView } from "@milkdown/kit/prose/view";
import { createMermaidView } from "./mermaid-view";
import { useSettings, type CodeBlockTheme } from "../../store/settings";

/**
 * 代码块支持的语言列表。
 * 常用语言用独立包（动态 import），其余用 legacy-modes（StreamLanguage）。
 * 未匹配的语言退化为纯文本。
 */
const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({ name: "javascript", alias: ["js", "jsx"], load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }) }),
  LanguageDescription.of({ name: "typescript", alias: ["ts", "tsx"], load: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }) }),
  LanguageDescription.of({ name: "python", alias: ["py"], load: async () => (await import("@codemirror/lang-python")).python() }),
  LanguageDescription.of({ name: "rust", alias: ["rs"], load: async () => (await import("@codemirror/lang-rust")).rust() }),
  LanguageDescription.of({ name: "cpp", alias: ["c", "c++", "h"], load: async () => (await import("@codemirror/lang-cpp")).cpp() }),
  LanguageDescription.of({ name: "java", alias: [], load: async () => (await import("@codemirror/lang-java")).java() }),
  LanguageDescription.of({ name: "html", alias: [], load: async () => (await import("@codemirror/lang-html")).html() }),
  LanguageDescription.of({ name: "css", alias: ["scss"], load: async () => (await import("@codemirror/lang-css")).css() }),
  LanguageDescription.of({ name: "json", alias: [], load: async () => (await import("@codemirror/lang-json")).json() }),
  LanguageDescription.of({ name: "sql", alias: [], load: async () => (await import("@codemirror/lang-sql")).sql() }),
  LanguageDescription.of({ name: "markdown", alias: ["md"], load: async () => (await import("@codemirror/lang-markdown")).markdown() }),
  LanguageDescription.of({ name: "xml", alias: [], load: async () => (await import("@codemirror/lang-xml")).xml() }),
  LanguageDescription.of({ name: "yaml", alias: ["yml"], load: async () => (await import("@codemirror/lang-yaml")).yaml() }),
  // legacy-modes 提供的额外语言
  LanguageDescription.of({ name: "go", alias: ["golang"], load: async () => new LanguageSupport(StreamLanguage.define((await import("@codemirror/legacy-modes/mode/go")).go)) }),
  LanguageDescription.of({ name: "ruby", alias: ["rb"], load: async () => new LanguageSupport(StreamLanguage.define((await import("@codemirror/legacy-modes/mode/ruby")).ruby)) }),
  LanguageDescription.of({ name: "shell", alias: ["sh", "bash"], load: async () => new LanguageSupport(StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell)) }),
  LanguageDescription.of({ name: "dockerfile", alias: [], load: async () => new LanguageSupport(StreamLanguage.define((await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile)) }),
  LanguageDescription.of({ name: "diff", alias: [], load: async () => new LanguageSupport(StreamLanguage.define((await import("@codemirror/legacy-modes/mode/diff")).diff)) }),
  LanguageDescription.of({ name: "toml", alias: [], load: async () => new LanguageSupport(StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml)) }),
];

/** 根据语言名查找并加载 LanguageSupport */
function loadLanguage(name: string): Promise<LanguageSupport | undefined> {
  const lower = name.toLowerCase();
  const desc = codeLanguages.find((l) => l.name === lower || l.alias.includes(lower));
  if (!desc) return Promise.resolve(undefined);
  return desc.load();
}

/**
 * 语言加载器入口。抽成可替换对象是为给测试一个接缝：issue #173 的竞态单测
 * 需要精确控制不同语言的 resolve 顺序（A 迟到于 B），真实动态 import 无法
 * 保证顺序。生产路径恒指向 loadLanguage。
 */
export const codeLanguageLoader = {
  load(name: string): Promise<LanguageSupport | undefined> {
    return loadLanguage(name);
  },
};

/** 计算旧/新文本的最小变更区间，用于精准同步 */
function computeChange(oldVal: string, newVal: string) {
  if (oldVal === newVal) return null;
  let start = 0;
  let oldEnd = oldVal.length;
  let newEnd = newVal.length;
  while (start < oldEnd && oldVal.charCodeAt(start) === newVal.charCodeAt(start)) ++start;
  while (oldEnd > start && newEnd > start && oldVal.charCodeAt(oldEnd - 1) === newVal.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  return { from: start, to: oldEnd, text: newVal.slice(start, newEnd) };
}

/**
 * 代码块的 ProseMirror NodeView：内嵌 CodeMirror 6 编辑器，
 * 提供语法高亮、行号、语言切换，并把编辑同步回 ProseMirror 文档。
 *
 * 性能：CodeMirror 实例延迟到代码块进入视口时才创建（IntersectionObserver），
 * 大量代码块文档下避免一次性初始化上百个编辑器实例。
 */
export class CodeBlockNodeView implements NodeView {
  dom: HTMLElement;
  cm: EditorView | null = null;
  private node: Node;
  private view: PMView;
  private getPos: () => number | undefined;
  private langConf = new Compartment();
  private readOnlyConf = new Compartment();
  private themeConf = new Compartment();
  private updating = false;
  private languageName = "";
  /**
   * 语言加载请求序号（issue #173）：updateLanguage 每次发起新请求自增。
   * resolve 时若序号已不是最新，说明期间又切换过语言，结果过期，直接丢弃。
   */
  private langLoadSeq = 0;
  private currentTheme: CodeBlockTheme;
  private unsub: () => void;
  private io: IntersectionObserver | null = null;
  private cmHost: HTMLElement;
  private select: HTMLSelectElement;
  // 懒挂载占位（v2.3.4）：CodeMirror 创建前用纯文本 <pre> 占位，
  // 与 CM 同字体/行高/最大高度（见 App.css .code-block-placeholder），
  // 挂载前后高度差接近 0——此前挂载前 cmHost 为空（高度≈0），
  // 挂载后撑开数百 px，打开大文档时首屏逐块挂载产生连续布局跳变（窗口抖动）
  private placeholder: HTMLPreElement;

  // ---- #212 懒挂载批次化（静态共享） ----
  // IO 回调常在快速滚动中成批触发（rootMargin 200px 预载窗口一帧内进入
  // 多个代码块），同帧连续 initCodeMirror（每个 10~20ms，trace 实测 6 批
  // 共 119ms）造成 25~75ms 滚动帧尖刺。改为入队 + drainer：滚动进行中
  //（250ms 内有 scroll 事件）让位，停歇后每帧最多挂载 1 个实例，把批量
  // 挂载成本摊到停歇后的多帧（占位 <pre> 等高，视觉无跳变）。
  /** 待挂载队列 */
  private static mountQueue: CodeBlockNodeView[] = [];
  /** 消费循环是否在途（一个循环逐帧消化整个队列） */
  private static drainScheduled = false;
  /** 最近一次滚动时间（document capture 监听，所有滚动容器可见） */
  private static lastScrollAt = 0;
  private static scrollMarkInstalled = false;

  private static ensureScrollMark(): void {
    if (CodeBlockNodeView.scrollMarkInstalled) return;
    CodeBlockNodeView.scrollMarkInstalled = true;
    // scroll 不冒泡但可被捕获：capture 监听接住任意容器的滚动事件
    document.addEventListener(
      "scroll",
      () => {
        CodeBlockNodeView.lastScrollAt = performance.now();
      },
      { passive: true, capture: true },
    );
  }

  /** 启动（或复用在途的）队列消费循环 */
  private static scheduleMountDrain(): void {
    if (CodeBlockNodeView.drainScheduled) return;
    CodeBlockNodeView.drainScheduled = true;
    CodeBlockNodeView.pumpMountQueue();
  }

  private static pumpMountQueue(): void {
    const queue = CodeBlockNodeView.mountQueue;
    if (queue.length === 0) {
      CodeBlockNodeView.drainScheduled = false;
      return;
    }
    // 滚动进行中让位（同 mermaid-view 空闲预渲染的让位策略）
    if (performance.now() - CodeBlockNodeView.lastScrollAt < 250) {
      setTimeout(() => CodeBlockNodeView.pumpMountQueue(), 100);
      return;
    }
    const item = queue.shift();
    // 队列等待期间节点可能已被移除（编辑/切文档）： isConnected 守卫跳过
    if (item && item.dom.isConnected && !item.cm) item.initCodeMirror();
    if (queue.length > 0) {
      requestAnimationFrame(() => CodeBlockNodeView.pumpMountQueue());
    } else {
      CodeBlockNodeView.drainScheduled = false;
    }
  }

  /**
   * @internal 测试接缝：同步清空挂载队列（绕过 rAF/滚动让位调度，也不做
   * isConnected 守卫——单测直接构造 NodeView 时 dom 未经过 PM 挂载流程）。
   * 生产代码不得调用——真实挂载必须走 scheduleMountDrain 的批次调度，
   * 其 isConnected 守卫用于跳过等待期间已被移除的节点。
   */
  static flushMountQueueForTests(): void {
    const queue = CodeBlockNodeView.mountQueue;
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (!item.cm) item.initCodeMirror();
    }
  }

  /** @internal 测试接缝：清空队列并复位调度状态（用例间隔离） */
  static resetMountQueueForTests(): void {
    CodeBlockNodeView.mountQueue.length = 0;
    CodeBlockNodeView.drainScheduled = false;
  }

  constructor(node: Node, view: PMView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.currentTheme = useSettings.getState().codeBlockTheme;

    this.dom = document.createElement("div");
    this.dom.className = "code-block";
    this.dom.dataset.codeTheme = this.currentTheme;

    // 顶部工具栏：语言选择
    const toolbar = document.createElement("div");
    toolbar.className = "code-block-toolbar";
    this.select = this.buildLangSelect(node.attrs.language ?? "");
    this.select.addEventListener("change", () => {
      const pos = getPos();
      if (pos == null) return;
      view.dispatch(view.state.tr.setNodeAttribute(pos, "language", this.select.value));
    });
    toolbar.appendChild(this.select);
    this.dom.appendChild(toolbar);

    // CodeMirror 宿主
    this.cmHost = document.createElement("div");
    this.cmHost.className = "code-block-cm";
    this.dom.appendChild(this.cmHost);

    // 纯文本占位：保证未挂载时高度即接近最终高度
    this.placeholder = document.createElement("pre");
    this.placeholder.className = "code-block-placeholder";
    this.placeholder.textContent = node.textContent;
    this.cmHost.appendChild(this.placeholder);

    // 视口懒挂载：先尝试同步创建（若已在视口或 IO 不可用），
    // 否则注册 IntersectionObserver，进入视口时入队由 drainer 批次挂载。
    if (typeof IntersectionObserver === "undefined") {
      this.initCodeMirror();
    } else {
      this.io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting && !this.cm) {
              this.io?.disconnect();
              this.io = null;
              // #212：只入队不立即挂载，见类头「懒挂载批次化」注释
              CodeBlockNodeView.ensureScrollMark();
              CodeBlockNodeView.mountQueue.push(this);
              CodeBlockNodeView.scheduleMountDrain();
            }
          }
        },
        { rootMargin: "200px" },
      );
      this.io.observe(this.dom);
    }

    // 监听代码块主题切换，实时重配 CodeMirror 主题（实例未创建时仅记录，创建时生效）
    this.unsub = useSettings.subscribe((s) => {
      if (s.codeBlockTheme === this.currentTheme) return;
      this.currentTheme = s.codeBlockTheme;
      this.dom.dataset.codeTheme = s.codeBlockTheme;
      if (this.cm) {
        this.cm.dispatch({
          effects: this.themeConf.reconfigure(codeThemeExt(s.codeBlockTheme)),
        });
      }
    });
  }

  /** 创建 CodeMirror 实例并同步当前节点内容/语言 */
  private initCodeMirror() {
    if (this.cm) return;
    this.cm = new EditorView({
      doc: this.node.textContent,
      extensions: [
        this.themeConf.of(codeThemeExt(this.currentTheme)),
        this.readOnlyConf.of(EditorState.readOnly.of(!this.view.editable)),
        lineNumbers(),
        drawSelection(),
        highlightSpecialChars(),
        highlightActiveLine(),
        bracketMatching(),
        indentOnInput(),
        keymap.of(this.buildKeymap()),
        this.langConf.of([]),
        baseTheme,
        EditorView.updateListener.of((u) => this.forwardUpdate(u)),
      ],
    });
    this.cmHost.appendChild(this.cm.dom);
    // 高度已由 CM 精确接管，移除占位
    this.placeholder.remove();
    this.updateLanguage(this.node.attrs.language ?? "");
  }

  /** 构建语言下拉框 */
  private buildLangSelect(current: string): HTMLSelectElement {
    const select = document.createElement("select");
    select.className = "code-block-lang";
    const options = ["text", ...codeLanguages.map((l) => l.name)];
    for (const name of options) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === (current || "text")) opt.selected = true;
      select.appendChild(opt);
    }
    return select;
  }

  /** CodeMirror 内的快捷键：方向键逃离代码块、撤销重做转发到 ProseMirror */
  private buildKeymap() {
    const view = this.view;
    return [
      { key: "ArrowUp", run: () => this.maybeEscape("line", -1) },
      { key: "ArrowLeft", run: () => this.maybeEscape("char", -1) },
      { key: "ArrowDown", run: () => this.maybeEscape("line", 1) },
      { key: "ArrowRight", run: () => this.maybeEscape("char", 1) },
      {
        key: "Mod-Enter",
        run: () => {
          if (!exitCode(view.state, view.dispatch)) return false;
          view.focus();
          return true;
        },
      },
      { key: "Mod-z", run: () => undo(view.state, view.dispatch) },
      { key: "Shift-Mod-z", run: () => redo(view.state, view.dispatch) },
      { key: "Mod-y", run: () => redo(view.state, view.dispatch) },
      indentWithTab,
    ];
  }

  /** 光标在代码块边界时，逃离到外部 ProseMirror 文档 */
  private maybeEscape(unit: "line" | "char", dir: number): boolean {
    // keymap 仅在 CodeMirror 获焦时触发，此时实例必已创建；防御性判空
    if (!this.cm) return false;
    const { state } = this.cm;
    const main = state.selection.main;
    if (!main.empty) return false;
    let from = main.from;
    let to = main.to;
    if (unit === "line") {
      const line = state.doc.lineAt(main.head);
      from = line.from;
      to = line.to;
    }
    if (dir < 0 ? from > 0 : to < state.doc.length) return false;
    const pos = this.getPos();
    if (pos == null) return false;
    const targetPos = pos + (dir < 0 ? 0 : this.node.nodeSize);
    const selection = TextSelection.near(this.view.state.doc.resolve(targetPos), dir);
    this.view.dispatch(this.view.state.tr.setSelection(selection).scrollIntoView());
    this.view.focus();
    return true;
  }

  /** CodeMirror 变更同步到 ProseMirror */
  private forwardUpdate = (update: ViewUpdate) => {
    if (this.updating || !this.cm || !this.cm.hasFocus) return;
    let offset = (this.getPos() ?? 0) + 1;
    const { main } = update.state.selection;
    const selFrom = offset + main.from;
    const selTo = offset + main.to;
    const pmSel = this.view.state.selection;
    if (update.docChanged || pmSel.from !== selFrom || pmSel.to !== selTo) {
      const tr = this.view.state.tr;
      update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        if (inserted.length) tr.replaceWith(offset + fromA, offset + toA, this.view.state.schema.text(inserted.toString()));
        else tr.delete(offset + fromA, offset + toA);
        offset += toB - fromB - (toA - fromA);
      });
      tr.setSelection(TextSelection.create(tr.doc, selFrom, selTo));
      this.view.dispatch(tr);
    }
  };

  /** 加载并切换语言高亮 */
  private updateLanguage(language: string) {
    if (language === this.languageName) return;
    this.languageName = language;
    const seq = ++this.langLoadSeq;
    codeLanguageLoader.load(language).then((support) => {
      // issue #173：A→B 快速切换时，若 A 的加载晚于 B 完成（动态 import 时序
      // 不确定），这里发现 seq 已过期，不得用 A 的高亮覆盖节点当前标注的 B，
      // 否则高亮语言与节点 language 属性不一致。
      if (seq !== this.langLoadSeq) return;
      // 实例可能尚未创建（视口外），languageName 已更新，创建时会用最新值
      if (this.cm) {
        this.cm.dispatch({ effects: this.langConf.reconfigure(support ? [support] : []) });
      }
    }).catch(console.error);
  }

  /** ProseMirror 节点变更同步到 CodeMirror */
  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    // CodeMirror 未创建（视口外）：同步占位文本保证高度正确，待进入
    // 视口创建时从 node 取最新内容
    if (!this.cm) {
      this.placeholder.textContent = node.textContent;
      return true;
    }
    if (this.updating) return true;
    // 同步语言
    const lang = node.attrs.language ?? "";
    if (lang !== this.languageName) this.updateLanguage(lang);
    // 同步只读状态
    if (this.view.editable === this.cm.state.readOnly) {
      this.cm.dispatch({
        effects: this.readOnlyConf.reconfigure(EditorState.readOnly.of(!this.view.editable)),
      });
    }
    // 同步文本
    const change = computeChange(this.cm.state.doc.toString(), node.textContent);
    if (change) {
      this.updating = true;
      // scrollIntoView:false —— 外部受控更新（大纲跳转/全局替换）不应抢占视口滚动，
      // 仅 CM 持有焦点时才滚动到选区
      this.cm.dispatch({ changes: { from: change.from, to: change.to, insert: change.text }, scrollIntoView: false });
      this.updating = false;
    }
    return true;
  }

  setSelection(anchor: number, head: number) {
    if (!this.cm) return;
    const pos = this.getPos();
    if (pos == null) return;
    // PM 传入的 anchor/head 是文档绝对位置，需减去 code_block 起始位置 +1
    // （+1 是因为 code_block 节点本身占 1 个位置，文本内容从 pos+1 开始）
    // 与 forwardUpdate 的 offset = getPos()+1 严格互逆
    const docLen = this.cm.state.doc.length;
    const localAnchor = Math.max(0, Math.min(anchor - pos - 1, docLen));
    const localHead = Math.max(0, Math.min(head - pos - 1, docLen));
    this.cm.focus();
    this.updating = true;
    this.cm.dispatch({ selection: { anchor: localAnchor, head: localHead } });
    this.updating = false;
  }

  selectNode() {
    if (!this.cm) return;
    this.cm.focus();
    // NodeSelection 选中整个代码块时，清空 CM 内残留的文本选区避免视觉不一致
    this.updating = true;
    this.cm.dispatch({ selection: { anchor: 0, head: 0 } });
    this.updating = false;
  }

  deselectNode() {}

  stopEvent() {
    return true;
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    // #212：从挂载队列移除（视口已进入但尚未被 drainer 消费就被销毁）
    const queue = CodeBlockNodeView.mountQueue;
    const idx = queue.indexOf(this);
    if (idx >= 0) queue.splice(idx, 1);
    this.unsub();
    this.io?.disconnect();
    this.io = null;
    this.cm?.destroy();
    this.cm = null;
  }
}

/**
 * 代码块 NodeView 插件：用 CodeMirror 替换默认渲染。
 * 语言为 mermaid 的代码块走 Mermaid 图表渲染，其余走 CodeMirror 高亮。
 */
export const codeBlockView = $view(codeBlockSchema.node, () => (node, view, getPos) => {
  if (node.attrs.language === "mermaid") {
    return createMermaidView(node, view, getPos);
  }
  return new CodeBlockNodeView(node, view, getPos);
});
