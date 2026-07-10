# Comet Unified Artifact Layout 设计

日期：2026-07-10

状态：草案，待用户 review 后进入 implementation plan

范围：为 Comet 增加统一 artifact layout，使 OpenSpec 和 Superpowers 产物可以稳定归到 `docs/` 下，并保持旧项目兼容

关联 issue：[#173](https://github.com/rpamis/comet/issues/173)

## 背景

Comet 当前把 OpenSpec 产物和 Superpowers 产物放在两个不同的根目录：

```text
openspec/changes/<name>/...
openspec/specs/...
docs/superpowers/specs/...
docs/superpowers/plans/...
docs/superpowers/reports/...
```

这继承了上游工具的默认布局，但对用户来说不够统一。issue #64 和 #173 都指向同一个问题：Comet workflow 的需求、设计、实施计划、验证报告和归档证据分散在多个顶层目录，用户和 Agent 都需要额外记忆这些目录之间的关系。

Superpowers 的产物目录目前固定在 `docs/superpowers`。OpenSpec CLI 则支持 store 机制，但它不是任意路径参数。当前 `@fission-ai/openspec@1.5.0` 的正常命令支持 `--store <id>`，并把选中的 store root 解析为：

```text
<root>/openspec/changes
<root>/openspec/specs
<root>/openspec/changes/archive
```

因此如果目标布局是：

```text
docs/openspec/changes
docs/openspec/specs
docs/superpowers/...
```

OpenSpec 的 store root 应该是 `docs`，不是 `docs/openspec`。

这个变化不能通过字符串替换完成。Comet 的 Classic runtime、Skill 文档、dashboard、hook guard、handoff hash、archive、eval 和测试都直接或间接依赖 root `openspec/changes`。

## 目标

1. 新项目可以选择统一 docs layout：

   ```text
   docs/openspec/...
   docs/superpowers/...
   ```

2. 旧项目的 legacy layout 继续可用：

   ```text
   openspec/...
   docs/superpowers/...
   ```

3. Comet 通过统一 resolver 管理 artifact layout，不再让 runtime、dashboard、hook guard 和 Skill 各自硬编码路径。
4. Comet 支持类似 OpenSpec 的 store id 配置，但不重新实现一套独立 store registry。
5. OpenSpec 命令在 docs layout 下稳定指向同一个 store/root。
6. Skill 不再指导 Agent 直接写死 root `openspec/changes`。
7. migration 命令以 dry-run 为默认，避免破坏 active change、handoff hash 或 archive。
8. eval 保留冻结 baseline，同时新增 docs layout 覆盖。

## 非目标

- 不修改 Superpowers 或 OpenSpec 原始 Skill。
- 不 fork OpenSpec CLI。
- 不要求所有旧项目自动迁移。
- 不把 `.comet/config.yaml` 从本地配置变成必须提交的项目文件。
- 不把 OpenSpec store registry 复制成 Comet 自己的全局 registry。
- 不在第一版支持多个 OpenSpec store 同时参与一个 Comet change。
- 不改变 OpenSpec archive 的语义，Comet archive 仍委托给 OpenSpec archive。

## 术语

### Project root

用户仓库根目录。所有 Comet 相对路径都必须以 project root 为基准解析。

### Artifact layout

Comet 对 OpenSpec 和 Superpowers 产物位置的布局选择。

第一版只支持：

```text
legacy
docs
```

### OpenSpec store root

传给 OpenSpec 的 root。OpenSpec 会在这个 root 下创建或读取 `openspec/`。

```text
legacy layout -> .
docs layout   -> docs
```

### OpenSpec store id

OpenSpec 用户级 registry 中的 store key。它用于 `openspec ... --store <id>`。

这个 id 是本机状态，不应该被当成跨机器稳定配置。Comet 可以在 `.comet/config.yaml` 中记录本机选中的 id，也可以通过 doctor/migrate 修复它。

### OpenSpec artifact root

实际 artifact 目录：

```text
legacy layout -> openspec
docs layout   -> docs/openspec
```

### Superpowers root

Superpowers 产物根目录。第一版保持：

```text
docs/superpowers
```

## 推荐方案

新增 Comet artifact layout resolver。所有路径敏感代码只从 resolver 取目录，不再直接拼 `openspec/changes`。

resolver 输出：

```ts
interface CometArtifactLayout {
  projectRoot: string;
  layout: 'legacy' | 'docs';

  openSpec: {
    storeId?: string;
    storeRoot: string;
    artifactRoot: string;
    changesDir: string;
    specsDir: string;
    archiveDir: string;
    commandArgs: string[];
    commandCwd: string;
  };

  superpowers: {
    root: string;
    specsDir: string;
    plansDir: string;
    reportsDir: string;
  };
}
```

`commandArgs` 和 `commandCwd` 用来集中处理 OpenSpec invocation：

- legacy layout：可以从 project root 调用 raw `openspec`。
- docs layout：优先使用 `--store <id>`；如果没有 store id，可以由 Comet wrapper 在 `docs` cwd 下执行 OpenSpec。

## 配置模型

`.comet/config.yaml` 增加 layout 配置：

```yaml
language: zh-CN
artifact_layout: docs

openspec:
  root: docs
  store: comet-comet-docs-7f3a91c2

superpowers:
  root: docs/superpowers
```

字段说明：

- `artifact_layout`: `legacy` 或 `docs`。
- `openspec.root`: OpenSpec store root，相对 project root。docs layout 下为 `docs`。
- `openspec.store`: 本机 OpenSpec store id。可缺省；缺省时 Comet wrapper 可以用 `cwd=docs` 执行 OpenSpec。
- `superpowers.root`: Superpowers 产物根。

`.comet/config.yaml` 当前是本地配置目录下的文件，仓库 `.gitignore` 已忽略 `.comet/`。因此 `openspec.store` 可以是本机值，不要求跨机器一致。

每个 change 的 `.comet.yaml` 应 snapshot 与恢复相关的布局字段：

```yaml
artifact_layout: docs
openspec_root: docs
superpowers_root: docs/superpowers
```

不建议把 `openspec.store` 写入 change `.comet.yaml`。store id 是本机 registry key，写入可提交 artifact 会降低可移植性。

## Store id 策略

OpenSpec store id 在用户级 registry 中必须唯一。不能让所有项目默认叫 `comet-docs`。

Comet 自动生成 store id 时使用：

```text
comet-<project-slug>-<short-hash>
```

规则：

1. `project-slug` 来自 project root basename，转为小写 kebab-case。
2. `short-hash` 来自 canonical project root 的短 hash。
3. 如果 registry 已有同 id 但指向不同路径，继续延长 hash 或要求用户选择。
4. 如果 `docs/.openspec-store/store.yaml` 已存在且 id 与 registry 不一致，优先报 doctor/migrate 错误，不静默覆盖。

OpenSpec store metadata 会写在：

```text
docs/.openspec-store/store.yaml
```

因为该 metadata 与本机 store id 有关，Comet 第一版应把它视为 local state。实现时需要决定是否新增 ignore 规则：

```text
docs/.openspec-store/
```

如果未来希望共享 OpenSpec store metadata，需要单独设计跨机器 store id 策略；这不属于第一版。

## OpenSpec 命令封装

为了避免 Skill 和 Agent 必须记住 `--store <id>`，新增 Comet OpenSpec facade：

```bash
comet openspec status --change "<name>" --json
comet openspec new change "<name>" --schema spec-driven
comet openspec archive "<name>" --yes
comet openspec validate "<name>"
comet openspec instructions tasks --change "<name>" --json
```

facade 行为：

1. 读取 artifact layout。
2. 如果 `openspec.store` 存在，调用 `openspec ... --store <id>`。
3. 如果 `openspec.store` 不存在但 layout 是 docs，使用 `cwd=<projectRoot>/docs` 调用 OpenSpec。
4. legacy layout 保持 project root 调用。
5. JSON 模式下保留 OpenSpec stdout JSON，不混入 Comet 文案。
6. human 模式可以在 stderr 输出简短 root 说明。

Skill 首选指导 Agent 使用 `comet openspec ...`。这样 layout 选择集中在 Comet，不分散到每个 Skill 文档。

## Init / Update 行为

### `comet init`

新增选项：

```bash
comet init --artifact-layout legacy
comet init --artifact-layout docs
comet init --openspec-store <id>
```

交互模式下：

1. 默认继续使用当前兼容布局，除非产品决策切到 docs layout。
2. 用户选择 docs layout 时，创建：

   ```text
   docs/openspec/
   docs/superpowers/specs/
   docs/superpowers/plans/
   docs/superpowers/reports/
   ```

3. 为 `docs` 注册或修复 OpenSpec store。
4. 写入 `.comet/config.yaml`。
5. 输出工作目录时同时展示 OpenSpec 和 Superpowers 目录。

非交互模式下，默认不改变既有行为。只有显式传 `--artifact-layout docs` 才创建 docs layout。

### `comet update`

`update` 不应自动迁移旧项目目录。它只更新 Skill、rules、hooks、project instructions 和 `.comet/config.yaml` 中已存在的兼容字段。

如果发现项目已经是 docs layout，`update` 应验证 OpenSpec store 是否可用；不可用时给出 repair 指引：

```bash
comet doctor --artifact-layout
comet migrate docs --repair-store
```

## Migration CLI

新增命令：

```bash
comet migrate docs --dry-run
comet migrate docs --apply
comet migrate docs --repair-store
comet migrate docs --include-active
```

默认行为是 dry-run。

### Dry-run 输出

dry-run 必须列出：

- 当前 layout。
- 目标 layout。
- legacy `openspec/` 是否存在。
- `docs/openspec/` 是否存在。
- active changes 数量。
- archived changes 数量。
- 会移动或保留的目录。
- store id 和 store root 计划。
- 冲突和阻塞原因。

### 迁移规则

无 active change 时：

1. 移动或复制 `openspec/` 到 `docs/openspec/`。
2. 创建或修复 `docs/.openspec-store/store.yaml` 和 OpenSpec registry。
3. 写 `.comet/config.yaml` layout 字段。
4. 保留 legacy `openspec/` 备份或要求用户确认删除。

有 active change 时，默认阻塞：

```text
Active changes exist. Re-run with --include-active after reviewing handoff and resume impact.
```

`--include-active` 必须处理：

- `.comet.yaml` path pointers。
- `handoff_context`。
- `handoff_markdown`。
- `subagent_progress`。
- `verification_report`。
- handoff hash 重算或显式失效。

handoff hash 当前包含源文件路径，路径迁移会改变 hash。第一版建议迁移 active change 时清空旧 `handoff_hash` 并要求重新生成 handoff，而不是尝试静默保持 hash。

### 冲突处理

如果 `docs/openspec/` 已存在：

- 如果是健康 OpenSpec root 且内容与 legacy 不冲突，可以 merge。
- 如果已有同名 change 或 archive，dry-run 报 conflict。
- `--apply` 不得覆盖用户文件。

如果 OpenSpec store id 已被其他路径使用：

- 生成新 id。
- 或要求用户传 `--openspec-store <id>`。

## Runtime 改造

Classic runtime 源码需要统一改为 layout-aware。

重点模块：

- `classic-paths.ts`
- `classic-store.ts`
- `classic-validate-command.ts`
- `classic-handoff.ts`
- `classic-evidence.ts`
- `classic-guard.ts`
- `classic-hook-guard.ts`
- `classic-archive.ts`
- `classic-resume-probe` 相关代码

现有固定路径需要替换：

```text
openspec/changes/<name>
openspec/changes/archive
openspec/specs
```

archive 必须通过 resolver 调用 OpenSpec：

```text
comet openspec archive <change> --yes
```

或内部等价调用 `openspec archive <change> --yes --store <id>`。

源码改动后必须运行：

```bash
pnpm build:classic-runtime
```

并同步生成：

```text
assets/skills/comet/scripts/comet-runtime.mjs
```

如果 runtime 脚本拆分已经落地，还要同步 manifest、launcher 和 eval benchmark copies。

## Dashboard 改造

dashboard collector 当前只扫描 root `openspec/changes`，并通过向上找到 `openspec` 目录推断 project root。docs layout 下这会把 `docs` 误判为 project root。

新规则：

1. dashboard 从 project root 读取 Comet artifact layout。
2. 同时支持扫描 legacy 和 docs layout。
3. project root 永远来自 CLI 输入或 resolver，不从 changeDir 的 `openspec` 父目录反推。
4. change item 可以附带 `layout` 字段，便于 UI 和 debug。
5. artifact preview 中的 Superpowers path 始终按 project root 解析。

## Hook Guard 改造

hook guard 需要同时识别：

```text
openspec/changes/<name>/
docs/openspec/changes/<name>/
docs/superpowers/
```

规则：

1. active change discovery 通过 resolver。
2. protected path 允许列表支持 legacy 和 docs layout。
3. `docs/superpowers/` 与 active change 的关联校验保持。
4. 写入边界不能因为目录迁移扩大到整个 `docs/`。
5. 对 `docs/.openspec-store/` 的写入只能出现在 init/migrate/doctor repair 流程中。

## Skill 改造

双语 Skill 必须同步，中文先写，用户确认后再改英文。

需要修改的主文件：

- `assets/skills-zh/comet/SKILL.md`
- `assets/skills/comet/SKILL.md`
- `assets/skills-zh/comet-open/SKILL.md`
- `assets/skills/comet-open/SKILL.md`
- `assets/skills-zh/comet-design/SKILL.md`
- `assets/skills/comet-design/SKILL.md`
- `assets/skills-zh/comet-build/SKILL.md`
- `assets/skills/comet-build/SKILL.md`
- `assets/skills-zh/comet-verify/SKILL.md`
- `assets/skills/comet-verify/SKILL.md`
- `assets/skills-zh/comet-archive/SKILL.md`
- `assets/skills/comet-archive/SKILL.md`
- `assets/skills-zh/comet-hotfix/SKILL.md`
- `assets/skills/comet-hotfix/SKILL.md`
- `assets/skills-zh/comet-tweak/SKILL.md`
- `assets/skills/comet-tweak/SKILL.md`
- `assets/skills-zh/comet-any/**`
- `assets/skills/comet-any/**`

Skill 中不再把 root `openspec/changes/<name>` 写成唯一事实。推荐写法：

```text
<openspec-change-dir>/.comet.yaml
<openspec-change-dir>/tasks.md
<openspec-change-dir>/.comet/handoff/...
```

OpenSpec CLI 调用优先使用：

```bash
comet openspec status --change "<name>" --json
comet openspec instructions tasks --change "<name>" --json
comet openspec archive "<name>" --yes
```

如果必须展示 raw OpenSpec 示例，需要明确说明：

```text
Use `--store <id>` when Comet is configured with docs layout.
```

## Workflow Contract 改造

`domains/workflow-contract` 当前把 state path 固定为：

```text
openspec/changes/*/.comet.yaml
```

需要支持 layout-aware path patterns：

```text
openspec/changes/*/.comet.yaml
docs/openspec/changes/*/.comet.yaml
```

更好的长期方案是 contract 不直接存 path glob，而是存 artifact kind：

```text
kind: comet-change-state
```

再由 resolver 生成具体 path。

## Eval 改造

冻结 baseline 不应直接改：

- `COMET_FULL_039`
- `COMET_FULL_040_BETA`

新增 docs layout treatment，例如：

```text
COMET_FULL_040_BETA_DOCS_LAYOUT
```

eval validation 需要区分：

- legacy baseline 期望 `openspec/changes`
- docs layout treatment 期望 `docs/openspec/changes`
- rubric 中涉及 `openspec/changes` 的 path matcher 需要支持两种布局，或按 treatment 注入 layout

Dockerfile/task fixture 中创建目录的位置也要跟随 treatment。

## Repository / Ignore 规则

Comet 自身仓库已允许 `docs/`，但实现时仍需检查：

- `config/repository-layout.json`
- `scripts/lint/architecture.mjs`
- `.gitignore`
- `test/repository/*`

如果第一版把 `docs/.openspec-store/` 当本机状态，需要加入 ignore 规则，并确保 architecture lint 不把它当成源目录。

## 数据流

### 新项目 docs layout

```text
comet init --artifact-layout docs
  -> create docs/superpowers/*
  -> create docs/openspec/*
  -> create/register OpenSpec store root at docs
  -> write .comet/config.yaml layout fields
  -> install/update Skills and project instructions
```

### 创建 change

```text
comet openspec new change add-auth
  -> resolver reads docs layout
  -> invokes openspec new change add-auth --store <id>
  -> OpenSpec creates docs/openspec/changes/add-auth
  -> comet-state init writes .comet.yaml in that change dir
  -> .comet.yaml snapshots artifact_layout/openSpec root/superpowers root
```

### 恢复/guard/dashboard

```text
command starts
  -> resolver reads project config
  -> scans docs/openspec/changes and legacy fallback if needed
  -> resolves change dir
  -> reads state and artifact pointers relative to project root
```

### 归档

```text
comet archive
  -> resolver finds active change
  -> runs openspec archive <change> --yes through facade
  -> archive lands in docs/openspec/changes/archive/...
  -> Comet annotates state and reports using project-root-relative paths
```

## 兼容策略

1. 旧项目不自动迁移。
2. `resolveClassicChangeDirectory(name)` 同时查 docs 和 legacy。
3. 如果两个布局都有同名 active change，命令必须失败并要求用户选择或迁移修复。
4. `.comet.yaml` 中没有 layout 字段时按 legacy 解释。
5. `.comet/config.yaml` 中没有 layout 字段时按 legacy 解释。
6. Skill 文案避免假设单一目录。

## 错误处理

### Store id 缺失

docs layout 下如果没有 `openspec.store`：

- Comet facade 可用 `cwd=docs` 调用 OpenSpec。
- `doctor` 提示可运行 repair 注册 store。
- Skill 不应直接调用 raw `openspec`，否则可能找不到 root。

### Store id 指向错误路径

失败并提示：

```text
OpenSpec store '<id>' points to '<path>', expected '<project>/docs'.
Run: comet migrate docs --repair-store
```

### docs/openspec 不健康

提示缺失项：

```text
Missing docs/openspec/config.yaml
Missing docs/openspec/changes/archive
```

repair 可以创建缺失的空目录，但不得覆盖现有文件。

### project root 误判

所有 path pointer 都必须按 resolver 的 project root 解析。不得通过 `path.basename(cursor) === 'openspec'` 反推 project root。

## 测试策略

### Unit tests

- resolver 默认识别 legacy layout。
- resolver 识别 `.comet/config.yaml` docs layout。
- resolver 输出 docs layout 下的 OpenSpec dirs。
- resolver 处理缺失 store id 时生成 `cwd=docs` fallback。
- store id 冲突时报错或生成替代 id。
- change `.comet.yaml` snapshot layout 字段。

### Classic runtime tests

- `state init` 在 legacy layout 下仍写 `openspec/changes/<name>/.comet.yaml`。
- `state init` 在 docs layout 下写 `docs/openspec/changes/<name>/.comet.yaml`。
- `state get/set` 能读两种 layout。
- active 和 archive lookup 支持两种 layout。
- 同名 active change 出现在两种 layout 时 fail closed。
- handoff 在 docs layout 下写到 `docs/openspec/changes/<name>/.comet/handoff`。
- handoff hash 迁移后需要重新生成。
- archive 通过 OpenSpec facade/store 调用。
- hook guard 允许 docs layout OpenSpec artifact 写入，但不放开整个 `docs/`。

### Dashboard tests

- legacy project 正常显示 active/archive changes。
- docs layout project 正常显示 active/archive changes。
- `docs/openspec` 下的 change 不会导致 project root 变成 `docs`。
- Superpowers artifact path 从 project root 解析。

### Skill tests

- 中文和英文 Skill 不再把 `openspec/changes/<name>` 当唯一路径。
- Skill 指导使用 `comet openspec ...`。
- references、rules、subagent-dispatch、context-recovery 同步。
- manifest shipping 覆盖新增/移动引用文件。

### Migration tests

- dry-run 无 active change 输出移动计划。
- dry-run 有 active change 默认阻塞。
- `--include-active` 清空或标记 handoff hash 需要重建。
- legacy 和 docs 同名 change 冲突时报错。
- stale store id 可通过 `--repair-store` 修复。
- `--apply` 不覆盖已有用户文件。

### Eval tests

- legacy baseline validation 不变。
- docs layout treatment 创建 `docs/openspec/changes`。
- rubric path matcher 支持 docs layout。

## 验证命令

实现阶段建议至少运行：

```bash
npx vitest run test/domains/comet-classic/comet-scripts.test.ts
npx vitest run test/domains/dashboard/collector.test.ts
npx vitest run test/domains/skill/skills.test.ts
npx vitest run test/domains/workflow-contract/workflow-contract.test.ts
node scripts/lint/architecture.mjs
node build.js
npx vitest run
git diff --check
```

本地 Windows 环境中，如果 `pnpm` wrapper 受环境影响，优先使用直接的 `node` 和 `npx vitest` 命令。

## Changelog 判断

实现完成后需要更新 `CHANGELOG.md`，因为这是用户可见的新能力。

候选条目：

```md
### Added

- **Unified artifact layout**: Added a docs-based Comet artifact layout with OpenSpec store resolution so new projects can keep OpenSpec and Superpowers workflow artifacts under `docs/`.
```

如果 migration CLI 同时落地，可追加：

```md
- **Artifact migration**: Added a dry-run-first migration command for moving legacy OpenSpec artifacts into the docs-based layout without overwriting active work.
```

版本号按实现时的仓库规则重新确认，不在 spec 阶段调整。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| OpenSpec store id 是本机 registry key，跨机器不稳定 | 只把 store id 写入本地 `.comet/config.yaml`，change artifact 只 snapshot root/layout |
| Agent 忘记带 `--store` | Skill 改为使用 `comet openspec ...` facade |
| `docs/openspec` 导致 project root 被误判为 `docs` | resolver 接收 project root，不从 changeDir 反推 |
| handoff hash 因路径迁移变化 | active migration 默认阻塞；显式迁移时要求重新生成 handoff |
| hook guard 放开过多 `docs/` 写入 | allowlist 精确到 `docs/openspec/changes` 和已有关联的 `docs/superpowers` |
| eval baseline 被破坏 | 冻结 baseline 不改，新增 docs layout treatment |
| store metadata 被提交造成冲突 | 第一版将 `docs/.openspec-store/` 视为本机状态并加入 ignore |

## 实施拆分

建议按以下 PR/Change 拆分：

1. **Layout resolver foundation**：新增 resolver、配置解析、legacy/docs path tests，不改默认行为。
2. **OpenSpec facade**：新增 `comet openspec ...`，支持 `--store` 和 `cwd=docs` fallback。
3. **Runtime adoption**：state、handoff、guard、archive、resume-probe 改用 resolver，并重新生成 runtime。
4. **Dashboard and workflow contract**：dashboard、workflow-contract、hook guard path patterns 支持 docs layout。
5. **Skill sync**：先中文后英文，替换硬编码路径和 raw OpenSpec 命令。
6. **Migration CLI**：dry-run、repair-store、apply、active change policy。
7. **Eval coverage**：新增 docs layout treatment 和 validation/rubric 支持。
8. **Docs/changelog**：README 必要说明和 changelog 发布条目。

## 成功标准

1. 新项目可以初始化为 docs layout。
2. `comet openspec new/status/instructions/archive/validate` 在 legacy 和 docs layout 下都指向正确 OpenSpec root。
3. Comet runtime 能在两种 layout 下 init/read/set/guard/handoff/archive。
4. dashboard 能展示两种 layout，且 project root 解析正确。
5. hook guard 不因 docs layout 放宽无关文件写入。
6. 双语 Skill 不再把 root `openspec/changes` 当成唯一事实。
7. migration dry-run 能清楚报告移动计划、store 修复计划和 active change 阻塞原因。
8. eval 冻结 baseline 不被破坏，新增 docs layout coverage。
9. focused tests、architecture lint、build 和 full test 在实现完成后通过。

