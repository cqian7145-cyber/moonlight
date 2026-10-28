# M-014S2｜受限 Staging 执行 Runbook

状态：**BLOCKED（远端安全与费用待核验）**。项目方在 2026-10-28 提供的当前资源清单为 Railway `moonlight` Web、Postgres、cloudflared、moonlight-migration，Staging 域名 `moonlight.xizimist.com`；本次没有连接 Railway/Cloudflare，未独立核实资源、部署、Access/Tunnel 或 DNS 设置。每月预算上限为 USD 10，账户级 minimum sizing、当前账单和资源用量仍需项目所有者在 Dashboard 复核。本地材料不包含真实商家或顾客数据。

## 1. 固定架构与范围

```text
指定邮箱的测试者
  -> https://moonlight.xizimist.com
  -> Cloudflare Access（指定邮箱 Allow，其余默认拒绝）
  -> Cloudflare Tunnel（Protect with Access 必须开启）
  -> Railway cloudflared service（无公网域名）
  -> Railway 私网 moonlight-web service（无 Railway 公网域名）
  -> Railway 私网 PostgreSQL（无 TCP Proxy）
```

- Web、PostgreSQL、cloudflared 同 Railway project、environment、Singapore region `asia-southeast1-eqsg3a`。官方当前 Regions 文档列出该新加坡区域；最终以账户实际可选项为准。
- 服务私网通过 Railway internal DNS 通信。Web 使用平台 `PORT`，监听 `0.0.0.0`，cloudflared 指向 Web 的 private DNS + `PORT`。任何 private hostname、端口和 DNS 行为都必须在授权后的 Railway 环境实测。
- Railway 不为 Web 或 PostgreSQL 建立 public domain / TCP Proxy。Cloudflare Tunnel 是唯一公开入口。
- 只规划 `moonlight.xizimist.com`。不得修改 Shopify 使用的 `xizimist.com`、`www`、MX 或任何既有记录；不得把根域或 `www` 改为 Tunnel CNAME。
- Access 应用先创建并配置白名单，再配置 Tunnel published hostname route。Tunnel 启用 Protect with Access，使 `cloudflared` 在代理前验证 Access JWT；仅把 Access 加在一个 URL/页面上不足以保护源站。
- 只使用虚构门店、题包、参与和测试身份。`/api/health` 当前只证明 Next 进程响应，不证明 DB 已可用。

## 2. Railway 服务配置草案

三个长期服务都计入预算：

| 服务 | 根目录/镜像 | 网络及变量边界 | 健康/运行策略 |
| --- | --- | --- | --- |
| `moonlight-web` | Git repo 的 `/web`；Railpack；Node 24；`npm ci && npm run build` | 目标为无 Railway public domain、只接收 Tunnel 私网流量；只持有应用 `DATABASE_URL`、Better Auth secret 和固定公开 Origin；实际设置未在本轮核实 | Start command：`npm start -- --hostname 0.0.0.0 --port $PORT`；用平台 `PORT`，不得写死 3000/3001；healthcheck `/api/health` 仅作进程检查。 |
| `moonlight-postgres` | Railway PostgreSQL | 目标为 Private Networking；关闭 Public Networking / TCP Proxy；Web 和 migration 使用不同身份；实际设置未在本轮核实 | 上线前另外执行只读 SQL readiness；先核对平台备份/PITR 套餐及恢复能力。 |
| `moonlight-cloudflared` | Cloudflare 官方 `cloudflared` 容器固定版本/镜像 digest | 同 project/environment/region；无 public domain；Tunnel Token 仅此服务 Secret；上游为 `http://moonlight-web.railway.internal:$PORT`（须实测）；实际设置未在本轮核实 | 单实例常驻；Tunnel 健康状态不替代应用/数据库探针。固定镜像版本并订阅安全更新。 |

