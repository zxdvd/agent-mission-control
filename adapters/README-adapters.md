# 本地 Agent 适配器

优先支持 Codex，另提供 Claude Code 观察型 hooks。Node.js 20+，macOS / Linux / WSL；不安装 daemon，不读取会话记录，不远程操作审批。OpenCode 暂未实现。

## 真实能力边界

| 方式 | 能观察到 | 不能据此判断 |
| --- | --- | --- |
| Codex 默认 `notify` | `agent-turn-complete`，通过最后一个 argv 接收 JSON | 开始运行、请求审批、等待输入、整个任务完成 |
| Codex 可选生命周期 hooks | SessionStart、UserPromptSubmit、PermissionRequest、Stop、SessionEnd、Interrupt | 所有审批已解决、所有后台工作结束、任务已完成 |
| Claude Code hooks | SessionStart、UserPromptSubmit、PermissionRequest、Stop、SessionEnd；permission_prompt 通知 | Stop 代表任务完成；所有版本/运行模式的完整审批覆盖 |
| `run` 包装器 | 启动器进程存活、退出、运行期间每 30 秒心跳 | 模型一直在运行、交互式进程一直忙碌、退出 0 代表任务完成 |
| 独立 `heartbeat` | 这台主机最近能发送请求 | Agent 仍在工作、无心跳就一定关机 |

Claude hooks 无论成功、网络失败或输入格式错误，stdout 都只输出 `{}`，退出码为 0。不会输出 allow/deny、decision、continue 或 additionalContext。Codex notify 不输出内容。两者均为观察端，不改变审批策略。

`Stop`/`agent-turn-complete` 映射为 `turn_finished`，任务保持 open。`SessionEnd` 仅结束会话。包装器的正常/异常退出也不自动发送 `task_completed` 或 `task_failed`。仅用户明确运行 `complete` / `fail` 时才声明结果。

`idle_prompt` 是启发式信号，这里不把它当作已观察到的“等待输入”。审批没有统一的“已解决”事件，因此正常心跳、后续回合、Stop 都不应代替审批确认。看板上的已读/忽略也不会向 Agent 批准操作。

## 快速接入：Codex notify

1. 按 [部署说明](../DEPLOY.zh-CN.md) 为这台电脑配置固定 Token：Worker Secret 仅保存 SHA-256 摘要，本机私有文件保存明文。合法首报自动建立主机记录。每台电脑使用各自的 host ID / token。
2. 将项目保留在一个固定绝对路径；hook 引用其中的脚本。移动/删除项目后应重新安装。
3. 在本机 Bash 终端执行下面一组命令。输入的 token 不回显、不进入命令历史；不要把 token 写进命令参数、仓库、截图或聊天。

```bash
read -r -s -p 'Host token: ' AMC_INPUT_TOKEN; printf '\n'
printf '%s' "$AMC_INPUT_TOKEN" | node '/absolute/path/agent-mission-control/adapters/amc.mjs' init \
  --server 'https://mission-control.example.com' \
  --host-id 'my-mac' --token-stdin
unset AMC_INPUT_TOKEN
```

`init` 是单命令的配置 + 安装操作。`--token-stdin` 明确把 token 保存在本机 `~/.agent-mission-control/host-token`（0600），目录为 0700；不会发起网络请求。若你已经有一个 0600 的 token 文件，可直接使用：

```bash
node '/absolute/path/agent-mission-control/adapters/amc.mjs' init \
  --server 'https://mission-control.example.com' --host-id 'my-mac' \
  --token-file '/absolute/private/path/host-token'
```

默认只在 `~/.codex/config.toml` 顶层添加受管 `notify` 数组，参数按 argv 传递，路径中的空格/单引号安全。尊重 `CODEX_HOME`；也可显式 `--codex-home /path`。使用 `--state-dir /path` 时，所有后续命令也应带上同样参数，或设置 `AMC_STATE_DIR`。

- 已存在任何 notify 时拒绝覆盖/自动串接。可保留原程序，改用包装器或经审核的生命周期 hooks。
- 已有 settings/config 保留所有非本项目值。首次改动前创建私有 `.amc-backup`，已有备份绝不覆盖。
- 重复安装不增加条目。被手动修改的 notify 管理块不会被强制替换或删除。
- 遇到不确定的 TOML 写法（例如转义键）保守拒绝，要求手动检查。
- `init` 成功并不代表事件已上传。新开一个 Codex 会话，完成一个回合，再检查任务列表。只有 `notify` 时，任务可能直到第一个回合结束才出现。

