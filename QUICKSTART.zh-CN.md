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

另开一个终端执行下列命令，即可写入三台合成主机及多种任务状态：

```sh
npm run simulate
```

示例数据经真实鉴权上报接口写入本地 D1，刷新页面不会消失。正式使用不依赖示例数据。不运行 simulate 就是空白控制台。

## Codex 接入

完整可执行安装／卸载命令见 adapters/README-adapters.md。先从受保护的管理员界面/接口注册一台主机，把一次性返回的主机凭证存到该机器私有文件，再运行适配器安装命令。凭证不要放进聊天、Git 或公开日志。

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

通过私有GitHub仓库与Actions发布，请按 [GitHub Actions手动部署](DEPLOY.zh-CN.md) 设置production环境、Secret和Variables。PR只检查，不部署。

本交付未自动登录 Cloudflare，未创建公开站点。README.md 列出 D1、Workers Static Assets、Cron、Cloudflare Access 的部署步骤。必须先配置 Access 并让服务端验证 JWT，再部署站点；生产配置缺失时系统默认拒绝访问。

Dashboard 与读／管理 API 使用 Access 身份；/api/events 使用独立且可撤销的主机凭证。不要把所有 /api/* 都设为 Access 绕过，只对确切的上报路径按文档配置。

## 验证命令

```sh
npm run typecheck
npm run lint
npm test
npm run build
# 本地 Worker 已运行后：
npm run test:integration
```

具体已通过的测试、原生 CLI 与云部署的未验证项，见 VERIFICATION.md。源码包不包含本地数据库、真实凭证或任何用户对话。
