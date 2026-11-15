# Herdr：第一版只读接入边界

本包不是一个正在运行的真实 Agent 集成。它只封装本机 `herdr agent list` 和 `herdr agent get <target>`，保留原始 JSON；暂不接入演示任务状态、不发送 prompt、不启动进程或远程会话。

## 本次实际验证

- 云端 PATH 中没有 `herdr`，不能验证真实 socket、返回结构或 Agent 状态。
- 云端有 `codex-cli 0.167.0-alpha.4`。只执行了版本查询，没有读取历史会话或启动任务。
- 单元测试使用假的执行器，覆盖参数传递、非法目标、非 JSON 响应和取消。它们不代表真实 Herdr 联通。
- 未访问公司电脑或服务器、未安装 Herdr，未制造审批或执行回执。

## 下一次公司电脑验证（仅验证，不在公司修源码）

1. 用户已授权的测试环境中查询 `herdr --version`、`herdr api schema --json`。
2. 运行 `herdr agent list`，挑选明确的本机 pane ID，再运行 `herdr agent get <pane-id>`。
3. 按实际结构补充最小字段映射：pane ID、所在目录、运行状态、更新时间。没有的数据标为未知，不凭空补全。
4. 列表和详情匹配后，另建一个隔离测试 pane，用无业务副作用的任务验证发送。现有业务会话仍只读。

“进程 working / done”不等于业务任务进行中 / 已交付。缺少真实状态时显示不可用或未知，不回退到演示数据。真实发送功能需等待上述验证，不把一次 CLI 返回成功当作任务完成，也不在超时后自动重复发送。

命令依据：[Herdr 官方 CLI 文档](https://herdr.dev/tui/docs/cli-reference/)。以测试机器安装版本的 schema 为准。