可选元数据全部由你显式提供：`--name`、`--project`、`--repo owner/repo`、`--branch`。默认不读取 cwd、Git remote、分支、用户名或主机名。不要在这些标签中填入敏感信息。

## 可选：Codex 生命周期 hooks

先检查当前安装的能力：

```bash
node '/absolute/path/agent-mission-control/adapters/amc.mjs' doctor --agent codex
node '/absolute/path/agent-mission-control/adapters/amc.mjs' prepare-codex-hooks
```

`doctor` 有界执行本地 `codex --version`、`--help`、`features list`，只报告版本和检测结果，不运行编码任务，不读取 auth 或 transcript。文档没有可靠的最低版本承诺；检测不到明确能力时返回 `unknown`。`detected-disabled` 也不能宣称 hooks 已工作。

`prepare-codex-hooks` 仅生成 `codex-hooks.candidate.json`，不会修改 Codex 配置。审核文件后，明确选择安装：

```bash
node '/absolute/path/agent-mission-control/adapters/amc.mjs' uninstall --target codex-notify
node '/absolute/path/agent-mission-control/adapters/amc.mjs' install --agent codex --codex-hooks
```

安装合并 `~/.codex/hooks.json` 的 hook groups，保留其他 hooks。我们不同时安装自有 notify 与生命周期模式，避免重复结束事件。若你自己在其他配置层配置了 notify/hooks，请检查它们是否重复。

随后在 Codex 中打开 `/hooks`，逐项审查并手动 trust 当前定义。安装器不会自动信任、不设置 `features.hooks`、不修改管理员策略、不使用 trust bypass。新定义未获得本机信任前可以不运行。重新加载/重启会话后验证。能力未知、被管理员关闭或旧版本不支持时，继续用 notify。

## Claude Code

已有连接配置时：

```bash
node '/absolute/path/agent-mission-control/adapters/amc.mjs' install --agent claude
```

首次安装可用与上面相同的 `init`，增加 `--agent claude`。默认合并 `~/.claude/settings.json`，可用 `--claude-home` 指向隔离目录。hook 通过 shell 执行，所有路径使用 POSIX 安全引用。hook 从 stdin 读取 JSON；只挑选事件名称与原生 session ID 做映射，其余输入全部丢弃。检查 Claude Code 的 hooks 设置并按当前版本要求重启会话。

## 任务 / 会话 / run 的关联

- 默认 task、session、run 都按 host ID、agent 类型、原生 session ID 的摘要隔离；不会因为 cwd 相同而合并任务。
- `turn-id` 仅用于 Codex notify 去重，不把每个回合当作重试。一个原生会话中的多个回合共用一个 run。
- 同一个逻辑任务需跨会话接续时，显式设置 `AMC_TASK_ID=my-task`，或使用 `run --task-id my-task`。不同原生会话各自保留独立 run。
- 同一原生会话明确切换到新的 `AMC_TASK_ID` 会得到新的、绑定该 task 的 run，避免旧 run 错关联。
- 本地关联记录最多保存 500 个会话/30 天。需要长期显式分组时，每次启动都传入相同 `AMC_TASK_ID`；不要依赖过期后的本地回忆。

包装器示例（不会改变 Agent 参数）：

```bash
node '/absolute/path/agent-mission-control/adapters/amc.mjs' run \
  --agent codex --task-id my-task -- codex exec 'Run the test suite'
```

包装器 `shell:false` 原样传递参数，Agent 退出码会返回给调用者。启动器有一个独立 session/run，用来表示进程活动；原生 hooks/notify 仍用真实会话身份，并关联到显式 task。交互式 CLI 开着不等于模型仍忙碌，这一限制写在事件摘要中。

任务完成后，从任务详情复制 task/session/run ID，再显式声明：

```bash
node '/absolute/path/agent-mission-control/adapters/amc.mjs' complete \
  --agent codex --task-id my-task --session-id session_... --run-id run_...
```

只有确认失败时才使用同参数的 `fail`。程序不从进程退出码、最后一条回答、Stop 或工具输出推测任务结果。

## 心跳与离线：无后台服务

```bash
node '/absolute/path/agent-mission-control/adapters/amc.mjs' heartbeat
node '/absolute/path/agent-mission-control/adapters/amc.mjs' flush
```

