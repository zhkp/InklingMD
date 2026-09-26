// HTML → Markdown 结构转换单测（Smart Paste，#219）
//
// 覆盖 #219「支持范围」逐项 + 「降级规则」逐条 + 清理规则。
// 输入一律先走 sanitizeHTML(..., { mode: "paste" })——与生产链路一致，
// 结构映射只见得到清洗后的 DOM。
// 断言用 Markdown 文本全等：中间态是纯文本，这是成本最低、最可读的断言面。
// 「解析后结构是否正确」由 smart-paste-roundtrip.test.ts 用真实 Milkdown 解析器兜底。

import { describe, expect, it } from "vitest";
import { sanitizeHTML } from "../../src/components/Editor/html-view";
import { htmlToMarkdown, MAX_LIST_DEPTH } from "../../src/components/Editor/html-to-markdown";

const md = (html: string) => htmlToMarkdown(sanitizeHTML(html, { mode: "paste" }));

describe("htmlToMarkdown：段落与换行", () => {
  it("段落之间空一行", () => {
    expect(md("<p>第一段</p><p>第二段</p>")).toBe("第一段\n\n第二段");
  });

  it("单个 <br> 为硬换行（反斜杠换行），连续 <br><br> 为段落分隔", () => {
    expect(md("<p>行一<br>行二</p>")).toBe("行一\\\n行二");
    expect(md("<div>段一<br><br>段二</div>")).toBe("段一\n\n段二");
  });

  it("首尾多余的 <br> 与空段落被丢弃（Word 的 <p>&nbsp;</p>）", () => {
    expect(md("<p><br>正文<br></p><p>&nbsp;</p>")).toBe("正文");
  });

  it("HTML 空白按渲染语义折叠，&nbsp; 归一为普通空格", () => {
    expect(md("<p>  a \n\t b&nbsp;&nbsp;c  </p>")).toBe("a b c");
  });

  it("div 内行内内容与块级内容混排时各自成段", () => {
    expect(md("<div>前言<p>中段</p>后记</div>")).toBe("前言\n\n中段\n\n后记");
  });
});

describe("htmlToMarkdown：标题", () => {
  it("H1-H6 映射为对应级别的 ATX 标题", () => {
    const html = [1, 2, 3, 4, 5, 6].map((n) => `<h${n}>标题${n}</h${n}>`).join("");
    expect(md(html)).toBe(
      ["# 标题1", "## 标题2", "### 标题3", "#### 标题4", "##### 标题5", "###### 标题6"].join("\n\n"),
    );
  });

  it("标题内的 <br> 变空格（ATX 标题不能跨行）", () => {
    expect(md("<h2>上半<br>下半</h2>")).toBe("## 上半 下半");
  });

  it("GitHub 标题旁无文字的 permalink 锚点被丢弃", () => {
    const html =
      '<div class="markdown-heading"><h2 class="heading-element">Install</h2>' +
      '<a id="user-content-install" class="anchor" aria-label="Permalink" href="#install">' +
      '<svg class="octicon" viewBox="0 0 16 16"><path d="M0 0"></path></svg></a></div>';
    expect(md(html)).toBe("## Install");
  });

  it("空标题不输出", () => {
    expect(md("<h1> </h1><p>x</p>")).toBe("x");
  });
});

