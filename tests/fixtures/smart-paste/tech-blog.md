[首页](/) \| [归档](/archive)

# 深入理解 ProseMirror 事务

2026-09-01 · 阅读约 5 分钟

ProseMirror 的每一次修改都是一个 `Transaction`，它继承自 `Transform`。下面是一个**最小示例**：

```typescript
const tr = view.state.tr;
tr.insertText("hello");
view.dispatch(tr);
```

> 提示：*不要*在 `dispatch` 之后继续复用同一个 `tr`。

## 位置映射

文档变化后旧位置需要经过 `tr.mapping.map(pos)` 映射，详见[官方指南](https://prosemirror.net/docs/guide/#transform.mapping "官方指南")。

![映射示意图](https://blog.example.com/images/mapping.png)

图 1：位置映射

1. 创建事务
2. 应用步骤
   1. 替换
   2. 标记
3. 派发

```
无语言的
  纯文本代码块
```

***

本文完。（转载请注明出处）

© 2026 示例博客