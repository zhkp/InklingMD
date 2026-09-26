// Smart Paste 粘贴路径安全单测（#219「安全」章节）
//
// 粘贴路径是本特性最大的攻击面：接入前 HTML 粘贴是「裸的」。这里分三层锁定：
// 1. sanitizeHTML 粘贴模式：script / on* / javascript: / data:（非图片）/ expression() 全部被拦，
//    含常见混淆写法；相对路径按需求放行
// 2. 渲染模式行为不变（粘贴模式的放宽不能泄漏到 HTML 嵌入渲染路径）
// 3. 端到端：经真实粘贴链路进入文档后，不存在危险链接/图片地址，也不会生成 html 节点
//
// 注意：happy-dom 的 DOMParser 会执行 <script>（真实浏览器不会），所以脚本体一律用无副作用
// 的语句；「脚本不执行」由 E2E（真实 Chromium）断言。

import { afterEach, describe, expect, it } from "vitest";
import { isSafeUrl, sanitizeHTML } from "../../src/components/Editor/html-view";
import { htmlToMarkdown } from "../../src/components/Editor/html-to-markdown";
import { smartPastePlugin } from "../../src/components/Editor/smart-paste";
import { countNodes, createHarness, type Harness } from "../fixtures/smartPasteHarness";

function pasteDom(html: string): HTMLElement {
  const div = document.createElement("div");
  div.appendChild(sanitizeHTML(html, { mode: "paste" }));
  return div;
}

const md = (html: string) => htmlToMarkdown(sanitizeHTML(html, { mode: "paste" }));