describe("htmlToMarkdown：行内格式", () => {
  it("粗体 / 斜体 / 删除线 / 行内代码", () => {
    expect(md("<p><strong>粗</strong> <b>粗2</b> <em>斜</em> <i>斜2</i> <del>删</del> <s>删2</s> <code>code</code></p>")).toBe(
      "**粗** **粗2** *斜* *斜2* ~~删~~ ~~删2~~ `code`",
    );
  });

  it("span 内联样式表达的格式（Google Docs / Word）", () => {
    expect(
      md(
        '<p><span style="font-weight:700">粗</span> <span style="font-style:italic">斜</span> ' +
          '<span style="text-decoration:line-through">删</span></p>',
      ),
    ).toBe("**粗** *斜* ~~删~~");
  });

  it("Google Docs 的 <b style=\"font-weight:normal\"> 包裹层不产生粗体", () => {
    expect(md('<b style="font-weight:normal" id="docs-internal-guid-1"><p>普通</p></b>')).toBe("普通");
  });

  it("强调首尾空白移到定界符外（`** x**` 不是合法强调）", () => {
    expect(md("<p>a<b> 粗 </b>b</p>")).toBe("a **粗** b");
  });

  it("相邻同类强调合并，避免 `**a****b**` 无法配对", () => {
    expect(md("<p><b>a</b><b>b</b></p>")).toBe("**ab**");
  });

  it("嵌套同类强调不重复包裹", () => {
    expect(md("<p><b>外<strong>内</strong></b></p>")).toBe("**外内**");
  });

  it("中文标点结尾的粗体后接文字：编码外侧字符以满足 flanking 规则", () => {
    // `**注意：**这是` 的收尾 ** 前是标点、后是文字，不构成 right-flanking
    expect(md("<p><strong>注意：</strong>这是</p>")).toBe("**注意：**&#x8FD9;是");
    // 开定界符同理：前是文字、后是标点
    expect(md("<p>见<strong>「附录」</strong></p>")).toBe("&#x89C1;**「附录」**");
  });

  it("行内代码按内容里最长反引号串选择围栏长度", () => {
    expect(md("<p><code>a`b</code></p>")).toBe("``a`b``");
    expect(md("<p><code>`x</code></p>")).toBe("`` `x ``");
  });

  it("kbd / samp 按行内代码输出", () => {
    expect(md("<p>按 <kbd>Ctrl</kbd> 键</p>")).toBe("按 `Ctrl` 键");
  });

  it("sub/sup/mark/u 等无 Markdown 语义的标签保留文字", () => {
    expect(md("<p>H<sub>2</sub>O x<sup>2</sup> <mark>高亮</mark> <u>下划线</u></p>")).toBe("H2O x2 高亮 下划线");
  });
});

describe("htmlToMarkdown：链接与图片", () => {
  it("链接保留 href 与 title", () => {
    expect(md('<p><a href="https://a.com/x" title="标题">文字</a></p>')).toBe('[文字](https://a.com/x "标题")');
  });

  it("相对链接保留原样，不做补全（与 Typora 一致）", () => {
    expect(md('<p><a href="docs/guide.md#install">指南</a> <a href="../up.html">上级</a></p>')).toBe(
      "[指南](docs/guide.md#install) [上级](../up.html)",
    );
  });

  it("含空格/括号的地址用尖括号包裹", () => {
    expect(md('<p><a href="my file (1).md">f</a></p>')).toBe("[f](<my file (1).md>)");
  });

  it("没有 href 的 <a> 只保留文字", () => {
    expect(md('<p><a name="top">顶部</a></p>')).toBe("顶部");
  });

  it("图片输出 alt / src / title，alt 中的方括号被转义", () => {
    expect(md('<p><img src="https://img.example.com/a.png" alt="图[1]" title="示意"></p>')).toBe(
      '![图\\[1\\]](https://img.example.com/a.png "示意")',
    );
  });

  it("链接包裹图片（徽章）", () => {
    expect(md('<p><a href="https://ci"><img src="https://badge/x.svg" alt="CI"></a></p>')).toBe(
      "[![CI](https://badge/x.svg)](https://ci)",
    );
  });

  it("没有 src 的图片丢弃", () => {
    expect(md('<p>a<img alt="x">b</p>')).toBe("ab");
  });
});

