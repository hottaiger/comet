<!-- TASK_VARIANT: direct -->
修复 `src/platform-condition.less` 的三端公共 Less。条件编译只可使用小写 `#ifdef`、`#ifndef`、`#endif`，平台名只可为小写 `rn`、`h5`、`weapp`。卡片阴影只能放在 H5 条件块中，RN 最终不能包含 `box-shadow`。保留 TSX 的 BEM 类和文本结构，并运行给定的 checker 与 stylelint。

<!-- TASK_VARIANT: business -->
详情卡片需要在 H5 显示阴影，RN 保持无阴影。请修正 `src/platform-condition.less` 中错误的平台条件写法：公共 Less 的条件标记和平台标识都必须是小写，且只允许 `#ifdef`、`#ifndef`、`#endif`。不要通过改成后代选择器或移除卡片结构规避问题；完成后 checker 和 stylelint 都应通过。

<!-- TASK_VARIANT: repair -->
当前平台样式回归来自大写条件编译和未隔离的 `box-shadow`。更新 `src/platform-condition.less` 与必要的关联 TSX，使 H5 专属阴影被小写条件编译准确包围，RN 不接收阴影；输出仍需符合顶层单 BEM 选择器、显式 Text 样式和公共 Less 校验。
