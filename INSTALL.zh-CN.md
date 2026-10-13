# 轻量安装：Codex App 本地 hooks

需要已有 Node.js 20+ 和 curl。无需 clone、npm install、sudo 或后台服务；缺少 Node 时停止，不自动安装。入口只下载固定提交的四个 `.mjs` 适配器，逐个验证入口内嵌 SHA-256 后才执行。

## 安装

使用发布者提供的完整 40 位安装器提交 SHA 替换下面的 `INSTALLER_COMMIT`。该模板不是可直接运行的版本链接；不要用会移动的 main/latest 代替固定提交。

```sh
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  'https://raw.githubusercontent.com/zxdvd/agent-mission-control/INSTALLER_COMMIT/install.sh' | sh
```

依次输入看板 HTTPS origin、已在服务端配置的 host ID 和主机 token。Token 从 `/dev/tty` 隐藏读取，不进入命令参数/历史，经私有 stdin 传给适配器并保存到 `~/.agent-mission-control/host-token`（0600）。不要把 token 写进聊天、截图或环境变量。没有交互终端时，先下载脚本，使用已有私有文件：

```sh
sh install.sh --server 'https://your-dashboard.example' --host-id 'your-host-id' \
  --token-file '/absolute/private/path/host-token'
```

可先将 curl 输出保存为 `install.sh`，审查后再运行。入口本身是你选择信任的代码；内嵌哈希保证适配器内容一致，不能替代入口来源信任或签名。

默认目录：程序 `~/.local/share/agent-mission-control/adapters/`；连接、token、缓冲与安装清单 `~/.agent-mission-control/`；Codex hooks `$CODEX_HOME/hooks.json`（未设置时 `~/.codex/hooks.json`）。可传 `--install-dir`、`--state-dir`、`--codex-home`，路径支持空格及 shell 特殊字符。安装后不要移动程序目录。

默认明确选择 Codex 生命周期 hooks，合并保留其他 hooks 和其他程序的 notify，不自动信任。`--agent claude` 可安装 Claude Code hooks，支持 `--claude-home`。底层 `amc.mjs init/install` 的 notify 默认行为保持兼容。

若原来从另一个目录装过 AMC，先用原脚本 `uninstall` 再迁移；旧 AMC notify 模式先 `uninstall --target codex-notify`。不要让新旧目录同时安装自有 hooks。

## 真实 App 验收

1. 在实际执行任务的电脑上，按当前 Codex App 支持的 `/hooks` 或本地 hooks 管理入口审核、信任精确命令，再重新加载/重启会话。安装器不启用 features、不绕过管理员策略。CLI doctor 不能证明 App 的能力。
2. 手动检查主机连接和凭据：
   ```sh
   node "$HOME/.local/share/agent-mission-control/adapters/amc.mjs" heartbeat
   node "$HOME/.local/share/agent-mission-control/adapters/amc.mjs" doctor
   ```
3. 在真实 App 的本地执行会话做一个无敏感内容的小任务，检查新会话、回合开始/结束等事件。自然出现审批时检查审批事件，不绕过权限。Stop/回合结束不代表整个任务完成。
4. 心跳成功但 App 无事件时，检查 hooks 的实际加载、信任及执行位置。云端/remote 任务不一定执行本机 hooks；模拟事件不能替代 App 验收。

安装成功不代表事件已上传；安装器不会自动发送心跳或 token。没有后台心跳时，空闲主机可能被推断离线，不代表关机或失败。需要持续心跳时自行明确配置 OS scheduler，参考[完整适配器说明](adapters/README-adapters.md)。

## 升级、重复安装、卸载

重复运行不会增加重复 hooks，已有连接和 token 路径原样复用；不同服务器/host/token 路径会被拒绝。升级时使用经审查的新固定版本入口以及原来的程序/state目录，程序全部校验后才替换，可能仍需重新审核 hooks。

```sh
node "$HOME/.local/share/agent-mission-control/adapters/amc.mjs" uninstall
```

只卸载精确匹配的自有 hooks/notify，保留程序、连接/token、队列和备份。确认不需要后可自行删除程序和私有 state；撤销服务端 token 独立进行。自设 cron/launchd也由你移除。自定义 state 时所有后续命令附加 `--state-dir '/your/path'`。

常规升级失败恢复旧程序。首次配置失败可能已经部分写入 hooks，因此保留已验证程序并报错，检查后重试。配置完成后元数据写入失败也不会移除程序。掉电/强制终止留下 `.install-lock` 或 `.previous-adapters` 时，先确认无安装进程、备份并检查目录，再人工恢复，不自动猜测清理。

## 发布维护

本版适配器锁定 commit `dd7c7a474651a2fd458c93e58cc36b67ec1c2998`，对应 Git tree `0d1bbab4e6aecf80b836e3db00c41caa0d96bad8`。已核对四文件 blob。入口提交与内嵌适配器提交可以不同，以避免自引用哈希。

未来发布前先确认四个本地适配器与目标提交字节一致，再 `node scripts/build-installer.mjs FULL_ADAPTER_SOURCE_COMMIT`。生成器不会声称检查过任意未来远端版本。运行 `sh -n install.sh`、typecheck、lint、test、build，授权发布后读取实际入口提交的 raw URL，验证其内容及哈希再分享安装命令。无需为入口本身改动 Worker。

测试只用隔离临时 HOME 和合成 token。云端夹具/PTY测试不替代真实 Mac、Node 20或 Codex App验收。