describe("htmlToMarkdown：列表", () => {
  it("无序 / 有序列表，有序列表保留 start", () => {
    expect(md("<ul><li>甲</li><li>乙</li></ul>")).toBe("- 甲\n- 乙");
    expect(md('<ol start="3"><li>三</li><li>四</li></ol>')).toBe("3. 三\n4. 四");
  });

  it("嵌套列表按标记宽度缩进", () => {
    expect(md("<ol><li>一<ul><li>子</li></ul></li><li>二</li></ol>")).toBe("1. 一\n   - 子\n2. 二");
  });

  it("不规范嵌套 <ul><li/><ul/></ul> 归到上一项", () => {
    expect(md("<ul><li>父</li><ul><li>子</li></ul></ul>")).toBe("- 父\n  - 子");
  });

  it("GitHub 任务列表", () => {
    expect(
      md(
        '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled checked> 完成</li>' +
          '<li class="task-list-item"><input type="checkbox" disabled> 未完成</li></ul>',
      ),
    ).toBe("- [x] 完成\n- [ ] 未完成");
  });

  it("列表项内多段落空行分隔并缩进", () => {
    expect(md("<ul><li><p>第一段</p><p>第二段</p></li></ul>")).toBe("- 第一段\n\n  第二段");
  });

  it("列表项内的代码块整体缩进", () => {
    expect(md("<ul><li>看代码<pre><code>a\nb</code></pre></li></ul>")).toBe("- 看代码\n\n  ```\n  a\n  b\n  ```");
  });

  it(`嵌套超过 ${MAX_LIST_DEPTH} 层：更深的项提升为第 ${MAX_LIST_DEPTH} 层的兄弟项，内容不丢`, () => {
    let html = "";
    for (let i = 1; i <= 8; i++) html += `<ul><li>L${i}`;
    for (let i = 1; i <= 8; i++) html += "</li></ul>";
    const out = md(html);
    const lines = out.split("\n");
    expect(lines).toHaveLength(8);
    const indentOf = (l: string) => l.length - l.trimStart().length;
    // 第 1~6 层逐级缩进 2 格
    for (let i = 0; i < 6; i++) expect(indentOf(lines[i])).toBe(i * 2);
    // 第 7、8 层与第 6 层同级
    expect(indentOf(lines[6])).toBe(10);
    expect(indentOf(lines[7])).toBe(10);
    expect(lines.map((l) => l.trim())).toEqual(Array.from({ length: 8 }, (_, i) => `- L${i + 1}`));
  });

  it("Word 列表段落（MsoListParagraph + 手写项目符号）转为列表", () => {
    const html =
      '<p class="MsoListParagraphCxSpFirst"><span>·<span>&nbsp;&nbsp;&nbsp;&nbsp;</span></span>苹果</p>' +
      '<p class="MsoListParagraphCxSpLast"><span>·<span>&nbsp;&nbsp;&nbsp;&nbsp;</span></span>香蕉</p>' +
      '<p class="MsoListParagraphCxSpFirst"><span>1.<span>&nbsp;&nbsp;</span></span>第一步</p>' +
      '<p class="MsoListParagraphCxSpLast"><span>2.<span>&nbsp;&nbsp;</span></span>第二步</p>';
    // CxSpFirst 标记新列表的开始：两组分别按首项标记判定有序/无序
    expect(md(html)).toBe("- 苹果\n- 香蕉\n\n1. 第一步\n2. 第二步");
  });
});

describe("htmlToMarkdown：引用", () => {
  it("引用内的多段落与嵌套引用", () => {
    expect(md("<blockquote><p>一</p><p>二</p><blockquote><p>深</p></blockquote></blockquote>")).toBe(
      "> 一\n>\n> 二\n>\n> > 深",
    );
  });

  it("引用内的列表", () => {
    expect(md("<blockquote><ul><li>a</li></ul></blockquote>")).toBe("> - a");
  });
});

describe("htmlToMarkdown：代码块", () => {
  it("无语言标识的 <pre> 输出无语言围栏", () => {
    expect(md("<pre>plain\n  indented</pre>")).toBe("```\nplain\n  indented\n```");
  });

  it('<code class="language-x"> / lang-x / highlight-source-x 做语言识别', () => {
    expect(md('<pre><code class="language-typescript">let a</code></pre>')).toBe("```typescript\nlet a\n```");
    expect(md('<pre class="lang-py">x</pre>')).toBe("```py\nx\n```");
    expect(md('<div class="highlight highlight-source-rust"><pre>fn main() {}</pre></div>')).toBe(
      "```rust\nfn main() {}\n```",
    );
  });

  it("代码内容原样保留，不做 Markdown 转义", () => {
    expect(md("<pre><code>a * b _c_ [d] &lt;e&gt; $f</code></pre>")).toBe("```\na * b _c_ [d] <e> $f\n```");
  });

  it("<br> 与逐行 div（部分高亮器）转为换行", () => {
    expect(md("<pre>l1<br>l2</pre>")).toBe("```\nl1\nl2\n```");
    expect(md("<pre><div>l1</div><div>l2</div></pre>")).toBe("```\nl1\nl2\n```");
  });

  it("内容含 ``` 时围栏自动加长", () => {
    expect(md("<pre>```js\nx\n```</pre>")).toBe("````\n```js\nx\n```\n````");
  });
});