普通 hooks 只在事件发生时执行。未运行包装器/定时器时，闲置电脑可能被标记为“推断离线”，不能据此认定任务失败。服务端通过 `OFFLINE_SECONDS` 配置阈值；随附部署配置为 180 秒，代码未提供该值时回退到 120 秒。

如果要区分“空闲”和“无法联系”，由你明确添加 OS scheduler（cron/systemd timer/launchd），每 60 秒执行一次 heartbeat。安装器不会自动创建调度项。cron 示例中的 Node 和脚本必须使用实际绝对路径：

```cron
* * * * * /absolute/path/to/node '/absolute/path/agent-mission-control/adapters/amc.mjs' heartbeat >> /dev/null 2>&1
```

使用非默认 state dir 时附加 `--state-dir '/absolute/path'`。Windows 原生 shell 自动安装未支持；WSL 可使用以上流程。不要为了看板而放宽系统安全设置。

## 网络、缓冲与隐私

- Hook 总时限 2.8 秒；stdin 最多 1 MiB，读取等待最多 500 ms。
- 单次请求超时最多 550 ms；网络/5xx 最多再试 1 次；单次 flush 最多 3 个事件，总网络预算 1.7 秒。
- 网络失败、401/403、重定向、限流：保留队列，下一次 hook/heartbeat/flush 再试。HTTP 重定向从不跟随，避免泄露 bearer token。
- 磁盘队列上限 200 条 / 512 KiB / 7 天；单事件 8 KiB。超限丢弃最旧记录；这不是无损审计日志。
- Codex 去重缓存保存最近最多 128 个原始事件信封 / 512 KiB / 7 天。重放复用原始 timestamp 和 payload，避免服务器幂等冲突。超出窗口的永久 409 与 400/413/422 会计入 rejected 并跳过，不会永久堵塞队列。
- 并发写锁被占用时立即 fail-open，极端突发事件可能丢失。没有重试 daemon。flush 输出 sent/attempts/rejected/pending 计数，不输出 token 或服务器响应正文。`doctor` 还能查看私有本地保存的累计 sent/rejected、上次 HTTP 状态、待发数量和尝试时间；即使 hook 静默失败，永久拒绝也能诊断。计数不含任何请求/响应正文或凭证。
- 仅上传标识、时间、事件类型及有限标签/固定摘要。原生 session/thread/turn ID 摘要化；不上传 prompt、assistant response、tool command/input、transcript 路径或内容、cwd、环境变量、token。
- Token 只作为请求认证发送给你配置的 HTTPS origin（本地开发仅允许 loopback HTTP）。不要把整个 state 目录或备份文件加入仓库/交付 ZIP。

## 卸载

```bash
node '/absolute/path/agent-mission-control/adapters/amc.mjs' uninstall
# 或仅卸载某一模式
node '/absolute/path/agent-mission-control/adapters/amc.mjs' uninstall --target claude-hooks
```

只按安装清单删除精确匹配的自有 notify 块/hook command，保留其他配置。连接配置、token、缓冲文件和备份保留在本机，防止误删。要让这台电脑失去访问权，从 Worker Secret `AGENT_TOKENS_JSON` 删除该 host 的条目来撤销 token；需要清理时再手动删除你确认无用的本地文件。若添加过 cron/launchd，也由你删除对应调度项。

## 验证与来源

```bash
node --test tests/adapter*.test.mjs
# 与本地 Worker 在同一个运行环境中执行；只接受 loopback + LOCAL_DEV 身份
AMC_URL=http://127.0.0.1:8787 node tests/adapter-live.mjs
```

所有 unit fixtures 使用临时目录与合成 token，测试不写入真实 Codex/Claude 配置。live 测试创建合成主机，在私有临时目录使用 token，验证真实适配器 CLI 到 Worker/D1 的接收、去重、分组、隐私和完成语义；结束后撤销 token 并删除临时文件。它不启动真实 Codex/Claude 编码会话，因此不能替代你的本机端到端 hook 验证。

官方接口核对日期：2026-10-12。

- [Codex notify：argv JSON 与 agent-turn-complete](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)
- [Codex hooks：生命周期、配置发现、stdin、信任审核](https://learn.chatgpt.com/docs/hooks)
- [Claude Code hooks reference：stdin、PermissionRequest、Stop 与输出约定](https://code.claude.com/docs/en/hooks)

原生接口会变；doctor 的能力探测是保守提示，不能保证每种发行版/管理员策略都支持同样事件。
