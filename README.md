# 米多错题本

版本：0.1.0。

当前版本已经接入本机 Codex app-server，支持打开 PNG、JPEG、WebP 图片、整页拆题、显示原题与原作答、提出待确认错因、核对修改以及入库。数学分数使用正式排版。

## 推荐复习与批阅

点击左侧“复习”，再点击“推荐复习”。清单仅包括已入库真实题目，显示推荐理由；选题后开始独立作答。原答案、错因和讲解在提交前隐藏。第15题使用依据原图关系绘制的独立几何示意图，避免显示带有旧答案的整张试卷。

可输入文字或打开本次作答图片，提交后由 Codex 真实批阅。提示也通过 Codex 生成，使用情况单独记录。结果分为独立做对、提示后做对、仍不会、待确认。信息不足或异议不计错；处理失败可保留作答后重试。原错因和掌握状态不会因批阅自动改变。

会话、题目快照、每次作答、提示、批阅及异议保存在本地 SQLite，可从复习入口继续或查看历史。作答图片位于 `data/review-images/`。首次四题验证单独标记为验证记录，不纳入真实推荐统计；已准备一轮尚未作答的正式四题复习。

## 运行

本机需要 Node.js 24 或以上，以及已经登录的 Codex CLI。

首次运行先执行 `npm ci` 安装锁定版本的开发工具。

双击 `start-notebook.cmd`，或在此目录运行：

```sh
npm start
```

打开 <http://127.0.0.1:4318/>。当前提供桌面浏览器界面，尚未打包为独立安装程序。图片识别使用 Codex 当前配置及可用模型，调用需要联网并使用相应账户额度；没有另行写入 API 密钥。Codex 可执行文件未被自动发现时，可设置 `MIDO_CODEX_BIN`。

## 数据

原图位于 `data/images/`，题目和复习状态位于 `data/notebook.sqlite`，均留在本机；识别与批阅时相关题目、作答或图片会发送给 Codex 模型服务。数据库和图片均不进入 Git。真实导入题目与最初的合成测试作业分别保留，合成试题不进入默认复习推荐。

本地试卷样本统一放在 `samples/papers/`。`data/`（含 SQLite 的 WAL、SHM 文件）和整个 `samples/` 目录均加入 `.gitignore`；复制到其他电脑时，需单独迁移这些本地文件。目录外的原始图片不移动。

## 验证

```sh
npm run check
```

隔离测试覆盖导入去重与恢复、Codex 调用生命周期、复习并发提交及真实 HTTP 入口，不调用模型或修改本地真实数据。架构说明见 [docs/architecture.md](docs/architecture.md)，业务用语见 [GLOSSARY.md](GLOSSARY.md)。

`npm run check` 顺序运行 ESLint 和测试；也可单独使用 `npm run lint` 或 `npm test`。GitHub Actions 在 Windows、Linux 的 Node.js 24 环境中执行同样的检查。开发到 PR 的流程见 [docs/development.md](docs/development.md)。

```sh
python scripts/make-vision-fixture.py
npm run verify:codex
```

生成图片仅依赖测试环境的 Pillow。验证通过本地图片输入，检查页面标记、数学与语文两题拆分、学生原作答和结构化分析。测试题文字与页面标记没有放进模型的文字提示中。

目录批处理通过运行中的错题本执行：

```sh
node scripts/batch-import-papers.mjs samples/papers --plan
node scripts/batch-import-papers.mjs samples/papers --run
```

`--plan` 只向本机检查图片是否已导入，不调用模型；`--run` 复用相同内容的任务并将新结果放入待核对区。浏览器与批处理使用同一套去重及恢复规则。

## 当前边界

跨图片合并、自动追问、主次错因完整编辑、重复题提示、备份恢复及独立桌面打包尚待接入；此前 `prototypes/` 下的页面仍是独立演示。

本地开发需求和决策保存在 `.scratch/mistake-notebook/spec.md` 与 `map.md`。`.scratch/` 包含运行记录及验证素材，仅保留在开发电脑，不提交到版本仓库；真实数据也不会随源码分发。
