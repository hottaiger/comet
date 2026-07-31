<!-- TASK_VARIANT: direct -->
修复 `src/ArticleTitle.tsx` 和 `src/article-title.less` 的单行标题截断。最终标题必须使用 `<Text numberOfLines={{1}}>` 并显式挂 BEM 类。公共 Less 不得使用 `text-overflow` 或 `white-space`，也不能使用嵌套选择器、伪类或 web-only 截断方案。

<!-- TASK_VARIANT: business -->
车辆标题过长时需要在微信小程序、H5 和 RN 上一致显示一行。只修改 `src/ArticleTitle.tsx`、`src/article-title.less`：用 Taro `Text` 的 `numberOfLines={{1}}` 实现限制，文案样式直接挂到 Text；移除 CSS 省略号和 `white-space` 规则。

<!-- TASK_VARIANT: repair -->
当前标题依赖浏览器 CSS 截断，在 RN 不生效。修改指定 TSX/Less，让标题由 `Text numberOfLines={{1}}` 截断。保留公共 Less 的 BEM 单选择器和 px 行高，禁止 `text-overflow`、`white-space`、`word-break`。
