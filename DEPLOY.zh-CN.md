# GitHub Actions 手动部署

目标私有仓库：`zxdvd/agent-mission-control`。源码已准备工作流；**尚未运行 GitHub Actions，也未部署 Cloudflare**。以下设置由你在自己的账号中完成，凭证不要发到聊天或写入仓库。

## 1. 先准备 Cloudflare

1. 在自己的 Cloudflare 账号准备 Worker `agent-mission-control` 和 D1 数据库 `mission-control`。复制 Account ID、D1 Database ID。
2. 为最终 Dashboard 地址配置 Cloudflare Access，只允许你指定的人登录。记下团队域名（形如 `your-team.cloudflareaccess.com`）和该应用的64位十六进制 AUD。
3. 只给确切的 `/api/events` 路径配置浏览器登录例外，不能笼统绕过 `/api/*`。上报路径仍由应用自己的每主机token鉴权。
4. 核对最终访问地址、Access策略和管理员邮箱。不要在设置不明时勾选“Access已配置”。工作流只校验配置格式，不能代替实际Access策略验收。

应用使用 Workers Static Assets，不是 Pages。配置缺失/错误时，应用服务端默认拒绝未认证请求。所有资产先经过 Worker 鉴权；预览版本URL在生产配置中关闭。此工作流不创建Access应用、主机凭证或账号授权，也不自动变更DNS/自定义域名。

## 2. GitHub 配置（production 环境）

在仓库 `Settings → Environments` 创建 `production`，将允许部署的分支限定为 `main`。如果你的GitHub套餐支持该私有仓库的required reviewers，启用审批。保护main，要求审查工作流和部署脚本的变更。

在该 environment 的 **Secrets** 添加：

- `CLOUDFLARE_API_TOKEN`：有范围限制的Cloudflare部署token。仅用户在GitHub安全表单里输入；不放进Variables、代码、issue、PR或聊天。

在同一 environment 的 **Variables** 添加以下五项：

- `CLOUDFLARE_ACCOUNT_ID`：32位十六进制账号ID。
- `D1_DATABASE_ID`：已创建的数据库UUID，不能保留全零占位值。
- `ACCESS_TEAM_DOMAIN`：例如 `your-team.cloudflareaccess.com`，不要带协议或路径。
- `ACCESS_AUD`：Access应用的64位十六进制audience值。
- `ADMIN_EMAILS`：管理员邮箱；多个邮箱用英文逗号分隔。

这些Variables是服务端配置/标识，不是登录密码或API密钥；管理员邮箱仍属于应谨慎处理的账号信息。应用会将`LOCAL_DEV`强制设置为`false`，忽略外部同名覆盖。Cloudflare API token只提供给部署工具，不打包进React，也不写入Worker配置。

建议先由你完成资源初始化，再给持续部署token仅授该Worker的Editor权限。仅绑定现有D1不需要额外D1权限；**执行数据库migration需要相应D1写权限**。首次创建Worker需要Workers产品Admin，应与后续部署权限分开。此工作流没有自定义域名/Route写操作，无需为它默认放开所有Zone、DNS或Access管理权限。按你的账号实际权限页面选择最小范围；不要用Global API Key。

## 3. CI 与发布动作

- push到main、面向main的PR：只执行`npm ci → typecheck → lint → test → build`，不使用Cloudflare凭证，不部署。
- 发布：仓库`Actions → Deploy production (manual) → Run workflow`，选择`main`。
- 输入`DEPLOY`；确认已配置Access。
- 首次上线或有经审查的待执行SQL时，勾选`apply_migrations`。其他发布保留false。
- 等待校验job通过，若设置了environment reviewer，再完成生产审批。

工作流锁定触发时的commit SHA，并再次build该commit；不会从PR产物中取可执行内容。仅指定仓库的main允许发布；fork、PR、其他分支不会进入部署。并发生产发布不会互相取消，避免在迁移中途被后续run打断。第三方actions均固定到已核验的commit SHA。

实际命令（由workflow运行，不需要把token写进命令）：

```sh
node scripts/prepare-deploy.mjs
# 仅显式勾选时执行：
npx --no-install wrangler d1 migrations apply mission-control --remote --config .wrangler.deploy.json
npx --no-install wrangler deploy --config .wrangler.deploy.json
```

临时`.wrangler.deploy.json`不含API token、不会提交，最后清理。Secret只在需要认证的步骤注入，不提供给依赖安装、测试或前端build。

**迁移不是原子回滚部署。** 先审查SQL、确认Cloudflare备份/恢复方案；迁移成功而Worker部署失败时数据库可能已经改变。工作流不自动删除数据库或回滚迁移。首次不执行初始migration会导致应用数据库接口失败，不应标记上线成功。

输入确认不匹配、Access未勾选、不是main/目标仓库时job会跳过。跳过不等于部署成功。缺Secret/Variables则终止，不使用本地绕过或自动创建替代凭证。

## 4. 上线后验收

1. 无登录访问Dashboard及读/管理API应被Access拦截或应用返回401。
2. 允许用户登录后页面能读取D1，管理员可调用注册主机API。
3. 普通reader不能改任务、处理收件箱或管理主机凭证。
4. Agent只能通过独立主机token上报，不能读取Dashboard或冒用其他host。
5. 检查任务更新、Cron推断、凭证撤销和手机/桌面实际布局。

主机token不要放GitHub Actions。部署后由Access管理员调用`POST /api/admin/hosts`生成，每台机器单独保存；D1只存hash。具体安装见`adapters/README-adapters.md`。部署token、Access用户身份、主机上报token是三个独立用途。

## 官方参考

- [GitHub Actions workflow语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [Cloudflare GitHub Actions部署](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Cloudflare最小权限与资源范围](https://developers.cloudflare.com/workers/authorization/)

本地已校验YAML、配置生成保护、typecheck/lint/build和自动测试；没有使用真实Secret执行远端migration或部署。真实Actions结果需首次推送/授权运行后确认。