describe("sanitizeHTML 粘贴模式：危险内容全部被拦", () => {
  it("script / style / noscript / template 连同内容一起丢弃", () => {
    const dom = pasteDom(
      "<p>正文</p><script>void 'SCRIPT_BODY'</script><style>p{color:red}</style>" +
        "<noscript>NOSCRIPT_BODY</noscript><template><p>TPL</p></template>",
    );
    expect(dom.querySelector("script,style,noscript,template")).toBeNull();
    expect(dom.textContent).toBe("正文");
  });

  it("iframe / object / embed / frame 等嵌入对象丢弃", () => {
    const dom = pasteDom(
      '<iframe title="t">IFRAME</iframe><object data="x.swf">OBJ</object><embed type="x">' +
        '<applet code="x">APPLET</applet><p>留下</p>',
    );
    expect(dom.querySelector("iframe,object,embed,applet")).toBeNull();
    expect(dom.textContent).toBe("留下");
  });

  it("所有 on* 事件处理器属性被移除（含大小写变体）", () => {
    const dom = pasteDom(
      '<p onclick="a()" ONMOUSEOVER="b()" onLoad="c()">x</p><img src="https://a/x.png" onerror="d()">' +
        '<a href="https://a" onfocus="e()">l</a>',
    );
    for (const el of Array.from(dom.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.toLowerCase().startsWith("on"), `${el.tagName} ${attr.name}`).toBe(false);
      }
    }
  });

  it("javascript: / vbscript: 链接与图片地址被移除（含混淆写法）", () => {
    const vectors = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)",
      "java&#x09;script:alert(1)",
      "java&#x0A;script:alert(1)",
      "java&#13;script:alert(1)",
      "&#106;avascript:alert(1)",
      "&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;:alert(1)",
      "\u0001javascript:alert(1)",
      "vbscript:msgbox(1)",
    ];
    for (const v of vectors) {
      const dom = pasteDom(`<a href="${v}">链</a><img src="${v}" alt="图">`);
      expect(dom.querySelector("a")?.hasAttribute("href"), v).toBe(false);
      expect(dom.querySelector("img")?.hasAttribute("src"), v).toBe(false);
    }
  });

  it("data: 只放行图片类型；data:text/html 等被拦", () => {
    const dom = pasteDom(
      '<a href="data:text/html,<script>alert(1)</script>">h</a>' +
        '<img id="bad" src="data:text/html;base64,PHNjcmlwdD4=">' +
        '<img id="ok" src="data:image/png;base64,iVBORw0KGgo=">',
    );
    expect(dom.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(dom.querySelector("#bad")?.hasAttribute("src")).toBe(false);
    expect(dom.querySelector("#ok")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("CSS 注入：expression() / url() / @import / behavior 被拦", () => {
    const dom = pasteDom(
      '<span style="width: expression(alert(1)); color: red">a</span>' +
        '<span style="background: url(javascript:alert(1))">b</span>' +
        '<span style="background: u\\72l(x)">c</span>' +
        '<span style="behavior: url(x.htc); -moz-binding: url(x)">d</span>' +
        '<span style="color: @import \'x\'">e</span>',
    );
    const styles = Array.from(dom.querySelectorAll("span")).map((s) => s.getAttribute("style") ?? "");
    for (const st of styles) expect(st).not.toMatch(/expression|url|import|behavior|binding/i);
    expect(styles[0]).toContain("color: red");
  });

  it("表单控件丢弃；只放行任务列表的 checkbox", () => {
    const dom = pasteDom(
      '<input type="text" value="x"><input type="password"><input type="checkbox" checked>' +
        "<textarea>T</textarea><select><option>O</option></select><button>B</button>",
    );
    const inputs = dom.querySelectorAll("input");
    expect(inputs).toHaveLength(1);
    expect(inputs[0].getAttribute("type")).toBe("checkbox");
    expect(dom.textContent).toBe("");
  });

  it("data-* 属性被移除，无法伪造编辑器内部节点（span[data-type=html]）", () => {
    const dom = pasteDom('<span data-type="html" data-value="&lt;img src=x onerror=alert(1)&gt;">x</span>');
    const span = dom.querySelector("span")!;
    expect(span.hasAttribute("data-type")).toBe(false);
    expect(span.hasAttribute("data-value")).toBe(false);
  });

  it("相对路径链接按需求保留（与 Typora 一致）", () => {
    const dom = pasteDom('<a href="docs/guide.md">g</a><a href="./a b.md">s</a><img src="assets/x.png">');
    expect(Array.from(dom.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual([
      "docs/guide.md",
      "./a b.md",
    ]);
    expect(dom.querySelector("img")?.getAttribute("src")).toBe("assets/x.png");
  });
});

describe("isSafeUrl", () => {
  it("相对路径只在 allowRelative 时放行", () => {
    expect(isSafeUrl("docs/a.md")).toBe(false);
    expect(isSafeUrl("docs/a.md", true)).toBe(true);
    expect(isSafeUrl("../a.png", true)).toBe(true);
  });

  it("allowRelative 也不会把拆开协议头的写法当成相对路径", () => {
    for (const v of ["java\nscript:alert(1)", "java\tscript:x", "\u0000javascript:x", "java script:x"]) {
      expect(isSafeUrl(v, true), JSON.stringify(v)).toBe(false);
    }
  });

  it("未知协议一律拒绝", () => {
    for (const v of ["file:///etc/passwd", "vbscript:x", "chrome://settings", "c:\\windows"]) {
      expect(isSafeUrl(v, true), v).toBe(false);
    }
  });
});

describe("渲染模式（HTML 嵌入）行为不变", () => {
  it("相对路径在渲染模式下仍被拒绝", () => {
    const div = document.createElement("div");
    div.appendChild(sanitizeHTML('<a href="docs/a.md">x</a>'));
    expect(div.querySelector("a")?.hasAttribute("href")).toBe(false);
  });

  it("未知标签在渲染模式下仍连同子节点丢弃", () => {
    const div = document.createElement("div");
    div.appendChild(sanitizeHTML("<section><p>内容</p></section><font>字</font>"));
    expect(div.textContent).toBe("");
  });

  it("两种模式互不污染缓存：先粘贴模式后渲染模式，结果仍是渲染模式语义", () => {
    const html = "<article><p>缓存测试</p></article>";
    const paste = document.createElement("div");
    paste.appendChild(sanitizeHTML(html, { mode: "paste" }));
    expect(paste.textContent).toBe("缓存测试");
    const render = document.createElement("div");
    render.appendChild(sanitizeHTML(html));
    expect(render.textContent).toBe("");
  });
});

describe("结构映射层不引入新的注入面", () => {
  it("文本中的 HTML 标签字面量被转义，不会变成 html 节点", () => {
    expect(md("<p>&lt;img src=x onerror=alert(1)&gt;</p>")).toBe("\\<img src=x onerror=alert(1)>");
  });

  it("链接文字/标题里的 Markdown 语法字符被转义", () => {
    expect(md('<a href="https://a" title="t&quot;) [x](javascript:alert(1)">文](javascript:x)</a>')).toBe(
      '[文\\](javascript:x)](https://a "t\\") [x](javascript:alert(1)")',
    );
  });

  it("地址中的尖括号与换行被编码，无法闭合目标或注入新行", () => {
    expect(md('<a href="https://a/<b>\nc">l</a>')).toBe("[l](https://a/%3Cb%3E%0Ac)");
  });
});

describe("端到端：经真实粘贴链路进入文档", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.destroy();
    h = undefined;
  });

  const collect = (h: Harness) => {
    const hrefs: string[] = [];
    const srcs: string[] = [];
    h.view.state.doc.descendants((n) => {
      if (n.type.name === "image") srcs.push(n.attrs.src);
      for (const m of n.marks) if (m.type.name === "link") hrefs.push(m.attrs.href);
      return true;
    });
    return { hrefs, srcs };
  };

  it("HTML 路径：危险地址、事件属性、伪造的内部节点都进不了文档", async () => {
    h = await createHarness({ plugins: (parse) => [smartPastePlugin({ parseMarkdown: parse })] });
    h.paste({
      "text/html":
        '<p><a href="javascript:alert(1)">js</a> <a href="https://ok.example">ok</a>' +
        '<img src="data:text/html,x" alt="d"><img src="https://img.example/a.png" onerror="x()" alt="i">' +
        '<span data-type="html" data-value="&lt;script&gt;">伪造</span>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
      "text/plain": "x",
    });
    const { hrefs, srcs } = collect(h);
    expect(hrefs).toEqual(["https://ok.example"]);
    expect(srcs).toEqual(["https://img.example/a.png"]);
    expect(countNodes(h.view.state.doc, "html")).toBe(0);
    expect(h.view.state.doc.textContent).toContain("<script>alert(1)</script>");
  });

  it("Markdown 文本路径：javascript: 链接与图片被剥离，data:text 图片被删除", async () => {
    h = await createHarness({ plugins: (parse) => [smartPastePlugin({ parseMarkdown: parse })] });
    h.paste({
      "text/plain":
        "# 标题\n\n[a](javascript:alert(1)) [b](JAVASCRIPT:x) [c](https://ok)\n\n![x](javascript:alert(1)) ![y](data:text/html,x) ![z](https://img/a.png)",
    });
    const { hrefs, srcs } = collect(h);
    expect(hrefs).toEqual(["https://ok"]);
    expect(srcs).toEqual(["https://img/a.png"]);
  });
});
