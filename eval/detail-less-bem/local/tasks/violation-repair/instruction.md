<!-- TASK_VARIANT: direct -->
修复 `src/violation-repair.less` 中的公共 Less 违规：嵌套规则、伪类、`gap`、无单位 `line-height`。每条最终规则都必须是顶层单个 BEM 类；用 TSX 的 `--last` modifier 代替伪类和 gap；`line-height` 必须为 px 数值。保留卡片标题和操作文案，运行 checker 与 stylelint 并让两者通过。

<!-- TASK_VARIANT: business -->
服务卡片需要保留标题、操作项和固定间距，但现有写法无法稳定下发到 RN。请把层级样式和 hover 状态改为独立 BEM 类/修饰符，把 `gap` 改为操作项自身 margin，并使所有文本样式直接挂在 Text 类上。公共 Less 不可保留嵌套、伪类或无单位行高。

<!-- TASK_VARIANT: repair -->
这是一次公共 Less 违规修复任务。初始代码同时含嵌套、`&:hover`、`gap` 与 `line-height: 1.5`；请在 `src/violation-repair.less` 和必要 TSX 中完成等价修复。最终必须经过给定 Node checker 和定向 stylelint，且不能用删除内容或后代选择器规避规则。
