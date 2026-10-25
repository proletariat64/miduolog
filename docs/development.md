# 开发与 PR

1. 在 `codex/` 分支明确本次需求，先查代码图谱，再核对源码和测试。
2. 修改实现，为数据、并发、恢复问题补针对性的回归测试。
3. 新 worktree 按[初始化流程](worktrees.md)运行 `npm run bootstrap`；提交前运行 `npm run check` 和 `git diff --check`。前者包含 ESLint、doc guard 与隔离测试，不调用真实模型。
4. 运行 `ocr review --background-file docs/architecture.md --format json --output .scratch/local-ci/ocr-review.json`。源码发送授权见根目录 `AGENTS.md`；按源码验证发现，修复后复查。OCR 结果与测试结果分别报告，命令成功不表示没有问题。
5. 暂存并核对本次源码变更，确保本地数据库、试卷、凭据与运行生成物保持被忽略，然后提交、推送并创建 PR。
6. PR 描述说明问题、最终行为、测试证据和迁移风险。Windows、Linux 的 GitHub Actions 检查通过并处理审查意见后，再合并。

图谱钩子提供提示，不代替 lint、测试或审查。OCR 使用本机已有配置，不放入 GitHub Actions，也不向 CI 写入账户凭据。

涉及已有数据的升级前，使用 `node scripts/verification/verify-architecture-data.mjs --snapshot` 保存基线和数据库备份；脚本在整个快照期间预留 SQLite 写锁，需在没有进行中导入、录入批次、图片保存、提示或批阅时运行。快照期间其他写请求可能失败，完成后可重试。快照包含全部应用表（包括录入题目、原作答、决策和来源关系）及完整 SQLite 备份；核对原字段，不因迁移新增列而误报。升级后运行同一脚本（不带参数）核对，期间不要继续录入或复习；这些文件均保留在本机。

新增和迁移文件先遵守[目录组织与文档维护](repository-structure.md)，文档从[索引](index.md)导航。可单独运行 `npm run docs:check`；CI 分别显示 lint、文档检查、测试结果。

## 手动维护工具

以下工具均从仓库根目录执行，不属于自动 CI：

- [批量导入](../scripts/operations/batch-import-papers.mjs)和[单张导入](../scripts/operations/import-paper.mjs)：向正在运行的本机服务提交用户指定的图片，结果留待核对。
- [Codex 验证](../scripts/verification/verify-codex.mjs)：使用[合成图片生成器](../scripts/verification/make-vision-fixture.py)的素材，调用真实模型。
- [存储一致性](../scripts/verification/verify-storage.mjs)：读取正在运行的本机服务核对关联关系。
- [升级数据核对](../scripts/verification/verify-architecture-data.mjs)：按上述快照流程核对本机数据。

针对某张个人试卷的题号、答案或导入编号编写的一次性操作脚本只保留在本机 `.scratch/`，不作为仓库通用维护工具。


## 录入服务开发

完整应用仍通过 `npm start` 或初始化后的 `npm run dev` 运行。独立接口入口为 `node app/intake-server.mjs`，默认端口4319，仅监听本机；环境变量 `MIDO_INTAKE_PORT` 与 `MIDO_INTAKE_DATA` 分别指定端口和数据目录。独立接口不加载复习模块，也不提供前端静态页面；完整应用的浏览器使用同一录入 handler。不要同时让独立入口与完整应用写同一数据目录。

录入自动验收优先走真实 HTTP 接口，使用临时 SQLite、合成图片及可控识别 adapter。模型替身只能证明接口行为；本地像素匹配使用真实合成图片，真实 Codex 识别另行手动验证。后者只使用合成或明确授权素材，结果与截图保存在忽略目录，不将孩子学习记录或试卷纳入源码审查材料。

新增录入接口以 `/api/intake/` 为前缀；旧批量维护脚本使用兼容单图入口，不能把脚本逐张提交当作一个具备答题纸关联的批次。HTTP 契约、题目/作答历史、恢复和 catalog 边界见[架构](architecture.md)，领域词汇见[业务术语](glossary.md)。