describe("htmlToMarkdown：表格", () => {
  it("thead/tbody 映射为 GFM 表格", () => {
    expect(
      md("<table><thead><tr><th>名称</th><th>值</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>"),
    ).toBe("| 名称 | 值 |\n| --- | --- |\n| a | 1 |");
  });

  it("无 thead 时首行作为表头", () => {
    expect(md("<table><tr><td>h1</td><td>h2</td></tr><tr><td>c1</td><td>c2</td></tr></table>")).toBe(
      "| h1 | h2 |\n| --- | --- |\n| c1 | c2 |",
    );
  });

  it("text-align 映射为对齐标记", () => {
    expect(
      md(
        '<table><tr><th style="text-align:left">L</th><th style="text-align:center">C</th><th style="text-align:right">R</th><th>D</th></tr>' +
          "<tr><td>1</td><td>2</td><td>3</td><td>4</td></tr></table>",
      ),
    ).toBe("| L | C | R | D |\n| :--- | :---: | ---: | --- |\n| 1 | 2 | 3 | 4 |");
  });

  it("colspan/rowspan > 1：降级为普通单元格，合并信息丢弃，短行补空单元格", () => {
    expect(
      md(
        '<table><tr><th>a</th><th>b</th><th>c</th></tr><tr><td colspan="2">合并</td><td>x</td></tr>' +
          '<tr><td rowspan="2">纵</td><td>y</td><td>z</td></tr></table>',
      ),
    ).toBe("| a | b | c |\n| --- | --- | --- |\n| 合并 | x |  |\n| 纵 | y | z |");
  });

  it("单元格内的竖线（含行内代码里的）被转义，换行与多段落压成一行", () => {
    expect(
      md("<table><tr><th>A|B</th><th>C</th></tr><tr><td><code>x|y</code></td><td><p>一</p><p>二</p>三<br>四</td></tr></table>"),
    ).toBe("| A\\|B | C |\n| --- | --- |\n| `x\\|y` | 一 二 三 四 |");
  });

  it("单元格内的行内格式保留", () => {
    expect(md("<table><tr><th>h</th></tr><tr><td><b>粗</b> <a href='https://x'>链</a></td></tr></table>")).toBe(
      "| h |\n| --- |\n| **粗** [链](https://x) |",
    );
  });

  it("布局表格（单元格内嵌标题/列表/表格）不转 GFM 表格，按块展开", () => {
    expect(md("<table><tr><td><h2>侧栏</h2></td><td><ul><li>菜单</li></ul></td></tr></table>")).toBe("## 侧栏\n\n- 菜单");
    expect(md("<table><tr><td>只有一个单元格</td></tr></table>")).toBe("只有一个单元格");
  });

  it("表格 caption 输出为表格前的段落", () => {
    expect(md("<table><caption>表 1</caption><tr><th>a</th></tr><tr><td>1</td></tr></table>")).toBe(
      "表 1\n\n| a |\n| --- |\n| 1 |",
    );
  });
});

describe("htmlToMarkdown：水平线与实体", () => {
  it("<hr> 输出 ***（不用 --- 以免文档首块被当成 Front Matter）", () => {
    expect(md("<p>上</p><hr><p>下</p>")).toBe("上\n\n***\n\n下");
  });

  it("常见 HTML entity 解码为字符", () => {
    expect(md("<p>&copy; 2026 &mdash; &hellip; &eacute; &#x4E2D;&#25991;</p>")).toBe("© 2026 — … é 中文");
  });

  it("会被误解析为 Markdown 语法的字符被转义", () => {
    expect(md("<p>a*b*c _d_ [e](f) `g` &lt;h&gt; ~~i~~ $j$ a|b &amp;copy;</p>")).toBe(
      "a\\*b\\*c \\_d\\_ \\[e\\](f) \\`g\\` \\<h> \\~\\~i\\~\\~ \\$j\\$ a\\|b \\&copy;",
    );
  });

  it("行首的标题/列表/引用/有序号字符被转义", () => {
    expect(md("<p># 不是标题</p><p>- 不是列表</p><p>&gt; 不是引用</p><p>1. 不是有序</p><p>+ 加号</p>")).toBe(
      "\\# 不是标题\n\n\\- 不是列表\n\n\\> 不是引用\n\n1\\. 不是有序\n\n\\+ 加号",
    );
  });
});

