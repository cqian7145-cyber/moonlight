# Staging 商家账号一次性初始化

本手册供获得明确建号授权后，由门店与 Railway 管理员共同执行。目标 Staging 入口为 `https://moonlight.xizimist.com`。本手册不授权连接或修改 Railway、数据库、DNS、GitHub 或 Cloudflare；当前没有线上建号或线上验收证据。

## 固定目标与拒绝条件

- 目标环境：Railway `moonlight` 项目的 Staging，新加坡区域；Web 入口 `https://moonlight.xizimist.com`。
- 数据库私网地址：`postgres.railway.internal:5432/railway`。禁止公开 PostgreSQL TCP Proxy。
- 目标门店：`Moonlight Staging 测试酒馆`，UUID `961b6054-e798-4c19-9bbf-a11050c55047`，仅授予 `owner`。
- 连接角色必须是短期专用 `moonlight_staging_provisioner`。禁止使用 Web 的 `moonlight_app`、Migration 角色或 PostgreSQL 管理员凭据运行 CLI。
- CLI 仅读取当前进程的 `PROVISION_DATABASE_URL`，拒绝任何非空 `DATABASE_URL` 或 `MIGRATION_DATABASE_URL`。不会读取 `.env` 文件。数据库 URL 的主机、端口、数据库、角色会在连接前校验；连接后会校验数据库、`current_user`、`session_user` 和超级用户、建角色、建库、复制、绕过 RLS 等权限标志。
- 写入必须同时具备 `NODE_ENV=production`、`--execute`、`MOONLIGHT_STAGING_PROVISION=1`、`MOONLIGHT_STAGING_PROVISION_CONFIRM=CREATE_STAGING_MERCHANT_OWNER`、交互式 TTY、两次隐藏密码输入及终端最终确认。默认模式只读 dry-run。
- Better Auth 公共注册仍关闭。建号通过 Better Auth Drizzle adapter 创建账号，自动登录和内部日志关闭。账号与门店成员关系是两个提交边界；部分失败时保留账号并按下文人工核查，工具不会删除或重置账号。

## 当前上线审查结论

当前 Web 服务不能作为建号执行环境。代码使用 `node --import tsx`，直接导入 `web/scripts/provision-merchant-staging.ts` 与 `web/src/**/*.ts`；`tsx` 是 devDependency。仓库没有 Dockerfile、Railway 配置文件或 `output: "standalone"` 声明，无法从本地源码证明已部署 Web 镜像含完整源码和 devDependency。也未连接 Railway 查看实际部署镜像。不要在 Web 容器中尝试运行 CLI。

Railway 官方 `railway ssh` 提供部署容器的交互式 shell/TTY，也能连接没有公网域名的服务；但它仅进入正在运行的部署。Cron Job 是非交互作业，不能满足 CLI 的密码隐藏输入和人工确认。可行的候选流程是单独创建一个无公网入口、手工启动、执行后立即停止并删除的临时 runner；它必须使用单独构建上下文并在构建时验证源文件和 `tsx`。启动后用 Railway SSH 交互，不使用 tmux 持久会话。

该临时 runner 与短期数据库角色尚未在真实 Railway 上验证，也没有已核准的服务规格/费用证据。因此本次审查结论为 **BLOCKED**；以下是后续获授权后的操作步骤，不代表该 runner 已创建或建号已经可执行。若 Dashboard 不支持设置 runner 的独立变量、无公网域名、手工停机/删除或稳定 TTY，立即停止，不得改用现有 Web 服务、Cron、`railway run`、命令参数密码或放宽 CLI 校验。

## 管理员一次性准备数据库角色

由数据库管理员在获授权的 Staging 私网管理路径创建临时登录角色；不要在 runner 内使用 PostgreSQL 管理账号，也不要把管理连接串复制到 runner。角色密码通过管理端的隐藏密码提示设置，并只在操作者本地密码管理器中短时保管。以下是权限范围，执行前由 DBA 对照当前 Schema 核验表名：

