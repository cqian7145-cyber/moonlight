# Moonlight

Moonlight V1 面向大学城社交型小酒馆：不依赖大屏，顾客扫描桌面二维码即可在手机 H5 里随时轻互动。当前支持个人模式与双方自愿加入的双人默契挑战。

## 技术栈

- Next.js 16.x App Router、React、TypeScript、Tailwind CSS
- Node.js 24.x
- 数据模型采用 PostgreSQL + Drizzle；SQL 迁移由 Drizzle Kit 生成并纳入版本控制
- 数据库集成测试在进程内 PGlite 执行，不依赖 Docker；PGlite 不是生产存储

## 本地开发

```powershell
New-Item -ItemType Directory -Force D:\moonlight\.cache\npm, D:\moonlight\.tmp | Out-Null
$env:npm_config_cache = 'D:\moonlight\.cache\npm'
$env:TEMP = 'D:\moonlight\.tmp'
$env:TMP = 'D:\moonlight\.tmp'
Set-Location D:\moonlight\web
npm ci
npm run dev
```

访问 <http://localhost:3000>。开发依赖、npm 缓存和构建产物位于仓库及其 `.cache`、`.tmp` 目录中。

## 当前能力

- 首页介绍“酒馆扫码即玩”，可进入个人趣味题演示。
- `/t/<tableCode>` 是正式只读桌码入口：校验哈希桌码并读取门店当前有效上架活动；需要配置 PostgreSQL `DATABASE_URL`，本地没有默认样例数据。
- 顾客点击「自己玩」后，`POST /api/attempts/start` 创建或恢复匿名个人参与；`GET /api/attempts/current?tableCode=<tableCode>` 通过 HttpOnly Cookie 读取状态。接口不接收客户端 Attempt/Venue/Publication ID，不返回会话令牌或答案。
- `/play/<tableCode>` 从 Attempt 绑定的不可变题包读取三题；`POST /api/attempts/answer` 逐题保存并由第三个有效答案完成参与；`GET /api/attempts/result` 仅向本人返回确定性个人趣味结果。刷新后依据服务端进度恢复，不使用本地假记录。
- `/play/together/<tableCode>` 从有效桌码发起两人挑战；房主分享 `/join#invite=<secret>` 邀请链接，受邀者在确认门店与玩法并主动同意后加入。双方使用 `/api/play-groups` 下独立的 HttpOnly 会话、读取同一绑定题包、各自提交三题；仅双方完成后才可读取共同结果。房间最多两人，邀请约 15 分钟失效。
- 双人 API：`POST /api/play-groups` 创建；`POST /api/play-groups/invitation` 只读预览邀请；`POST /api/play-groups/join` 加入；`GET /api/play-groups/current`、`questions`、`result` 读取本人状态/题目/揭晓；`POST /api/play-groups/answer` 与 `leave` 提交答案和退出。个人 Cookie `moonlight_attempt` 保持 `/api/attempts` 路径；双人 Cookie `moonlight_group_attempt` 限于 `/api/play-groups`，两者不能互相授权。
- `/play/demo` 仍提供三道独立的本地演示题和确定性趣味结果，不读写数据库。
- `/login` 是受控开通账号的商家登录页；公众注册关闭。`/staff` 仅提供授权门店只读访问；`/admin` 限 owner 使用。M-011 提供题包编辑、活动上架和桌码管理；M-012 提供真实 SQL 经营汇总及自愿评分。
- 商家认证使用 Better Auth 1.7.12 与 Drizzle PostgreSQL adapter，登录 Cookie 与顾客个人/双人 Cookie 相互独立。`venue_members` 对每个门店/用户组合保存 owner/staff 角色及 active/disabled 状态；页面和 `/api/merchant/venues` 每次请求都从服务器会话及数据库 membership 校验权限。
- 商家测试账户可通过仅本地运行的 `web/scripts/provision-merchant-local.ts` 受控创建；该工具只接受 `127.0.0.1`/loopback 的 `moonlight_dev`（55432）数据库、要求交互输入密码和显式确认，生产环境及公开 HTTP 注册端点不可建号。开发者自行设置未跟踪的 `BETTER_AUTH_SECRET`（至少 32 字符）和 `BETTER_AUTH_URL`；部署需 HTTPS 和独立管理密钥。
- `/api/health` 提供不依赖数据库的健康检查。
- `web/src/db/schema.ts` 定义 9 张顾客游戏表和 6 张认证/门店成员表；M-010 仅通过新的 Drizzle SQL migration 扩展 Schema，不改写旧迁移。M-009 继续复用 M-005 的 PlayGroup、Attempt、Submission 事务。
- 个人 Cookie 名为 `moonlight_attempt`，HttpOnly、SameSite=Lax、Path=`/api/attempts`、30 天有效。双人 Cookie 名为 `moonlight_group_attempt`，HttpOnly、SameSite=Lax、Path=`/api/play-groups`，与房间 15 分钟有效期一致。生产响应设 Secure（生产部署应使用 HTTPS），开发模式的本地 HTTP 不设 Secure。写请求要求 Origin 与入站 Host/协议同源，缺少 Origin 时拒绝。
- `web/drizzle/` 保存迁移。可运行 `npm run test:db` 验证迁移和 PostgreSQL 约束，无需配置数据库。
- `npm run db:migrate:local` 仅接受 loopback PostgreSQL URL；它不会启动数据库。没有生产迁移命令。