Railway 官方文档说明同一 project/environment 的私网服务使用 `*.railway.internal` DNS；私网流量通过 WireGuard。不能据此假定这个 Next 项目已配置完成，必须部署后实测连通性、监听地址、端口和源站不可达性。

## 3. 一次性 PostgreSQL Migration runner

本地 runner：`web/scripts/migrate-staging.mjs`。人工执行入口为 `cd web; npm run db:migrate:release -- --confirm-staging-migrations`。该命令不会自动加载 `.env.local`，也不回退到 `DATABASE_URL`；缺少 CLI flag 或环境 guard 会失败退出。

### 运行约束

1. 只用于显式人工触发的、一次性 release migration job，不挂到 Next 启动、`npm start` 或顾客请求。
2. 固定审核过的 Git commit/image。migration job 独立服务/环境，只提供 `MIGRATION_DATABASE_URL`；Web service 只提供 runtime `DATABASE_URL`，不共享迁移凭证或超级用户。
3. staging 必须有 `MOONLIGHT_MIGRATION_RUN=1`、`MOONLIGHT_MIGRATION_TARGET=staging`、`MOONLIGHT_MIGRATION_CONFIRM=I_UNDERSTAND_THIS_RUNS_DATABASE_MIGRATIONS`、`NODE_ENV=production`，并且 `MIGRATION_DATABASE_URL` 的 host 必须以 `.railway.internal` 结尾、含迁移专用用户名/密码。存在 `DATABASE_URL` 时 runner 拒绝运行。
4. 本地 PG 专项测试仅接受 loopback 与精确测试库名 `moonlight_m014s2_migration_test`、`moonlight_m014s2_migration_recovery_test` 或 `moonlight_m014s2_migration_recovery_fresh_test`；不接受 `moonlight_dev`。这不允许把 local-test target 用于远端环境。
5. 迁移凭据仅短时注入 migration job。不给 Web app、cloudflared、构建步骤、日志或部署镜像注入。migration role 仅授予经 SQL 审查所需的 schema/table/sequence DDL 权限，不授予 superuser；Web runtime role 不得拥有 DDL 权限。
6. runner 在同一专用连接取得 PostgreSQL `pg_try_advisory_lock`，竞争时快速失败，不等待后并发跑第二份；读取已提交 migration journal/SQL，比较既有 Drizzle ledger 顺序、SHA-256 与 migration 时间；拒绝未知/被改写/新增的数据库版本后才调用 Drizzle migrator。
7. 成功后再校验 ledger 完整性。PostgreSQL `SERIAL` id 允许因失败事务出现空洞，因此校验按 id 顺序核对 hash/timestamp，不假设 ID 连续。
8. Drizzle migration batch 在 PostgreSQL 事务中执行。实测故意错误的第二条测试 migration 会让该 batch 的第一条 DDL 和版本记录一同回滚；修正 SQL 后 runner 能安全重试。正式历史四条 SQL 保持原样。
9. 失败时 job 非零退出并阻止 Web 新版本发布；runner 只输出 SQLSTATE 或泛化错误，不打印连接 URL、密码、SQL 或参数。不要对正式数据库自动执行反向 SQL；恢复路径是保留旧 Web 版本，先评估向前修复或从经验证备份恢复到隔离的新数据库。

### Railway 执行方式的硬门禁

不要把 Web service 的 Railway pre-deploy command 当作已隔离 job：Railway 当前文档说明 pre-deploy 在私网执行且能读取该服务的环境变量，因而若把迁移密码加给 Web，就会令 Web runtime 可获得该高权限变量。本地准备方案要求独立 migration service / 手动 release job，且只向该 job 配置迁移 Secret。Phase B 必须在 Dashboard 证明实际 job 形态与权限隔离；若无法证明，则停止远端 Migration，不降低权限要求。

## 4. 部署前顺序（仅供获批后执行）

