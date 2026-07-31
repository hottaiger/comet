<!-- TASK_VARIANT: direct -->
修复 `src/EntranceRow.tsx` 和 `src/entrance-row.less`：两个入口卡片必须同排等宽。公共 Less 使用顶层 BEM 单选择器，行容器显式写 `display: flex` 和 `flex-direction: row`，每张卡片使用 `flex: 1`。最后一张卡必须同挂基础类和末项 modifier：`entrance-row__card entrance-row__card--last`；固定间距用 `margin-right`，不用 `gap`、嵌套选择器或伪类。保留所有文案为 `Text`。

<!-- TASK_VARIANT: business -->
详情页的金融和置换入口需要在同一行各占一半，视觉高度一致。请只修改 `src/EntranceRow.tsx`、`src/entrance-row.less`，按三端公共 Less 约束实现：横向 flex 必须明确 row，卡片等分剩余宽度，最后一张卡同挂 `entrance-row__card entrance-row__card--last` 以清除其右间距。不要加入业务代码或使用 CSS `gap`。

<!-- TASK_VARIANT: repair -->
当前入口卡片布局在 RN 会纵向堆叠。修正指定 TSX/Less，使两个卡片成为等宽横排卡片。公共 Less 必须是平铺的 BEM 类规则；`display: flex`、`flex-direction: row` 和卡片 `flex: 1` 都必须存在，最后一张卡同挂 `entrance-row__card entrance-row__card--last`。完成后运行公共 Less 检查与定向 stylelint。
