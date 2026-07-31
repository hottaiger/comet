<!-- TASK_VARIANT: direct -->
修复 `src/equal-width-row.less` 和必要的 TSX：双入口时横向等宽，单入口时回退为独占整行横条。行容器必须显式 `display: flex` 和 `flex-direction: row`，双入口卡片使用 `flex: 1`；单入口显式同挂 `entry-card--bar`。禁止 `gap`、后代/子代选择器、伪类；固定间距用卡片自身 `margin-right`，末项通过与基础类同挂的 `--last` modifier 清零。运行 checker 与 stylelint。

<!-- TASK_VARIANT: business -->
金融和置换入口同时存在时要同排等宽，置换入口缺席时金融入口需回退为独占整行横条，且最后一项不能留下右侧空隙。请用公共 Less 的 BEM 顶层规则实现：行负责横向排列，卡片自身负责等分和间距，TSX 对单入口显式附加 `entry-card--bar`、对末项附加 `--last`。不要依赖 `gap`、`:last-child` 或 `.row .card` 这类层级选择器。

<!-- TASK_VARIANT: repair -->
当前入口行在 RN 上布局不稳定，原因是 `gap` 与后代选择器。修复 `src/equal-width-row.less` 和关联 TSX：两张卡存在时必须在横向 flex 行内等宽；仅一张卡存在时必须以 `entry-card--bar` 回退为整行横条。间距由 `margin-right` 和 `entry-card--last` 表示，所有 Less 规则保持顶层单个 BEM 类，checker 与 stylelint 最终通过。
