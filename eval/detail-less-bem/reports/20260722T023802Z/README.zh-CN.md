# detail-less-bem 评测解读

## 一句话结论

Skill 让硬性校验通过率从 **58.3%（14/24）** 提升到 **83.3%（20/24）**，提升 **25 个百分点**，超过预设的 20 个百分点目标；但 `violation-repair` 仅 **1/3** 通过，未达到关键任务必须 **3/3** 的要求，因此本轮最终结论是 **FAIL**。

`FAIL` 表示尚未满足发布门槛，不表示 Skill 没有收益。

## 这次测了什么

同一模型（MiniMax-M3）分别在两种条件下完成 8 个前端样式任务，每个任务运行 3 次：

- **CONTROL**：不提供 `detail-less-bem` Skill。
- **DETAIL_LESS_BEM**：提供该 Skill。

总计 48 次运行，全部有效：没有缺失、标记或排除的记录。

## 核心数字

| 指标 | CONTROL | 使用 Skill | 变化 |
|---|---:|---:|---:|
| 硬性校验通过 | 14/24 | 20/24 | +6 次 |
| 硬性校验通过率 | 58.3% | 83.3% | +25.0 个百分点 |
| 平均耗时 | 99.8 秒 | 99.1 秒 | 基本持平 |
| 软性质量分（满分 2） | 1.96 | 2.00 | +0.04 |

## Token 消耗对比

Token 数据来自每次 Agent 轨迹末尾的模型用量记录，24 次运行/组。

| 指标 | CONTROL | 使用 Skill | 变化 |
|---|---:|---:|---:|
| 输入 token（不含缓存读取） | 772,679 | 904,677 | +17.1% |
| 缓存读取 token | 8,108,913 | 8,666,882 | +6.9% |
| 输出 token | 114,582 | 90,617 | -20.9% |
| 总 API 成本 | $11.10 | $11.73 | +5.7% |
| 单次平均成本 | $0.462 | $0.489 | +$0.026 |

解读：Skill 使输入上下文增加，但 Agent 输出更短；总成本仅增加约 $0.63，同时硬性校验多通过 6 次。这里的成本为 MiniMax-M3 在 Anthropic 兼容接口返回的计量值，适合本轮 A/B 相对比较，不应视为通用模型定价。

## 按任务看结果

| 任务 | 未使用 Skill | 使用 Skill | 结论 |
|---|---:|---:|---|
| `bem-create` | 2/3 | 3/3 | 有提升：BEM modifier 绑定更稳定。 |
| `list-spacing` | 0/3 | 3/3 | 显著提升：列表间距规则全部通过。 |
| `horizontal-layout` | 3/3 | 3/3 | 原本已稳定通过。 |
| `text-truncation` | 3/3 | 3/3 | 原本已稳定通过。 |
| `line-height` | 3/3 | 3/3 | 关键任务，已满足要求。 |
| `platform-condition` | 2/3 | 3/3 | 关键任务，Skill 消除了条件编译问题。 |
| `equal-width-row` | 0/3 | 1/3 | 有改善，但仍不稳定。 |
| `violation-repair` | 1/3 | 1/3 | 关键任务，未改善，阻塞最终结论。 |

## 为什么最终是 FAIL

判定规则有两个条件，必须同时满足：

1. 总通过率至少提升 20 个百分点：**已满足**（+25.0）。
2. 三个关键任务 `line-height`、`platform-condition`、`violation-repair` 都必须 3/3 通过：**未满足**。

唯一阻塞项是 `violation-repair`。其中两次失败都缺少末项 BEM modifier：

```tsx
// 要求的行为：最后一个 action 同时挂基础类和 --last modifier
className={
  index === actions.length - 1
    ? 'service-card__action service-card__action--last'
    : 'service-card__action'
}
```

Agent 修复了 Less 中的 `gap`、嵌套选择器、非 px 行高和 hover 状态，却遗漏了这个 TSX 末项 className 条件。因此 Less 检查和 stylelint 通过，任务的业务/BEM 语义校验仍失败。

失败运行的完整轨迹：

- [rep-2 Agent 轨迹](/Users/zhangshuo12/Documents/my-project/comet/eval/detail-less-bem/evidence/20260722T023802Z-65007/attempts/violation-repair/DETAIL_LESS_BEM/rep-2/agent_trajectory.jsonl)
- [rep-3 Agent 轨迹](/Users/zhangshuo12/Documents/my-project/comet/eval/detail-less-bem/evidence/20260722T023802Z-65007/attempts/violation-repair/DETAIL_LESS_BEM/rep-3/agent_trajectory.jsonl)
- [rep-3 验证结果](/Users/zhangshuo12/Documents/my-project/comet/eval/detail-less-bem/evidence/20260722T023802Z-65007/attempts/violation-repair/DETAIL_LESS_BEM/rep-3/runner_result.json)

## 当前可得结论

Skill 对 BEM 创建、列表间距和平台条件编译有明确收益；它还没有稳定覆盖“修复样式时同步补齐 TSX 中末项 modifier”的要求。补强这条明确检查后，重新运行 `violation-repair` 的 3 次样本即可验证是否达到发布条件。

## 原始报告

- [机器可读 JSON](/Users/zhangshuo12/Documents/my-project/comet/eval/detail-less-bem/reports/20260722T023802Z/summary.json)
- [原始 Markdown](/Users/zhangshuo12/Documents/my-project/comet/eval/detail-less-bem/reports/20260722T023802Z/summary.md)
