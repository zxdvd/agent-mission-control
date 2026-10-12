# 独立密码登录：GitHub Actions 手动部署

目标仓库：`zxdvd/agent-mission-control`。当前是公开源码；GitHub Free 可使用公开仓库的 environments、environment secrets、分支限制与 required reviewers。**源码公开不等于监控数据公开。** 本版本不依赖 Cloudflare Access；Dashboard 使用自己的固定用户名和密码登录，上报使用每台主机独立的固定 Token。未自动部署，也未生成真实凭证。

**Cloudflare 运行额度需单独确认：** Workers Free 当前每次请求 CPU 限额为10ms，PBKDF2 登录校验可能超出。GitHub Free 支持生产环境不代表 Cloudflare Free 一定能运行密码校验。首次上线必须测试实际登录是否触发 CPU 超限；如需付费方案，先由你决定，代码不会自动升级或降低密码校验强度。见[官方 CPU 限额](https://developers.cloudflare.com/workers/platform/limits/)。

## 1. 准备资源与三个 GitHub Variables

1. 在自己的 Cloudflare 账号准备 Worker `agent-mission-control` 和 D1 数据库 `mission-control`，复制 Account ID 与 D1 Database ID。
2. GitHub 仓库 `Settings → Environments → New environment` 创建 `production`。
3. `Deployment branches and tags → Selected branches and tags`，仅添加 **Branch: main**，不添加 tag 或通配符。可加 required reviewers；单人操作时不要启用会阻止自己审批的 Prevent self-review。保护 main 并审查工作流修改。
4. 在此 environment 的 Variables 添加：`CLOUDFLARE_ACCOUNT_ID`（32位hex）、`D1_DATABASE_ID`（数据库UUID）、`DASHBOARD_USERNAME`（自选固定用户名，1–64个ASCII字母/数字/下划线/点/短横线，首位必须字母或数字，区分大小写）。工作流将用户名写入同名 Worker variable；请在 GitHub production Variables 修改它，不要只在 Cloudflare UI 改一个会被后续部署覆盖的值。用户名无需放Secret。不需要 Access 域名、AUD 或管理员邮箱。

若未来把仓库改回私有，个人需要 Pro，组织需要 Team/Enterprise 等支持套餐，才能使用 environment secrets/部署分支限制；Pro/Team 私有仓库不支持 required reviewers。功能缺失时先停止配置，不自动升级、不把环境 Secret 降级到仓库层。

## 2. 配置三个 Worker Secrets（由你输入）

这些是 **Cloudflare Worker 的 Secrets**，不是 GitHub Variables。可在 Worker 的 `Settings → Variables and Secrets` 添加类型为 Secret 的项，或由你在受信任的终端使用 `wrangler secret put <名称>` 的交互输入。不要把真实值写进代码、聊天、Issue、命令参数或截图。`wrangler secret put` 会创建并立即部署新的 Worker 版本；首次设置或轮换 Secrets 都是影响线上运行的操作，应由你在确认目标后执行，不能当成无副作用的预填步骤。

- `DASHBOARD_PASSWORD_HASH`：由 `node scripts/password-hash.mjs` 使用标准 PBKDF2 生成的密码校验串；按脚本提示输入至少8字符、最多1024 UTF-8字节的独享密码；建议避免常见口令。服务器仅配置校验串，不保存明文密码。
- `SESSION_SECRET`：至少32字符的独立高熵随机秘密，用于签名登录会话。不得与密码或 Agent Token 复用。
- `AGENT_TOKENS_JSON`：固定主机凭证列表，结构如下（仅结构模板，不能原样使用）：

```json
[{"host_id":"host-one","name":"My workstation","token_hash":"<该主机高熵Token的SHA-256小写hex摘要>"}]
```

每台主机单独生成至少32字节随机 Token；明文仅保存到对应适配器私有文件。`node scripts/token-hash.mjs` 从标准输入读取 Token，输出 SHA-256 摘要，不把明文放进参数。Worker Secret 中只放摘要。第一次合法上报自动创建主机监控记录；不再需要注册主机 API。空列表 `[]` 可以暂时禁用全部上报。

这是单个固定账号的个人 MVP：知道用户名和密码的人拥有同一管理权限，没有独立用户、只读角色、MFA 或个人审计归属。只与完全信任的人共享；需要分级团队协作时不要直接扩展共用密码人数。

用户名和密码均需匹配；错误统一显示登录凭据无效，不提示是哪一项错误。修改用户名会使旧会话失效。没有注册入口或多用户管理。

密码校验使用 WebCrypto PBKDF2-SHA256（Workers运行时迭代上限见脚本及安全说明）；强长密码和登录限流很重要。需要更强专用身份系统时应另行设计，而非把此 MVP 当企业身份服务。

**轮换与撤销：** 改密码校验串或会话签名 Secret 会使旧会话失效。退出登录撤销当前会话。单台主机换 Token：替换该 host 的 token_hash 并更新该主机本地文件；撤销：从 Secret 列表删除该 host。监控历史保留，不需要换 host ID。配置变更传播完成后旧 Token 被拒绝；不要承诺全球瞬时生效。

缺失或非法生产配置默认拒绝受保护访问，不会切换为开发模式。`LOCAL_DEV` 由部署脚本强制为 false。登录页可以公开，监控数据、读写 API 和 Dashboard 静态资产仍受服务器认证保护。若账号以前配置过 Access 门禁，本代码不会自动修改那些安全设置；外部门禁仍可能先拦截请求，需要你另行确认处理。

## 3. 配置 GitHub 部署 Secret

在 `production` environment 的 Secrets 添加 `CLOUDFLARE_API_TOKEN`。这只是部署凭证，不是登录密码，也不是主机 Token。

建议先完成资源初始化，再在 Cloudflare `Manage account → Account API tokens → Create Token` 创建 account-owned token。当前 Wrangler 细粒度权限要求这种 Token。只给已存在的 `agent-mission-control` Worker Editor 权限；绑定现有 D1 不需额外 D1 权限，但执行 migration 需要 D1 写权限。首次创建 Worker 需要 Workers 产品 Admin，应与持续部署权限分开。本工作流不设置 DNS、Route 或 Access，无需默认授权所有 Zone/DNS/Access。不要使用 Global API Key。

工作流只把部署 Token 注入需要认证的步骤，不注入 npm install、测试、前端 build，也不写进生成的配置。三个应用 Worker Secrets 由你单独设置，工作流不自动创建、读取或覆写它们。

## 4. 手动发布

1. `Actions → Deploy production (manual) → Run workflow`，选择 main。
2. 输入 `DEPLOY`，勾选已配置 Worker 身份 Secrets。
3. 首次上线或新增经过审查的迁移时勾选 `apply_migrations`（默认 false）。本次密码版本有会话/登录限流迁移，升级旧版本也要执行待迁移 SQL。`0002_password_sessions.sql` 会删除旧的 `host_credentials` 表（只移除已停用的旧摘要，不删主机/任务历史）；旧 Token 不会自动迁入新配置，必须先准备 `AGENT_TOKENS_JSON`。
4. 等校验通过，再完成你设置的 production 审批。

push/PR 只跑 CI；不会自动部署。生产只允许指定仓库 main，锁定触发 commit SHA，串行发布不相互取消。第三方 Actions 固定 commit。工作流中的确认只证明你确认了设置，不能替代真实线上验收。

工作流执行：

```sh
node scripts/prepare-deploy.mjs
# 仅显式勾选时：
npx --no-install wrangler d1 migrations apply mission-control --remote --config .wrangler.deploy.json
npx --no-install wrangler deploy --config .wrangler.deploy.json
```

迁移成功但发布失败时数据库可能已经改变；不保证原子回滚。先审查 SQL 和备份/恢复方案。临时配置不含凭证，使用后清理；缺少 Variables/部署 Secret 会停止，绝不创建替代凭证。线上缺少应用 Secrets 时认证失败，不能标为部署验收成功。

## 5. 上线验收

- 未登录访问页面跳转登录；未登录读写 API 返回401，不能读取监控数据。
- 错误密码拒绝；重复尝试触发限流；正确密码登录后可读 D1。
- 跨站和缺少 CSRF 的修改拒绝；退出后旧 Cookie 无法重用。
- 主机 Token 只能向 `/api/events` 为自己的 host 上报，不能访问 Dashboard。
- 从固定配置删除 host 或轮换 Token 后旧凭证被拒绝；密码轮换后旧会话失效。
- 核对手机/桌面实际布局、7秒刷新、任务/收件箱、Cron；本地 DOM 测试不等于生产浏览器验收。

## 官方参考

- [GitHub环境资格及保护规则](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Cloudflare Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare最小权限](https://developers.cloudflare.com/workers/authorization/)
- [Cloudflare账号级Token](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)

## D1 首次迁移报 `incomplete input` 时

本项目的初始迁移包含两个完整触发器。Wrangler 本地执行先拆分 SQL，远端 migrations 则把整份 SQL 与迁移记录 INSERT 交给 D1 `/query`；本地成功不能证明远端解析成功。兼容修复仅将触发器保持为单行并给 CASE 表达式加括号，不改变表结构或事件状态逻辑；Git 强制 SQL 使用 LF。

重试前，在目标 D1 Console **分两次**执行只读检查：

```sql
SELECT name FROM d1_migrations ORDER BY id;
```

```sql
SELECT type, name FROM sqlite_master ORDER BY type, name;
```

若 ledger 为空且只有 Cloudflare/SQLite/迁移记录表，没有 hosts/tasks/events 等项目对象，可使用修复后的 main 再显式执行待应用迁移。若已经有项目表、触发器或已应用记录，先核查实际状态，不删库、不清空 ledger，不把“没有显示结果”当成回滚证明。失败的旧 Actions run 绑定旧提交；应在确认后从修复后的 main 发起新的手动发布，不重跑旧提交。

这些查询只检查结构与迁移记录，不读取任务内容。仓库回归验证了真实本地解析/执行兼容性；最终远端是否接受仍以你批准的新部署结果为准。

参考：[Cloudflare CASE/END 解析问题](https://github.com/cloudflare/workers-sdk/issues/4727)、[单行 trigger 兼容办法](https://github.com/cloudflare/workers-sdk/issues/4998)、[当前远端多行解析报告](https://github.com/cloudflare/workers-sdk/issues/15690)。
