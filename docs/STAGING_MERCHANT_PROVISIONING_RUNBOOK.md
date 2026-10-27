# Staging 商家账号一次性初始化

本手册只供获得明确 Staging 建号授权后执行。本地代码任务和 PGlite 测试不会连接 Railway。不得运行 `railway up`、创建临时服务、开放 TCP Proxy、配置域名或修改 DNS。

## 固定目标与拒绝条件

- 数据库主机：`postgres.railway.internal`，端口 `5432`，数据库 `railway`，连接角色 `moonlight_app`。
- 目标门店：`Moonlight Staging 测试酒馆`，UUID `961b6054-e798-4c19-9bbf-a11050c55047`，仅授予 `owner`。
- 工具不读取 `.env.local`，只接受进程中的 `PROVISION_DATABASE_URL`。必须先移除继承的 `DATABASE_URL` 与 `MIGRATION_DATABASE_URL`；工具发现任一非空变量就会拒绝运行。
- URL 中的主机、数据库、用户名必须与上述值精确匹配；连接后再用 `current_database()`、`current_user`、`session_user` 和 PostgreSQL 角色权限标志复核数据库身份，拒绝超级用户、建角色、建库、复制或绕过 RLS 权限。这些独立校验不会替代 Railway 项目、环境、私网及门店状态的人工核对。
- 写入条件：`NODE_ENV=production`、`--execute`、`MOONLIGHT_STAGING_PROVISION=1`、`MOONLIGHT_STAGING_PROVISION_CONFIRM=CREATE_STAGING_MERCHANT_OWNER`、TTY 最终确认以及隐藏密码输入全部通过。默认模式是只读 dry-run。
- Better Auth 公共 `sign-up/email` 路由仍关闭。CLI 使用 Better Auth 1.7.12 的 `auth.api.signUpEmail()`，自动登录关闭、Better Auth 内部日志关闭；账号/凭证创建由 Better Auth Drizzle adapter 的事务包裹。账号创建与门店成员关联是两个提交边界，不宣称为原子操作。

## 执行入口

Railway 当前文档说明 `railway ssh` 可进入已部署服务容器的交互式 shell，并自动检测 TTY。只在人工确认目标是现有 Staging Web 服务后，通过 Railway Dashboard 提供的 SSH 入口进入；不要借用生产服务。如果入口首次要求登记 SSH key，先停止并由服务所有者审查该账户变更，不要为了本操作擅自登记。

该方式不会创建新的 Railway 服务或对外域名。执行前确认服务处于 Staging 环境、新加坡区域、访问仍受 Cloudflare Access/Tunnel 保护，PostgreSQL 没有公开 TCP Proxy。由于 Web 容器可能继承应用数据库变量，必须在当前 SSH shell 中取消它们。应用进程环境不受 shell 的 `unset` 影响。

先确认部署包确实包含本工具和 `tsx`，并只执行 help（不读数据库）：

```sh
test -f /app/scripts/provision-merchant-staging.ts
test -x /app/node_modules/.bin/tsx
cd /app
node --import tsx scripts/provision-merchant-staging.ts --help
```

若源文件、`tsx` 或交互式 TTY 不可用，立即停止。不得通过 `railway run` 把数据库变量注入本机进程，不得把密码放入命令参数、环境配置变更、部署设置、工单或日志。需要另行设计和审查可交互的一次性执行环境后再继续。

## 只读 dry-run

从 Railway 私网变量管理界面安全取得现有 Staging `moonlight_app` 连接串；不要打印、复制进命令行或写入文件。已有控制台值必须由操作者按平台的秘密显示流程查看。

在 `/app` 的 SSH TTY 中逐行输入：

```sh
unset DATABASE_URL MIGRATION_DATABASE_URL
export NODE_ENV=production
read -r -s -p 'Staging moonlight_app URL: ' PROVISION_DATABASE_URL
printf '\n'
export PROVISION_DATABASE_URL
node --import tsx scripts/provision-merchant-staging.ts --dry-run
```

CLI 会再次要求核对固定门店 UUID、名称、商家姓名和邮箱，然后验证数据库身份、门店状态、邮箱及现有 owner。dry-run 不询问密码，也不写入用户、凭证或成员关系。任一目标与实际不符时退出，不调整门禁重试。