```sql
CREATE ROLE moonlight_staging_provisioner
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  VALID UNTIL '<填入执行开始后不超过 1 小时的北京时间>';
GRANT CONNECT ON DATABASE railway TO moonlight_staging_provisioner;
GRANT USAGE ON SCHEMA public TO moonlight_staging_provisioner;
GRANT SELECT ON TABLE public.venues, public.auth_users, public.venue_members
  TO moonlight_staging_provisioner;
GRANT INSERT ON TABLE public.auth_users, public.venue_members
  TO moonlight_staging_provisioner;
GRANT SELECT, INSERT ON TABLE public.auth_accounts
  TO moonlight_staging_provisioner;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.auth_rate_limits
  TO moonlight_staging_provisioner;
```

创建语句中的 `VALID UNTIL` 必须替换成不晚于本次操作开始后 1 小时的实际时间，避免临时账号因清理遗漏而长期可登录。在 psql 中紧接着运行 `\password moonlight_staging_provisioner`，在交互提示中设置密码；不要把明文密码写进 SQL、命令参数或工单。若管理员没有获准的私网 psql 管理入口，停止并由 DBA 提供受控流程，不得临时开放 PostgreSQL 公网端口。

Better Auth 的 Drizzle adapter 对 `auth_accounts` 执行 `INSERT ... RETURNING`，因此角色需要读取该表（包括 credential hash）；该哈希不会从 CLI 输出。Better Auth 的数据库限流需要维护 `auth_rate_limits`；建号逻辑还需读取门店/用户/成员并新增用户、凭证账户和 owner 成员关系。不要授予其他业务表写权限、Migration 权限、角色/数据库管理权限或 RLS 绕过权限。若当前 Better Auth/Schema 行为超出这组权限，应停止并重新审查权限，不要临时扩大授权。此角色只用于一次建号；完成、取消或失败核查后由 DBA 撤销并删除。

## 非专业操作者逐步执行

### 1. 先确认 Git 和服务不会被意外部署

本手册的更改尚未 Push。Railway 文档说明，绑定 GitHub 分支且开启自动部署的服务会在该分支收到新提交时自动部署；仓库当前没有配置文件能证明 Railway Dashboard 的触发分支、自动部署或 Watch Paths。准备 Push 前，项目所有者必须在 Dashboard 的 `moonlight` Staging Web 服务设置中核实连接仓库、触发分支、自动部署与路径过滤，并确认当前运行部署。若任何状态看不清，先不要 Push。不能通过当前本地仓库状态确认真实服务设置。

### 2. 创建独立临时 runner

获授权后，在 Railway `moonlight` 项目中手工新建一个临时服务，例如 `staging-merchant-provisioner-once`：

1. 选择 Staging 环境和新加坡区域，源代码选已审查的 Moonlight Git 提交，服务 Root Directory 设为 `web`。
2. Build Command 设为 `npm ci --include=dev`；Start Command 设为 `sleep 900`。这是供短时 SSH 操作的待命容器，设 Restart Policy 为 `Never`。预期 15 分钟内执行；不创建域名、不配置端口、不挂卷、不启用公共网络入口、不引用 Web/Migration 服务变量。
3. 只设置 `NODE_ENV=production`。不要创建 `DATABASE_URL` 或 `MIGRATION_DATABASE_URL`。不要把建号密码、数据库 URL、Better Auth Secret 放入 Railway Variables、源码、Build/Start Command、部署日志或命令行参数。
4. 启动后立即从容器中检查工具依赖与源文件。任一失败就停止并删除 runner：

```sh
test -f /app/scripts/provision-merchant-staging.ts
test -f /app/src/server/staging-merchant-provisioning.ts
test -f /app/src/lib/merchant-auth-core.ts
test -x /app/node_modules/.bin/tsx
cd /app
node --import tsx scripts/provision-merchant-staging.ts --help
```

