# Moonlight M-014S｜Railway + Cloudflare Access Staging 交接准备

状态：**LOCAL_PREP_IN_PROGRESS**。本文件只做本地准备；没有登录或操作 Railway/Cloudflare 账户，没有创建服务/数据库/隧道，没有修改 DNS，没有 push 或公开服务。受限 staging 与公网发布仍需分开授权。

## 1. 当前仓库与部署事实

- 验收基线：`651fea440dde73dfeaaa6ddcf78d9bf877dcb535`，`main` 与现场 `origin/main` 一致；根目录任务文档是未跟踪输入，必须保留、不纳入提交。
- Next.js App 根目录是 `web/`，有独立 `package.json` 和 `package-lock.json`；没有 Railway/Docker 配置文件。部署目标为标准 Node.js Next server，不是静态导出。
- 版本：Next 16.4.3、React 19.3.0、Better Auth 1.7.12、Drizzle ORM 0.45.4、pg 8.23.1。当前机器 Node 24.12.0；`package.json` 没有 `engines` 锁定，所以仅凭本机 Node 版本不能证明 Railway runtime 版本。
- `npm run build` 是 Next production build，`npm start` 是 `next start`；没有 standalone output。部署必须包含完整 Next server runtime 与必要 production dependencies。
- 现有 `/api/health` 固定返回 HTTP 200 和无敏感字段的服务状态，不测试数据库连通性。Railway 可用它作进程启动检查，但上线前另需通过应用 DB 身份执行只读 SQL readiness 冒烟；该 endpoint 也不是持续监控。
- `web/drizzle.local.config.ts` 和 `db:migrate:local` 明确拒绝非 loopback 数据库；`web/drizzle.config.ts` 没有凭证配置。**不得把本地迁移命令用于 Railway。**当前还没有 staging migration runner。
- `request-origin.ts` 精确比较已配置 origin、Host、`Request.url` 协议和 Fetch Metadata；它不信任任意 `X-Forwarded-*`。Cloudflare Tunnel/Railway 私网之间的 HTTPS、Host 与 Next Request URL 表现必须在 staging 真实验收，不能预设已经兼容。
- 当前 Node 24.12.0/npm 11.19.1 的干净 lockfile 安装显示 4 项 moderate；npm 提示 `esbuild`、`unrs-resolver` 等 4 个安装脚本未获 npm 11 allowScripts 批准。隔离构建仍通过，但 Railway Railpack 的 npm 版本和 lifecycle 行为尚未验证；不要扩大脚本白名单或用 `npm audit fix --force` 作为未经评审的快捷处理。
- `npm audit --omit=dev` 返回 exit 1：4 项 moderate，受影响的 `esbuild@0.18.20` 由 `better-auth -> drizzle-kit -> @esbuild-kit/esm-loader -> @esbuild-kit/core-utils` 引入；建议 `npm audit fix --force` 会把 drizzle-kit 降至不兼容的 `0.18.1`，本轮不执行。构建 trace 未含该工具链，但可达性尚未证明安全，依赖风险保持 OPEN P1。

## 2. 建议拓扑与 Railway 配置草案

```text
测试者浏览器
  └─ HTTPS: staging 子域
       └─ Cloudflare Access（测试者 Allow，默认拒绝）
            └─ Cloudflare Tunnel / Protect with Access
                 └─ Railway 私网 cloudflared service
                      └─ Railway 私网 Next.js service
                           └─ Railway 私网 PostgreSQL
```