describe("htmlToMarkdown：清理规则", () => {
  it("class/style/id 等属性不进入输出", () => {
    expect(md('<p class="lead" id="x" style="color:red" data-track="1">文字</p>')).toBe("文字");
  });

  it("未知块级容器（section/article/figure）递归取子节点并保持块边界", () => {
    expect(md("<section>甲</section><article>乙</article><figure><figcaption>丙</figcaption></figure>")).toBe(
      "甲\n\n乙\n\n丙",
    );
  });

  it("未知行内标签（font / o:p / g-emoji）拆包保留文字", () => {
    expect(md('<p><font color="red">红</font><o:p></o:p><g-emoji alias="smile">😄</g-emoji></p>')).toBe("红😄");
  });

  it("导航/表单/媒体等不可编辑的网页结构不进入文档", () => {
    expect(
      md(
        "<nav><a href='/'>首页</a></nav><p>正文</p><form><input type='text' value='x'><button>提交</button>" +
          "<select><option>选项</option></select></form><video src='v.mp4'>不支持</video><iframe title='广告'>嵌入内容</iframe>",
      ),
    ).toBe("[首页](/)\n\n正文");
  });

  it("内联 SVG（图标）不产生任何输出", () => {
    expect(md('<p><svg viewBox="0 0 1 1"><text>图标字</text></svg>文字</p>')).toBe("文字");
  });

  it("空输入返回空串", () => {
    expect(md("")).toBe("");
    expect(md("<div> </div>")).toBe("");
  });
});

describe("htmlToMarkdown：页面自带的私有区字符不被当成内部占位符（#244 review）", () => {
  // 转换器内部用 U+E000~U+E006 做硬换行/强调定界符占位；图标字体、Nerd Fonts 也用这段码位。
  // 修复前：`前&#xE001;后` → `前**后`（凭空加粗）、`前&#xE000;后` → 硬换行
  const SENTINELS = Array.from({ length: 7 }, (_, i) => 0xe000 + i);
  const hex = (cp: number) => cp.toString(16).toUpperCase();
  const ref = (cp: number) => `&#x${hex(cp)};`;

  for (const cp of SENTINELS) {
    it(`U+${hex(cp)}：正文中编码为字符引用，不产生定界符或换行`, () => {
      expect(md(`<p>前${ref(cp)}后</p>`)).toBe(`前${ref(cp)}后`);
    });
  }

  it("出现在标题、表格单元格、列表项、引用、Word 列表里同样被编码", () => {
    for (const cp of SENTINELS) {
      const c = ref(cp);
      expect(md(`<h2>标${c}题</h2>`)).toBe(`## 标${c}题`);
      expect(md(`<table><tr><th>h${c}</th></tr><tr><td>d${c}</td></tr></table>`)).toBe(
        `| h${c} |\n| --- |\n| d${c} |`,
      );
      expect(md(`<ul><li>项${c}</li></ul>`)).toBe(`- 项${c}`);
      expect(md(`<blockquote><p>引${c}</p></blockquote>`)).toBe(`> 引${c}`);
      expect(md(`<p class="MsoListParagraph"><span>·&nbsp;</span>词${c}</p>`)).toBe(`- 词${c}`);
    }
  });

  it("alt / title / 链接地址中被编码为字符引用", () => {
    expect(md('<p><img src="https://a/&#xE001;.png" alt="图&#xE003;" title="题&#xE000;"></p>')).toBe(
      '![图&#xE003;](https://a/&#xE001;.png "题&#xE000;")',
    );
    expect(md('<p><a href="https://a/&#xE005;" title="t&#xE002;">链&#xE006;</a></p>')).toBe(
      '[链&#xE006;](https://a/&#xE005; "t&#xE002;")',
    );
  });

  it("行内代码无法承载字符引用：替换为 U+FFFD，不破坏代码 span", () => {
    for (const cp of SENTINELS) {
      expect(md(`<p><code>a${ref(cp)}b</code></p>`)).toBe("`a�b`");
    }
  });

  it("代码块不经过行内构建：原字符原样保留", () => {
    const raw = SENTINELS.map((cp) => String.fromCodePoint(cp)).join("");
    expect(md(`<pre>x${raw}y</pre>`)).toBe(`\`\`\`\nx${raw}y\n\`\`\``);
  });

  it("与真实格式混排：真实的加粗/换行照常生效，页面字符不干扰", () => {
    // 字符引用的 `;` 是标点，收尾 ** 后接文字时按 flanking 规则再编码外侧的「后」
    expect(md("<p><b>粗&#xE002;</b>后<br>&#xE000;次行</p>")).toBe("**粗&#xE002;**&#x540E;\\\n&#xE000;次行");
  });

  it("占位区之外的私有区字符（U+E007、U+F8FF）不受影响，原样输出", () => {
    expect(md("<p>a&#xE007;b&#xF8FF;c</p>")).toBe("abc");
  });
});