Railway Root Directory 为 `web` 时工作目录应是 `/app`；若日志/容器实际路径不同，不要猜路徑，先停止并核实部署设置。`--help` 不连接数据库。

### 3. 用 SSH 打开 TTY 并确认变量隔离

操作者使用已登记且获准的 Railway SSH key。首次使用若 CLI 要求登记新密钥，先停止，由项目所有者审查后再继续。不要使用 `railway ssh --session`，因为它会建立可重连的 tmux 会话。

从已登录 Railway CLI 的本地终端进入临时服务：

```sh
railway ssh --project moonlight --service staging-merchant-provisioner-once --environment staging
```

命令参数需替换为 Dashboard 中实际项目/服务/环境选择器；若无域名服务需用 Railway Dashboard 复制的 **Service Instance ID** 明确连接目标。确认 Shell 是 TTY，然后仅输出变量名称来检查隔离，不要输出变量值：

```sh
test -t 0 && test -t 1
env | cut -d= -f1 | sort | grep -E '^(DATABASE_URL|MIGRATION_DATABASE_URL|PROVISION_DATABASE_URL)$' || true
```

预期没有三个数据库变量。若存在 `DATABASE_URL` 或 `MIGRATION_DATABASE_URL`，停止并由管理员修正临时服务变量引用，不得仅在命令前覆盖后继续。不得将 `railway run` 用于该流程，因为它会把 Railway 服务变量注入本地命令环境。

### 4. 在私有 TTY 中读入专用连接串并 dry-run

确认 DBA 已建立上面的临时角色，且连接串来自获授权的 Staging 私网渠道，主机为 `postgres.railway.internal`，数据库为 `railway`，角色为 `moonlight_staging_provisioner`。URL 只在 SSH shell 内静默读入，禁止显示、复制到命令历史或写入文件：

```sh
unset DATABASE_URL MIGRATION_DATABASE_URL
export NODE_ENV=production
read -r -s -p '输入短期 Staging 建号数据库 URL: ' PROVISION_DATABASE_URL
printf '\n'
export PROVISION_DATABASE_URL
node --import tsx scripts/provision-merchant-staging.ts --dry-run
```

CLI 会要求输入并核对门店 UUID、门店名称、商家姓名和邮箱，然后读取真实数据库检查身份、角色权限、门店状态、邮箱及 active owner。Dry-run 不问新商家密码、不写入用户、凭证或成员关系。任何值不匹配即退出，不要更换主机、角色或放宽校验。

### 5. 经单独书面授权后执行建号

只有 dry-run 输出与目标完全一致，且已获得本次具体建号的明确授权，才在同一 SSH TTY 中执行：

```sh
export MOONLIGHT_STAGING_PROVISION=1
export MOONLIGHT_STAGING_PROVISION_CONFIRM=CREATE_STAGING_MERCHANT_OWNER
node --import tsx scripts/provision-merchant-staging.ts --execute
```

CLI 会再次核对目标，并以隐藏方式要求两次输入新商家密码，最后要求终端输入 `CREATE_STAGING_MERCHANT_OWNER`。不要将新商家密码放入 shell 命令、环境变量、服务变量、工单、文档或日志。取消、断线、锁被占用、门店已有 owner、身份校验失败或邮箱已存在时停止，不要重复尝试。

### 6. 验证并清理

按获授权的只读私网查询确认恰好一个新用户、一个 credential 账户和一条目标门店 `owner/active` 关系；不要读取密码哈希、token、连接串或真实客户资料。以下查询只返回操作者刚输入的邮箱对应行，不读取密码哈希：

```sql
SELECT
  u.id AS user_id,
  u.name,
  u.email,
  count(DISTINCT a.id) AS credential_accounts,
  count(DISTINCT m.id) AS venue_memberships,
  bool_and(m.venue_id = '961b6054-e798-4c19-9bbf-a11050c55047'::uuid
    AND m.role = 'owner' AND m.status = 'active') AS target_owner_active,
  bool_and(v.status = 'active') AS venue_active
FROM public.auth_users AS u
LEFT JOIN public.auth_accounts AS a
  ON a.user_id = u.id AND a.provider_id = 'credential'
LEFT JOIN public.venue_members AS m ON m.user_id = u.id
LEFT JOIN public.venues AS v ON v.id = m.venue_id
WHERE lower(u.email) = lower('操作者输入的商家邮箱')
GROUP BY u.id, u.name, u.email;
```

