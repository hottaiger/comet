<!-- TASK_VARIANTS: list-spacing-a,list-spacing-b,list-spacing-c -->
<!-- The eval runner selects one complete variant by its TASK_VARIANT marker. -->

<!-- TASK_VARIANT: list-spacing-a -->
## 变体 A

修改 `src/vehicle-list.tsx` 和 `src/vehicle-list.less`，移除列表布局中的 `gap`。改为给 `vehicle-list__item` 设置 `margin-bottom: 12px`，并给最后一项添加 `vehicle-list__item--last`，在该 modifier 中将 `margin-bottom` 清零。不要使用 `:last-child` 或任何伪类。最后一项的 modifier 必须和 `vehicle-list__item` 基础类同时挂在同一个 `View` 上。

列表保持纵向 flex，且 Less 每条规则为顶层单一 BEM class selector。完成后运行提供的 Node checker 与定向 Stylelint。
<!-- END_TASK_VARIANT -->

<!-- TASK_VARIANT: list-spacing-b -->
## 变体 B

将 `vehicle-list` 的固定间距从 `gap` 改成重复子项 margin。每个 `vehicle-list__item` 使用 `margin-bottom: 12px`；通过循环索引识别最后一项，追加 `vehicle-list__item--last` 并在 Less 中声明 `margin-bottom: 0`。不允许伪类、`gap`、`row-gap` 或 `column-gap`。

`--last` 类需与 `vehicle-list__item` 一起输出在同一项上，所有 Less selector 必须为顶层单个 BEM class。执行该 Less 文件的 checker 与 Stylelint。
<!-- END_TASK_VARIANT -->

<!-- TASK_VARIANT: list-spacing-c -->
## 变体 C

修复 `src/vehicle-list` 的列表间距，使其符合公共 Less 限制：删除 `gap`，让 `vehicle-list__item` 通过底部 margin 产生 12px 间距，并让末项 modifier `vehicle-list__item--last` 将 margin 清为 0。末项状态必须由 TSX 同时挂载基础类和 modifier 表示，不能写 `:last-child`。

保留纵向 flex 布局，并使用顶层单 BEM selector。提交前运行公共 Less 检查和只针对 `vehicle-list.less` 的 Stylelint。
<!-- END_TASK_VARIANT -->

