# Worktree 初始化

在新 worktree 根目录执行；Git Bash、PowerShell、Linux shell 使用同一命令：

```sh
npm run bootstrap
npm run dev
```

也可以用 `node scripts/operations/bootstrap-worktree.mjs` 从其他目录调用脚本的绝对路径；它从脚本位置确定 worktree，不依赖调用者所在目录。Codex 的 worktree setup command 可填写 `npm run bootstrap`。

## 完整环境

同一台电脑的 worktree 复用本机工具安装与账户。前置工具为 Git、Node.js 24+（含 npm）、已登录的 Codex CLI、已配置的 OCR CLI、code-review-graph 和 Python（Windows 命令 python，Linux 命令 python3，含 venv/pip）。缺少工具时初始化返回失败并显示失败步骤；安装工具或完成登录后重跑。脚本不修改全局工具版本、账户配置或共享 Git hooks。

初始化依次执行：

1. 检查 Git 根目录、工具可执行性、Codex 登录状态及本地目录的 Git 忽略规则。
2. 创建各 worktree 独立的 data、samples/papers、.scratch 和 .code-review-graph 目录，拒绝把这些目录链接到其他位置。
3. 用 `npm ci --include=dev` 安装锁定依赖。在本 worktree 的 `.scratch/worktree/venv/` 创建 Python 虚拟环境，按 [vision-requirements.txt](../config/vision-requirements.txt) 安装合成图片所需的 Pillow。
4. 用 code-review-graph build 构建当前 worktree 的本地图谱，不运行远程 embedding。
5. 运行 `npm run check`（lint、doc guard、隔离测试）。全部通过才报告成功。

安装依赖需要联网。初始化仅查看 Codex 登录和 OCR 版本，不发送代码或试卷、不调用模型；需要验证 OCR 模型服务连接时，在本机执行 `ocr llm test`。完整初始化依赖本机已配置的工具；它不是新电脑的全局软件安装器。

只需要编辑代码、运行测试，或者在无模型账户的 CI 中准备环境时：

```sh
npm run bootstrap -- --core-only
```

该模式安装 Node 开发依赖并完成隔离目录、端口和全套检查，明确跳过 Codex/OCR、Python 与图谱。它不代表完整模型开发环境已就绪。

## 端口与重复运行

首次按 worktree 路径计算候选端口，并探测可用端口，保存到忽略文件 `.scratch/worktree/environment.json`。可以指定：

```sh
npm run bootstrap -- --port 4320
```

重复初始化保留已有端口及本地数据，重新按锁文件安装依赖、更新图谱并检查。失败后可直接重跑；检查失败时不能把已生成的目录当作成功标志。初始化与 npm ci 会更新本 worktree 的依赖，运行前先停止该 worktree 的开发进程。

`npm run dev` 读取该 worktree 配置；环境变量 MIDO_PORT 可临时覆盖。端口探测不永久占用端口；若两个工作区后来发生冲突，用 --port 为其中一个重新选择端口。原有 `npm start` 和桌面启动器仍使用默认运行方式，开发多个实例时使用 `npm run dev`。

## 数据与图片验证

worktree 不复制或链接其他 checkout 的数据库、试卷、node_modules、凭据或图谱。首次启动由应用创建空数据库；已有数据不清空。Git 的公共对象与配置由 worktree 机制共享，但生成目录独立。

使用虚拟环境生成合成图片，无需激活环境：

```sh
# Windows / Git Bash
.scratch/worktree/venv/Scripts/python.exe scripts/verification/make-vision-fixture.py
# Linux
.scratch/worktree/venv/bin/python scripts/verification/make-vision-fixture.py
npm run verify:codex
```

最后一条命令会调用真实模型。单张导入、批量导入和存储核对按 MIDO_URL、MIDO_PORT、本地环境配置、默认端口的优先级确定目标，临时端口覆盖与开发服务器保持一致。按[维护工具说明](development.md)从 worktree 根目录运行，避免把另一个实例当成目标。

## 验证初始化本身

`npm run verify:worktree` 从当前 HEAD 创建临时 detached worktree，运行 core-only 初始化和重复初始化、核对原文件保留，启动独立端口并确认空题库，最后清理该临时 worktree。它验证已提交代码；修改初始化脚本后，先通过单元测试并提交，再运行此验证。Windows/Linux CI 都执行这一流程。

本机执行 `npm run verify:worktree -- --full` 会在首轮准备完整工具环境，再用 core-only 验证重复初始化。验证不调用真实模型，不读取当前工作区的真实试卷和数据库。