## 经授权后的正式建号

只有 dry-run 输出匹配预期，且操作者已取得明确书面授权，才在同一个仍然打开的 SSH TTY 中继续。不要关闭后重新输入数据库 URL：

```sh
export MOONLIGHT_STAGING_PROVISION=1
export MOONLIGHT_STAGING_PROVISION_CONFIRM=CREATE_STAGING_MERCHANT_OWNER
node --import tsx scripts/provision-merchant-staging.ts --execute
```

CLI 会重新检查目标，再要求输入密码和确认密码（均不回显），最后要求准确输入 `CREATE_STAGING_MERCHANT_OWNER`。取消、断线、锁被占用、门店已有 owner、数据库身份错误或邮箱已存在时会停止。不要把密码加入任何 shell 命令或回显输出。

## 只读验收

先准备只读语句，再用操作者输入的邮箱执行；结果包含该账号的所有门店成员关系，因而不会隐藏意外的跨店关联。查询只返回凭证存在标记，不读取密码哈希、token 或密码。不要从 SQL 客户端复制连接串到命令历史。

```sql
PREPARE inspect_staging_merchant(text) AS
SELECT
  u.id AS user_id,
  u.name,
  u.email,
  a.provider_id,
  (a.password IS NOT NULL) AS has_credential_hash,
  m.venue_id,
  m.role,
  m.status AS membership_status,
  v.status AS venue_status
FROM auth_users AS u
JOIN auth_accounts AS a ON a.user_id = u.id AND a.provider_id = 'credential'
JOIN venue_members AS m ON m.user_id = u.id
JOIN venues AS v ON v.id = m.venue_id
WHERE lower(u.email) = lower($1);

EXECUTE inspect_staging_merchant('商家邮箱');
DEALLOCATE inspect_staging_merchant;
```

验收应恰好返回一行，`has_credential_hash=true`、`role=owner`、`membership_status=active`、`venue_status=active`。登录、`/admin` 权限、登出和旧会话失效属于之后单独授权的真实 Chrome 验收，不得仅凭 SQL 宣称通过。

## 失败恢复

- 邮箱已存在时不授予权限；人工查明账号和其已有门店关系，不删除账号、不重置密码、不提升角色。
- Better Auth 返回异常或连接中断时，建号提交结果可能不确定；先按只读 SQL 检查 `auth_users` 与 `auth_accounts`。不要立即重复执行。
- 若账号已经创建而 `venue_members` 插入失败，本工具会保留账号并报告部分失败，不执行回滚删除。由授权管理员复核账号归属、目标门店状态和是否已有成员关系，再单独决定是否人工插入 owner 关系。
- 并发调用由单数据库 session 的 PostgreSQL advisory lock 串行化；邮箱唯一约束与成员 `(venue_id,user_id)` 唯一约束仍是最后保护。锁拿不到就退出，不等待或强制释放他人锁。

## 结束清理

完成或取消后，在同一 shell 运行：

```sh
unset PROVISION_DATABASE_URL MOONLIGHT_STAGING_PROVISION MOONLIGHT_STAGING_PROVISION_CONFIRM
unset DATABASE_URL MIGRATION_DATABASE_URL
exit
```

本工具不创建服务、持久会话、部署变量或自动重启任务。SSH 会话关闭后确认 CLI 进程已退出；不要保留 `--session` tmux 会话。若遇到运行中断，先只读核对数据库再关闭会话。

## 当前执行状态

本文件是预备操作手册。没有连接或修改 Railway 数据库，也没有线上建号或浏览器验收证据。现有 Staging 资源、域名（历史材料出现 `staging.xizimist.com` 和 `moonlight.xizimist.com` 两种写法）、Railway 服务标识、部署包是否包含 `tsx` 和当前数据库成员状态均须在获得后续授权后重新核实。

Railway 交互终端说明：[railway ssh](https://docs.railway.com/cli/ssh)。`railway run` 会把服务变量注入本机命令环境，因此本手册不使用该入口：[railway run](https://docs.railway.com/cli/run)。
