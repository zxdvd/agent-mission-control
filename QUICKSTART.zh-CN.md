# Agent Mission Control：快速开始

这是只监控、不远程控制 Agent 的个人控制台。优先支持 Codex，兼容 Claude Code；首版不包含 OpenCode 适配器。

## 本地启动

先安装 Node.js 22 或更新版本，然后在解压后的项目目录运行：

```sh
npm ci
cp .env.example .dev.vars
npm run db:migrate
npm run build
npm run dev:worker
```

打开 http://127.0.0.1:8787。请保持监听地址为本机回环地址，不要把开发模式通过公网隧道暴露出去。

默认启动显示空白控制台。需要合成主机示例时，按 README 的“Synthetic local integration data”流程使用隔离的 `.dev.vars.test`、`.env.test-hosts` 和本地测试数据库。正式使用不依赖示例数据。

## Codex 接入

完整可执行安装／卸载命令见 adapters/README-adapters.md。先为每台主机准备独立固定 Token，将 SHA-256 摘要配置到 Worker Secret `AGENT_TOKENS_JSON`，明文存到该机器私有文件，再运行适配器安装命令。凭证不要放进聊天、Git 或公开日志。

默认 notify 模式只观测“一轮回答结束”。不能据此知道审批、任务开始或任务成功。增强 lifecycle hooks 必须由你在安装版本支持的前提下明确准备，并在 Codex 的 /hooks 中审核信任。安装器不绕过这个步骤，也不悄悄覆盖已有通知脚本。

无需常驻自有 daemon。可选择前台 wrapper 或手动配置操作系统定时心跳；没有这些机制时，偶发 hook 的沉默只能解释为“最后事件较早／状态未知”。休眠或断网不会被擅自判成任务失败。

## 状态怎么读

- 主机在线：最近收到上报，不代表模型正在工作。
- Running / Idle：活动状态。回答停止进入 Idle，不自动完成任务。
- Attention：实际观测的审批、输入等待或失败；推测的 stale/offline 单独标明。
- Completed / Failed：只能来自明确的任务结果事件。
- 已读／忽略：整理收件箱，不会批准工具权限或回复 Agent。
- 新运行／重试：展示上报历史，不会启动远程执行。

## Cloudflare 部署

按 [GitHub Actions手动部署](DEPLOY.zh-CN.md) 设置 production 环境、部署 Secret 和三个 Variables（账号ID、D1 ID、DASHBOARD_USERNAME）。当前公开仓库可用 GitHub Free；PR 只检查，不部署。

本版本使用独立固定用户名和密码登录（密码至少8字符），不使用 Access。三个应用 Worker Secrets 是 `DASHBOARD_PASSWORD_HASH`、`SESSION_SECRET`、`AGENT_TOKENS_JSON`。登录用户拥有共享管理员权限；每台主机的固定 Token 只能上报，不能访问 Dashboard。缺少生产配置默认拒绝访问。修改密码/会话密钥会失效旧登录，修改或删除 host 的 Token 摘要会轮换/撤销该主机上报权限。

## 验证命令

```sh
npm run typecheck
npm run lint
npm test
npm run build
# 本地 Worker 已运行后：
node --env-file=.env.test-hosts scripts/integration.mjs
```

具体已通过的测试、原生 CLI 与云部署的未验证项，见 VERIFICATION.md。源码包不包含本地数据库、真实凭证或任何用户对话。