预期恰好一行、`credential_accounts=1`、`venue_memberships=1`、`target_owner_active=true`、`venue_active=true`。若值不同，停止并人工核查，不删除或重跑。使用商家本人在 `https://moonlight.xizimist.com/login` 验证登录需单独授权；建号任务本身不能据 SQL 宣称 Chrome 登录已验证。

无论成功、取消或失败核查完成，都在 SSH TTY 中清理进程环境并退出：

```sh
unset PROVISION_DATABASE_URL MOONLIGHT_STAGING_PROVISION MOONLIGHT_STAGING_PROVISION_CONFIRM
unset DATABASE_URL MIGRATION_DATABASE_URL
exit
```

回到 Dashboard 后立即停止并删除临时 runner（不要仅停止 Web，也不要留下重启策略、部署或变量）；由 DBA 撤销并删除 `moonlight_staging_provisioner` 登录角色。确认 runner 无部署实例、无域名、无变量引用，角色已删除。若进程断线或执行结果不确定，先按授权只读核查数据库，再清理；不得直接重跑或删除已创建用户。

## 失败恢复与权限边界

- 邮箱已存在时不授予权限；管理员人工确认身份和门店关系，不删除账号、不重置密码、不提升角色。
- Better Auth 返回异常或连接中断时结果可能不确定；先按授权只读核查，不立即重试。
- 用户/凭证创建与成员关系写入并非一个事务。如果账号已创建而 `venue_members` 写入失败，工具保留账号；人工确认归属和目标状态后，另行审批恢复步骤。
- 建号通过 PostgreSQL advisory lock 串行化，邮箱唯一约束与 `(venue_id,user_id)` 唯一约束仍提供最终保护。无法取得锁即退出。
- 真实 Railway 部署产物、SSH TTY、短期角色权限、服务运行费和清理流程均未在本地测试中证明。任何一个前置检查不成立都应停止并报告，不得将自动化测试作为线上验收。

## 当前审查记录

- 已核实目标 Staging 域名为 `https://moonlight.xizimist.com`；本手册不再引用旧域名。
- M-015A CLI 源码依赖 `tsx` 和项目 TypeScript 源码；本地没有 `output: "standalone"`、Dockerfile 或 Railway 配置能证明 Web 容器包含它们。即使部署包含 Next 运行时，也不能据此假定 CLI 能执行。
- CLI 已限制 `PROVISION_DATABASE_URL`，拒绝非空 `DATABASE_URL` / `MIGRATION_DATABASE_URL`，且要求私有主机、目标 DB、专用角色和非高权限身份。环境变量名隔离不代表数据库账号自动隔离；临时 `moonlight_staging_provisioner` 角色是实际执行的必要条件。
- 当前 Git 分支为 `main`，远端 `origin/main` 与 M-015A 提交相同；本地新增手册修改 Push 前仍须检查部署触发设置。Railway 官方说明：绑定 GitHub 分支且启用 Autodeploy 时，该分支收到推送会触发部署；本地仓库无法确认 Dashboard 的实际开关、监听分支、Watch Paths 或当前 Web 运行版本。
- Railway SSH 依据官方文档可为运行中的部署打开交互 shell/TTY，也可通过 Service Instance ID 访问无公网域名的服务。该能力说明不代表临时 runner 已实际创建或验证。

参考：[Railway SSH](https://docs.railway.com/cli/ssh)、[Railway GitHub Autodeploys](https://docs.railway.com/deployments/github-autodeploys)、[Railway Start Command](https://docs.railway.com/deployments/start-command)。