1. 确认 Cloudflare/Railway 账号、Singapore 可用区域、计费、测试邮箱、数据保留和备份恢复策略；在一个仅用于 Staging 的 Workspace 设置用量预警与 hard limit。
2. 复核项目方报告已存在的 Railway Staging project/environment 及 Web、Postgres、cloudflared、migration 服务；只检查名称、区域、私网和变量引用，不重复创建。不得创建 Railway public domain / PG TCP Proxy。若实际缺少服务，另行审批后再补建。
3. 只读核对 Cloudflare 的 exact-hostname Self-hosted Access App、邮箱白名单、默认拒绝策略、Tunnel Protect with Access 和 `moonlight.xizimist.com` hostname route。若配置缺失或不一致，先停下并提交变更方案；不得未经授权修改。
4. 只读核对现有 `moonlight.xizimist.com` DNS 记录及根域、`www`、Shopify 相关记录；任何 DNS 修改须先单独授权并经项目所有者复核。
5. 项目方报告 15 张表、4 条 Migration 已通过远端验证。执行前先用获授权的只读方式核对当前 Migration ledger 和 Schema；不要在本流程重复初始化或重跑 Migration。只有发现差异并得到单独迁移授权后，才按本 Runbook 独立 Migration 流程处理。Web 启动状态与变量引用也需要从 Dashboard 复核。
6. 完成 [安全验收矩阵](STAGING_ACCESS_MATRIX.md) 中全部远端场景。遇到源站公共入口、域名记录变化、错误 Host/Origin、凭据混用、预算超限、恢复失败时立即停止；不为通过测试而关闭 Access/CSRF/Host 检查。
7. 完成后复核费用、告警、备份、凭据撤销和测试数据清理。不得由本地任务自动开展 Phase B 或生产发布。

## 5. 本地 Phase A 验证记录

| 门禁 | 结果 | 证据口径 |
| --- | --- | --- |
| Runner 环境 guard | PASS | opt-in、secret 分离、loopback 测试目标和 Railway 私网域名均有自动测试。 |
| 隔离真实 PostgreSQL | PASS | 本轮 D 盘 PostgreSQL 18.6 临时 cluster，loopback only；空库四迁移、重复执行、哈希篡改拒绝、并发 advisory lock 拒绝、坏 migration 事务回滚和修复后恢复。未连接旧 55432/55433 实例。 |
| 工程质量门禁 | PASS | lint、typecheck、`npm test`（Vitest 93 passed/5 skipped，runner unit 3/3）、`npm run test:db`（16/16）、显式 `npm run test:migrate:pg`（1/1）、production build 和 `PORT=3147` loopback `/api/health` smoke 均通过。 |
| 敏感信息审查 | PASS | 对本轮源代码、文档和 manifest 扫描 credential-shaped 内容；仅在修改前发现测试/文档占位 URL，已改为无密码占位形式。未读取 `.env.local`，未找到实际凭据。 |
| Railway / Cloudflare | NOT_RUN | 无资源、账号授权或远端运行，不声称 Staging PASS。 |
| 成本 | CONDITIONAL | 仅按公开单位价格估算；三项 24/7 服务的偏乐观使用量可接近 USD 10，普通假设会超出。需 Dashboard 核算和 Workspace hard limit。 |

临时 PG server 已停止；其本轮专用目录 `D:\moonlight\.tmp\m014s2-migration-pg` 仍留在被忽略的 `.tmp` 中。删除该专用目录的 PowerShell 命令被本机执行策略拒绝；未尝试替代方式或触碰历史 PG 集群。目录内仅有本轮合成 migration 测试库，无凭据。

默认 `npm test` 仍跳过 5 个既有的专项真实 PG 用例：M-009 最后席位争抢、M-011 并发上架、M-013 答题冲突/停用、staff/跨店拒绝、并发反馈。它们需要 `MOONLIGHT_REAL_PG=1` 和各自的隔离 `DATABASE_URL`；本轮只在专用空测试库验证 migration runner，不把 runner PG 证据冒充成这些既有产品安全场景通过。