优先方案是 **Next.js 与 PostgreSQL 不配置公网域名/数据库 TCP Proxy**；单独的 cloudflared 服务从 Railway 私网访问 Next 服务，并由 Tunnel 发布受 Access 保护的 hostname。这样不把访问控制仅押在 DNS 或隐藏 URL 上。Railway PostgreSQL 默认是私有服务，打开 Public Access 会建立 TCP Proxy，故该选项必须保持关闭。[Railway PostgreSQL 网络说明](https://docs.railway.com/databases/postgresql)、[Railway 私有网络与 TCP Proxy](https://docs.railway.com/networking/tcp-proxy)。

建议 Railway Web service 参数，实际账户可用项仍需现场确认：

| 设置 | 准备值 | 说明 |
| --- | --- | --- |
| Repository | `cqian7145-cyber/moonlight` | 仅授权后连接；当前未操作 GitHub App 或 Railway。 |
| Root Directory | `/web` | Railway isolated monorepo 的服务根目录；lockfile 与 Next 应用均在此目录。[Railway monorepo](https://docs.railway.com/deployments/monorepo) |
| Builder | Railpack | 不新增 Dockerfile；当前仓库没有 Docker build 配置。[Railway Railpack](https://docs.railway.com/builds/railpack) |
| Node | Proposed `RAILPACK_NODE_VERSION=24` service variable；部署后核对实际 patch | Railpack 当前 Node 版本优先级支持 `RAILPACK_NODE_VERSION`，也可从 `engines.node` 等来源解析。[Railpack Node version resolution](https://railpack.com/languages/node/) 本仓库没有引擎锁定；本机 Node 24.12.0 不能代表 Railway 实际版本。 |
| Build | `npm ci && npm run build` | 使用 `web/package-lock.json` 可复现安装并构建。不能把 npm audit 4 项 moderate 当作已经解决。 |
| Start | `npm start -- --port $PORT` | `npm start` 映射 `next start`；端口使用平台注入值，不写死 `3000/3001`。[Railway build/start](https://docs.railway.com/builds/build-and-start-commands) |
| Healthcheck | `/api/health`（只作进程启动检查） | 返回 `2xx` 仅说明 Next route 可响应；部署后必须另验数据库查询与业务 API。Railway healthcheck 仅在部署切换时调用，不是持续监控。[Railway healthchecks](https://docs.railway.com/deployments/healthchecks) |
| Public Networking | Next service 不生成 `*.up.railway.app` 域名 | 通过 Tunnel 发布测试 hostname。若账户/配置不能保持 origin 私有，则 staging 不能开放，除非额外完成应用层 Access JWT 与 Host 校验。 |
| Region | 待用户授权后选定；Web、Tunnel、Postgres 尽量同区域 | 没有账户/网络实测；本文件不推荐任何未核实的驻留、延迟或合规结论。 |

Railway 提供 `.up.railway.app` 与 custom domain 公网入口；若给 Web service 生成 public domain，Cloudflare Access 对自定义 hostname 的策略本身不会自动约束另一个 Railway hostname。因此首选是不给应用服务配置 Public Networking。若因 Railway/Tunnel 运行方式必须暴露 origin，就需应用侧校验 `Cf-Access-Jwt-Assertion` 的 RS256 签名、精确 issuer、该 Access 应用 audience、有效期和允许 Host；拒绝缺失/伪造/过期 token。只检查 header 存在或 `CF_Authorization` Cookie 不足以建立 origin 信任。[Railway public domains](https://docs.railway.com/networking/public-networking)、[Cloudflare origin token validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)、[Cloudflare JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。该验证当前**尚未实现**，不能把备用设计说成已生效。

## 3. Cloudflare Access 与绕过验证

1. 先创建与精确 staging hostname 对应的 Self-hosted Access Application，再建立 Tunnel route；策略只 Allow 明确列出的测试组/邮箱或经过审查的 identity provider。无匹配者默认拒绝；不设置 Everyone、永久 Bypass 或开放路径。Cloudflare 建议先建立 Access application 再发布 Tunnel route，并要求验证发往可公网访问 origin 的 Access token。[Cloudflare 发布 self-hosted app](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。
2. Tunnel 配置启用 Protect with Access，并绑定对应 Access Application 的 team 与 audience。Origin JWT 需验证签名和 claims；Access 在签名密钥轮换时会提供当前与上一把 key，验证器要按 `kid` 选择并更新 JWKS，不可写死单个证书。[Cloudflare Tunnel Access origin setting](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/origin-configuration/)、[Cloudflare JWT verification](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。
3. Next 服务只在 Railway 私网接受来自 Tunnel service 的流量，不生成公共 Railway 域名；数据库只接受同 Railway 环境内的 Web / migration service。公网数据库 TCP Proxy 保持关闭。
4. `/api/health` 只返回无敏感状态字段，可由 Railway 私网 healthcheck 直达；它不代表 staging 应用可访问，也不返回数据库状态或配置。所有页面、API、Better Auth 回调及顾客流程都必须处于 Access 准入后面。
5. 必测绕过场景：
   - 未认证测试者访问正式 staging hostname：由 Cloudflare Access 拒绝；允许测试者通过 Access 后，再完成 Better Auth 商家登录。
   - 直接访问 Railway `.up.railway.app`、已知内部/临时域名、IP 或 Origin service URL：无 public domain 时不得建立可达入口；若存在任何公网入口，则从无 Cookie、伪造 `Cf-Access-Jwt-Assertion`、错误 audience/issuer、过期/错误签名 token 都必须被 origin 拒绝。
   - 对 HTML、Next RSC/prefetch、静态资源、Better Auth API、顾客 API、双人邀请/加入/结果、二维码入口和报表逐路由验证；不能只保护首页。
   - 允许测试者之外的身份、撤销成员、Access session 过期和退出后重试均拒绝；验证 Access logout 与 Better Auth logout 的范围分别符合预期。
   - 带伪造 `Host`、`Origin`、`X-Forwarded-Host`、`X-Forwarded-Proto`、`CF-Connecting-IP` 直连 origin 不得改变应用公开 Origin、协议判定、权限或限流身份。

## 4. Staging-only PostgreSQL Migration runner

**当前 BLOCKED；只完成设计，未实现/未连接远端。**不要改写已冻结的 4 条 Migration，不要使用应用启动钩子自动迁移，也不要调用 `db:migrate:local`。

实施前建立独立、可审查的 migration job（Railway one-off/manual job 或隔离 release service）：

- 固定同一个 Git commit/image digest；job 无公网域名，只通过 Railway 私网连 staging PostgreSQL。
- 使用 `MIGRATION_DATABASE_URL`（名称为提议，尚未实现），和 Web app `DATABASE_URL` 分离。迁移角色只授予当前 DDL 所需权限，不是 owner/admin/superuser；Web runtime role 不具有 schema DDL 权限。
- runner 只读取已提交的 `web/drizzle/*.sql` 与 migration journal；校验 migration 顺序/完整性，使用 PostgreSQL advisory lock 避免并行执行，记录 migration id、checksum、开始/结束和 outcome，不记录 SQL bind 值、URL、密码、Access token 或完整连接异常。
- 仅人工显式触发；执行前确认 staging-only 环境标识、当前 backup/restore point、目标 hostname、DB identity 与预计 SQL。未通过环境 guard 时 fail closed。
- 每条 migration 采用与 Drizzle journal 兼容的事务语义；先在全新空 DB 回放所有已提交 SQL，再对真实 staging 增量 migration。若现有 SQL 含不能在事务执行的语句，单独设计审查，不擅自改旧 Migration。
- 成功后执行 schema version、表/约束数量与只读 DB readiness 检查，再部署 Web image 并进行 smoke test；失败停止发布，保留前一应用版本，不自动降级 schema。仅在隔离恢复验证后执行数据恢复。
- 先实现 PGlite/本地真实 PG runner 测试，再申请远端试跑授权；实际迁移只能在 staging 空库/明确批准的数据集执行。

当前 `docs/RELEASE_BLOCKERS.md` 的 P1 migration runner 继续 OPEN。没有远端 Runner 代码、迁移身份和实库证据，不得写为“migration 已就绪”。

## 5. 变量与密钥边界

实际应用变量见 [环境变量矩阵](ENVIRONMENT_MATRIX.md)。Staging 必须从 Railway/Cloudflare 各自的受控 secret store 注入；不复制本地 `.env.local`、本地 dump、密码或 M013/M014 连接串。

| 类别 | 计划 | 边界 |
| --- | --- | --- |
| `DATABASE_URL` | Railway 内部 PG reference/private URL | 只给 Web runtime，TLS 校验按 Railway 当前产品支持核实；不可用 `DATABASE_PUBLIC_URL`。 |
| `MIGRATION_DATABASE_URL` | 独立 migration role，独立 job | 提议变量，runner 未实现；不可共享 Web runtime 密码。 |
| `BETTER_AUTH_URL`、`MOONLIGHT_PUBLIC_ORIGIN` | 精确匹配 `https://<approved-staging-host>` | 在 Access/Tunnel 的真实请求 Host 与协议通过测试前不填入生产 service。 |
| `BETTER_AUTH_SECRET` | 每环境独立随机 secret，经平台秘密管理器写入 | 不在仓库/构建参数/部署日志；轮换时制定旧 session 失效步骤。 |
| `CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD` | 仅当实现 origin JWT 验证时使用的非秘密配置 | 当前代码未读取；不要误认为设置这两个值就完成验证。 |
| Tunnel token | 仅提供给 cloudflared service | Cloudflare 高敏凭据；不传入 Next 服务，不打印，不放变量导出文件；泄漏时先旋转。 |
| `PORT`、`NODE_ENV` | Railway 注入/设置 | 不锁定本机端口。确认 Node production Cookie flags 与外部 HTTPS 语义。 |
| `MOONLIGHT_TRUSTED_CLIENT_IP_HEADER` | 默认留空 | 只有确认入口覆盖客户端头、origin 只能经该入口到达后，才单独决定；不能仅凭存在 Cloudflare header 就启用。 |

### 密钥轮换步骤

1. 生成新 Tunnel token / Better Auth secret 并只写入对应平台 secret store；确认新部署已经读取且 health/smoke 成功。
2. 撤销旧 Tunnel token / Better Auth 会话按 Better Auth 配置失效；不在日志和截图中出现值。
3. 从未认证浏览器验证 Access 与 app 均按预期拒绝；只用专用虚构测试账号验收。
4. 留存轮换时间、操作者、受影响变量名和结果，不留 secret 内容。

## 6. HTTPS、数据库与应用验收矩阵

| 层 | 用例 | 预期 | 当前证据/状态 |
| --- | --- | --- | --- |
| Source/build | `web/`、Node 24、`npm ci`、lint/typecheck/test/test:db/build、production start | lockfile build 成功且应用监听 Railway `PORT` | 本机门禁待本轮完成；Railway runtime 未运行。 |
| Cloudflare Access | 未登录；测试者登录；非 allowlisted identity；token 过期/revoke | 默认拒绝，只有指定测试者可进入 | 尚无 Cloudflare 资源，NOT TESTABLE。 |
| Origin bypass | Railway 直域名/IP/private hostname，错误/伪造 JWT，错误 Host | 无 public origin；或 origin JWT/Host 校验全拒绝；不能绕过 Access | 当前没有 staging origin；访问门禁代码尚未实现，OPEN P0。 |
| HTTPS / cookies | TLS 链、HSTS策略、Better Auth 登录/退出、独立浏览器 context | HTTPS 端到端；Auth/顾客 Cookie `Secure; HttpOnly; SameSite` 与 Path/Domain 正确；登出使 session 失效 | 仅 localhost 既有验证，远端 NOT TESTABLE。 |
| Origin / CSRF / proxy | 同源写入、跨站 Origin、伪造 Host/Proto/CF IP、缺失 Access JWT | 仅同源/Access 有效请求通过；代理上下文行为与固定 origin 一致；不关闭校验 | 本机对 request-origin 逻辑有测试；Tunnel 与 app URL 语义未验，OPEN。 |
| PostgreSQL 网络 | Web/runner 同区域私网连接；从互联网访问 PG TCP/5432 | app 与 migration 最小权限分别成功；外部连接超时/无路由；Public TCP Proxy 关闭 | Railway 未创建，NOT TESTABLE。 |
| Migration | 空 DB 首次、同版本重复、错误 checksum、双 runner、失败半程 | migration 仅一次且可审计；并发互斥；失败不启动新 app；历史 SQL 完整 | Runner 未实现，BLOCKED。 |
| 业务/隐私 | 顾客个人/双人各自会话、邀请、问答、二维码、评分；owner/staff/跨店；报表和双人揭晓 | 复用本地 M-013/M-014 用例；PG 记录和权限边界一致；不导入真实客户数据 | 真实 Chrome + 本机 PG 既有证据，不是远端验收。 |
| 限流/紧急处置 | 重试与 429；停用门店阻断敏感读写；普通下架与桌码轮换的既定语义 | 429 信息最小；紧急停用可恢复且有最小权限审计 | 业务逻辑本地通过；受审计运维入口仍为 OPEN P0。 |
| Backup/restore | 建库备份、恢复到新隔离 DB、表/版本/反馈/双人关联核验 | 记录 RPO/RTO；备份与 Tunnel/DB Secret 分离；恢复后 E2E smoke 成功 | 本地 D 盘假数据演练通过；Railway 计划、保留、费用及真实恢复均未核。 |
| Post-deploy | Railway healthcheck、独立 DB readiness、Browser smoke、错误日志 | 不返回 stack/env/SQL/PII；日志无 token/密码；健康检查失败不接流量 | `/api/health` 只检查 process，不表示 DB ready；平台 NOT TESTABLE。 |

## 7. 备份和费用决策待办

- PostgreSQL 不启用公网 TCP Proxy。先在 Railway 对选定 plan 确认自动备份/PITR 能力、保留窗口、恢复点创建与导出限制；不能根据旧报价推定当前 plan 有某功能。
- 开放前批准 RPO/RTO。准备期间建议每日逻辑备份加受管 PITR，副本放独立权限/故障域；每季度或 schema 重大变更后恢复到新 DB 并做数据校验。保留时长和存储费用由负责人决定。
- 计费前先给 Railway 用量预算和告警阈值；确认 Web、PostgreSQL、Tunnel、备份、出站和存储各自计费。费用页面与优惠必须登录账户核验，本次不报固定总价、不创建付费资源。
- Cloudflare 需确认 Zero Trust plan 的应用/用户限额、测试者身份方式、Tunnel 数量与日志保留；无账户信息时不承诺免费或确定成本。

## 8. 开放 staging 前的阻断清单

1. 远端 Access/App allowlist、Cloudflare Tunnel 和 Railway 私网拓扑经用户审批后创建；验证没有公网 Railway domain/PG TCP Proxy。
2. Access JWT origin 验证（若 Railway origin 对公网可达）与 allowed Host 保护尚未实现；完成后必须通过本表“Origin bypass”全部用例。
3. staging migration runner、独立 migration DB identity 与空库回放尚未实现。
4. Tunnel 下 `BETTER_AUTH_URL`、`MOONLIGHT_PUBLIC_ORIGIN`、`Request.url` scheme/Host 兼容性尚未验证；不能因本地 403 已修复而推定 HTTPS proxy pass。
5. DB readiness healthcheck、可靠紧急停用审计、数据保留/删除、依赖 audit moderate 风险仍须各自满足 release blocker。
6. 用户另行批准供应商账户、预算、区域、测试 hostname/DNS/Access policy 和受限远端部署；其中任一未确认时仅保持本地准备，不导入真实用户/商家数据。

**禁止把 `LOCAL_PREP_PASS`、`STAGING_PASS` 和 `PUBLIC_RELEASE_APPROVED` 合并。**本任务不授权创建 Railway/Cloudflare 资源；远端矩阵在获批且实际执行前都是 `NOT TESTABLE`。
