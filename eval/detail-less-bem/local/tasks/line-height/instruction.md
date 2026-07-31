<!-- TASK_VARIANT: direct -->
修复 `src/VehicleSummary.tsx` 与 `src/vehicle-summary.less`。这是三端公共 Less：每一条 `line-height` 都必须是 px 数值，例如 `40px`。不能保留 `normal`、纯数字、百分比或相对单位。保持顶层 BEM 单选择器和 Text 显式样式。

<!-- TASK_VARIANT: business -->
车辆摘要在不同端的文字行高不一致。请只改 `src/VehicleSummary.tsx`、`src/vehicle-summary.less`，把公共样式中所有行高统一为明确 px 值，确保标题和说明 Text 自身有 BEM 样式；不要采用浏览器或 RN 的相对行高。

<!-- TASK_VARIANT: repair -->
公共 Less 检查报告了多个 `line-height` 兼容性错误。修正指定文件，让所有 `line-height` 声明匹配 px 数值规则。不得通过条件编译、删除文案或把样式迁到内联方式绕过检查；完成后运行公共 Less checker 和定向 stylelint。