### M-013 安全边界

- 个人、双人和商家凭证相互独立；商家角色、账号状态和门店成员关系每次由服务端复核。公开写接口要求配置 origin 同源，并使用 PostgreSQL 原子计数限流；限流键不保存原始 IP 或匿名 token。
- `venues.status = suspended` 可阻止该门店的新参与及现有参与的敏感读写；正常活动下架仍保留已开始参与的冻结版本。轮换桌码阻止旧码创建新参与，不撤销进行中的个人/双人会话。
- M-013R2 已校准本地可信 Origin，并完成真实 Chrome＋D 盘 PostgreSQL 全链路安全回归及质量门禁。公网发布仍受依赖审计、TLS/可信代理 IP、可审计紧急停用和隐私保留政策等条件限制。具体证据见 [安全审查](docs/SECURITY_REVIEW.md)、[测试矩阵](docs/TEST_MATRIX.md) 和 [发布阻断](docs/RELEASE_BLOCKERS.md)。

### M-014 受限部署与发布门禁

- 当前只完成本地部署方案、D 盘隔离 PostgreSQL Migration 与备份恢复演练；**没有远程 staging 或公网服务**。相关文档：[部署方案](docs/DEPLOYMENT_PLAN.md)、[环境变量矩阵](docs/ENVIRONMENT_MATRIX.md)、[备份恢复手册](docs/BACKUP_RESTORE_RUNBOOK.md)、[隐私与保留草案](docs/PRIVACY_AND_RETENTION_DRAFT.md)、[验收矩阵](docs/STAGING_ACCEPTANCE.md)。
- 本地构建和 localhost Chrome 不等于 HTTPS、供应商访问控制或代理入口已通过。公网开放继续受 `docs/RELEASE_BLOCKERS.md` 中 P0/P1 项限制。

### D 盘隔离 PostgreSQL 验收

本机验收实例使用 PostgreSQL 18.6 EDB 官方免安装二进制 ZIP，仅监听 `127.0.0.1:55432`，不注册 Windows 服务；工具、数据、日志和本地凭证分别保存在被忽略的 `.tools/`、`.local/` 和 `web/.env.local` 中。开发应用账号 `moonlight_app` 仅拥有本地 `moonlight_dev` 数据库，不是超级用户；主机连接使用 SCRAM。

首次配置只在本机进行，不应把数据库目录、`web/.env.local` 或 `.local/m007b-fixture.json` 提交到 Git。实例启停和 M-007B 假数据可按以下方式操作：

```powershell
$pg = 'D:\moonlight\.tools\postgresql-18.6\pgsql\bin'
& "$pg\pg_ctl.exe" -D 'D:\moonlight\.local\postgres-data' -l 'D:\moonlight\.local\postgres-log\server.log' -w start
$env:DATABASE_URL = (Get-Content 'D:\moonlight\web\.env.local' | Where-Object { $_ -like 'DATABASE_URL=*' } | Select-Object -First 1).Substring(13)
Set-Location D:\moonlight\web
npm run db:migrate:local
npm run db:seed:m007b:local
Remove-Item Env:\DATABASE_URL
& "$pg\pg_ctl.exe" -D 'D:\moonlight\.local\postgres-data' -m fast -w stop
```

seed 只插入固定 ID 的虚构 Venue、桌位、题包、不可变版本和上架状态；重复运行会核对现有内容，不覆盖或删除数据。有效桌码由本机脚本随机生成并保存到被忽略的 fixture 文件。需要备份时，用 `pg_dump -h 127.0.0.1 -p 55432 -U moonlight_app -d moonlight_dev -W -F c -f D:\moonlight\.local\moonlight_dev.dump`，交互输入密码；不要把备份移入公开仓库。

## 尚未实现

AI、微信小程序、支付和部署尚未实现。双人流程是桌码＋短期邀请链接的轻量轮询体验，不包含陌生人匹配、聊天、跨桌社交、WebSocket 或可证明同桌的身份/位置校验。正式桌码及个人/双人答题流程需要已配置的 PostgreSQL `DATABASE_URL`；没有数据库时页面与 API 安全地显示/返回暂不可用，不会生成演示门店或伪造参与记录。M-013R2 已完成本地 Chrome＋PostgreSQL 安全回归；公网发布仍受 [发布阻断项](docs/RELEASE_BLOCKERS.md) 中 P0/P1 条件限制。

## 目录

- `web/`：唯一的 Next.js Web 应用
- `docs/DECISIONS.md`：公开安全的产品边界与技术决策
- `AGENTS.md`：项目工作规则

内部产品材料、任务文件、PDF、环境变量、依赖、缓存和构建产物由根目录 `.gitignore` 排除；公开仓库只提交经过审查的安全文件。
