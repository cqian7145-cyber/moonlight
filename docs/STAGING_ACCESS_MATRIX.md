# M-014S2｜受限 Staging 安全验收矩阵

本矩阵只列验收门槛；当前没有 Railway/Cloudflare Staging 资源。所有远端项在实际获批部署并留存脱敏证据之前均为 `NOT_RUN`。不得用 localhost / PGlite 结果替代。

| 层 | 场景/请求 | 必须结果 | 证据及停止条件 |
| --- | --- | --- | --- |
| Access 登录 | 指定 allowlist 邮箱访问 `staging.xizimist.com` | Access 验证身份后允许；随后仍需 Moonlight 商家登录 | Chrome 新会话、Access event + 页面状态；不要在截图中留邮箱以外的身份信息或 Cookie。 |
| Access 拒绝 | 未登录、非 allowlist 邮箱、撤销邮箱、Access session 到期 | 在到达 Web 前被拒绝；默认拒绝 | 逐一浏览器验证，并确认 origin 无访问日志请求；任何匿名页面/API 可达即 BLOCKED。 |
| Tunnel JWT | 缺失、伪造、过期、错误签名/issuer/audience 的 Access JWT | Tunnel Protect with Access 在转发前拒绝 | Tunnel event / 请求结果；不得仅检查 `Cf-Access-Authenticated-User-Email` header。 |
| Tunnel 建立顺序 | 在 Access App 尚未准备好时的 route | 不得先发布无 Access route | 首次开通录像/配置审查；如曾匿名暴露，撤销 route/token 并启动凭据泄漏评估。 |
| Railway Web origin | `*.up.railway.app`、可能公网 IP、旧/临时 origin hostname | 不存在公共入口；若平台产生任一入口，未授权测试身份不能直达应用 | Dashboard networking 列表 + 外部探测；任何公开 Web origin 即 BLOCKED，不能因 DNS 隐藏而豁免。 |
| PostgreSQL 网络 | 外网/TCP proxy 直连与 Web 同环境私网连接 | 公网连接失败；Web 私网连通；migration 身份独立且只限 job | Railway networking 配置和外部 TCP 测试。任何公共 Postgres Proxy 即 BLOCKED。 |
| Shopify DNS 保护 | 新增 staging hostname；检查 apex/root、`www`、Shopify 当前各项 | 仅允许按批准新增 `staging` 记录；根域、`www`、Shopify/邮件记录逐项相同 | 修改前/后只读 DNS zone diff 和 Dashboard review；意外差异先撤销 staging 修改并停止，不自动修复原记录。 |
| HTTP/TLS | HTTPS、HTTP redirect、TLS 证书和 HSTS | 外部 HTTPS 有效；HTTP 不泄露页面或会话 | 独立浏览器 context 和 TLS 检查；证书/Host 不匹配即 BLOCKED。 |
| Host/Origin/CSRF | 标准浏览器写入、跨站 Origin、伪造 Host/Origin/Forwarded Host/Proto | 只有精确 `https://staging.xizimist.com` 上下文通过；应用拒绝跨站写入 | Browser network 请求和 API 状态码；不得关闭现有 `request-origin` 守卫或仅信任客户头。 |
| Better Auth | 登录、登出、callback、session cookie、失效重放 | callback 固定公开 HTTPS origin；Cookie `Secure; HttpOnly; SameSite` 正确；登出后 session 不再授权 | 真 Chrome + Access + Railway；localhost 测试不计作远端证据。 |
| 个人玩法 | 桌码入口、匿名 Attempt、逐题答复、刷新恢复、结果 | 数据只在测试 PG；恢复同一 Attempt；门店暂停时敏感读写拒绝 | Chrome + staging PG 行数与请求对应；不得导入真实桌码或顾客信息。 |
| 双人玩法 | 两隔离 Chrome context 邀请、加入、独立作答、同时争抢最后席位、共同揭晓 | 两位匿名身份分离；席位至多一人成功；双方完成后揭晓 | 两 context + 独立 PG 连接；检查 Attempt/Submission/PlayGroup 实际计数。 |
| 商家权限 | owner、staff、跨店账号、已撤销成员 | owner 按业务许可写入；staff 只读；跨店/撤销拒绝 | 真实认证 cookie + PostgreSQL owner/staff 夹具；不得使用个人真实账号。 |
| 活动与桌码 | 发布版本、更新题包、普通桌码轮换、旧会话继续 | 新参与由当前版本；既有参与仍绑定原版本；旧桌码阻止新参与但合法会话继续 | old/new publication、Attempt、Table hash 和入口逐项 SQL 对照。 |
| 紧急停用 | 门店标记 suspended 后页面/API/会话请求 | 个人/双人/商家敏感访问立即拒绝；保留请求审计，不泄露内部详情 | 当前项目尚无完整受审计 operator 入口，业务测试不关闭该 P0。 |
| 评分与报表 | 每位参与者独立反馈、重试、7/30 天统计、历史版本、双人组计数 | 幂等；A/B 只能看到本人反馈；报表与独立 SQL 一致；空数据不造 KPI | PostgreSQL 原始记录和 SQL 聚合结果存脱敏证据。 |
| 限流 | 匿名/商家超限，伪造客户端 IP 头直连 | 正确返回 429；客户端不能伪造可信代理身份 | 只有证明 Tunnel 是唯一入口、边缘头被覆盖后才设置 trusted IP header。 |
| Migration | 空库、重复执行、错误 journal/checksum、两个 job 同时执行、语句失败/重试 | 空库只得到 4 条已审核 migration；同版本幂等；hash drift 失败；竞争者快速退出；事务失败不记录半条版本 | 单独 migration service、独立 DB role、runbook 和 SQL ledger；Web 环境不能读迁移凭据。 |
| Migration 权限 | Web 尝试 DDL；migration job 访问无关对象 | Web DDL 被拒；job 仅持所需 DDL；角色非 superuser | 用真实 PG role 执行 `has_database_privilege`/`has_schema_privilege` 检查和拒绝 DDL 请求。 |
| 备份恢复 | 执行逻辑/平台备份、恢复到新数据库、核验记录 | 不覆盖/清理旧库；数据行和引用关系一致；恢复后 E2E smoke 成功 | 先由 Dashboard 核实产品/plan 的备份能力、保留期和成本；恢复目标必须是新隔离 PG。 |
| Restart/health | Web/PG 重启、连接中断恢复、应用 health 与 DB readiness | 进程/DB 状态区分；DB 不可用不被报告为 ready；用户操作不泄露 stack/SQL | 平台日志脱敏、health 和独立 `SELECT 1` readiness；错误告警与恢复记录。 |
| 视口 | Chrome 375px / 390px，键盘和 reduced-motion | 顾客主要流程无横向溢出，焦点可见，状态可读 | 真浏览器截图与交互记录；截图不得包含 token、邮箱 session 或真实客户数据。 |
| 费用和停机 | 用量告警、Workspace Compute hard limit、限额触发 | 预算进入风险时告警；hard limit 可停止全部 Staging workloads；确认停止后可控恢复 | 独立 Staging Workspace/预算；需要接受阈值触发时 Web/PG/Tunnel 同时不可用。Hard limit 不承诺税费/外部账单归零。 |

## 当前证据边界

- 本地 runner 环境 guard、空库/重复、hash drift、advisory lock、失败事务回滚和修复后恢复有 D 盘 PostgreSQL 实测。
- 本地产品既有测试不证明 Remote Cloudflare Access、Tunnel、Railway private networking、浏览器 HTTPS 或云端备份恢复。
- Railway/Cloudflare 所有远端场景当前均为 `NOT_RUN`。真实 Staging 需要单独授权及真实 Chrome + Railway PostgreSQL 证据。
