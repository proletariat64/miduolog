# 开发与 PR

1. 在 `codex/` 分支明确本次需求，先查代码图谱，再核对源码和测试。
2. 修改实现，为数据、并发、恢复问题补针对性的回归测试。
3. 首次使用运行 `npm ci`；提交前运行 `npm run check` 和 `git diff --check`。前者包含 ESLint 与隔离测试，不调用真实模型。
4. 运行 `ocr review --background-file docs/architecture.md --format json --output .scratch/local-ci/ocr-review.json`。源码发送授权见根目录 `AGENTS.md`；按源码验证发现，修复后复查。OCR 结果与测试结果分别报告，命令成功不表示没有问题。
5. 暂存并核对本次源码变更，确保本地数据库、试卷、凭据与运行生成物保持被忽略，然后提交、推送并创建 PR。
6. PR 描述说明问题、最终行为、测试证据和迁移风险。Windows、Linux 的 GitHub Actions 检查通过并处理审查意见后，再合并。

图谱钩子提供提示，不代替 lint、测试或审查。OCR 使用本机已有配置，不放入 GitHub Actions，也不向 CI 写入账户凭据。

涉及已有数据的升级前，使用 `node scripts/verify-architecture-data.mjs --snapshot` 保存基线和数据库备份；脚本在整个快照期间预留 SQLite 写锁，需在没有进行中导入、图片保存、提示或批阅时运行。快照期间其他写请求可能失败，完成后可重试。升级后运行同一脚本（不带参数）核对；这些文件均保留在本机。
