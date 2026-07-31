<!-- TASK_VARIANTS: bem-create-a,bem-create-b,bem-create-c -->
<!-- The eval runner selects one complete variant by its TASK_VARIANT marker. -->

<!-- TASK_VARIANT: bem-create-a -->
## 变体 A

将 `src/vehicle-summary.tsx` 和 `src/vehicle-summary.less` 改为符合公共 Less 约束的 BEM 组件。整个组件只能使用 `vehicle-summary` 这一个顶层 block；标题必须为 `vehicle-summary__title`，价格必须为 `vehicle-summary__price`，禁用态必须为 `vehicle-summary--disabled`。禁用 modifier 必须和 `vehicle-summary` 基础类同时挂在同一个根 `View` 上。每条 Less 规则必须是顶层单个 BEM 类选择器。

保留标题和价格文案，所有文案置于带显式类名的 `<Text>` 中。完成后运行 Node 公共 Less 检查和定向 Stylelint。
<!-- END_TASK_VARIANT -->

<!-- TASK_VARIANT: bem-create-b -->
## 变体 B

重构 `src/vehicle-summary` 的 TSX 与 Less：只保留一个 BEM 命名空间 `vehicle-summary`。根容器使用 `vehicle-summary`，标题使用 `vehicle-summary__title`，价格使用 `vehicle-summary__price`，`disabled` 为真时给根容器追加 `vehicle-summary--disabled`，且不能省略基础类。Less 不得嵌套、不得写后代选择器，每个选择器独占顶层规则。

标题和价格均应使用显式样式的 `<Text>`。请校验最终 Less 的公共样式规则与 Stylelint。
<!-- END_TASK_VARIANT -->

<!-- TASK_VARIANT: bem-create-c -->
## 变体 C

修正 `src/vehicle-summary.tsx` 和对应 Less 的类名结构。目标结构为单一 block `vehicle-summary`、元素 `vehicle-summary__title` 和 `vehicle-summary__price`、根元素禁用状态 `vehicle-summary--disabled`。状态类必须与根基础类一起输出，不能用独立 `disabled` 类或 DOM 层级选择器表达状态。Less 的每个规则只能是一个顶层 BEM class selector。

不要移除现有标题和价格内容；它们必须包在显式 class 的 `<Text>` 里。结束前执行提供的 Less checker 和仅针对该 Less 文件的 Stylelint。
<!-- END_TASK_VARIANT -->
