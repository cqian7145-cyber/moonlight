# M-013 发布阻断项

状态说明：M-013R2 已完成本地可信 Origin 校准、真实 Chrome＋D 盘 PostgreSQL 回归与全部自动门禁。**本地安全 E2E 已通过；生产发布仍被本表 P0/P1 项阻止**。这不表示 M-014 已开始。

| 优先级 | 阻断项 | 状态 | 复现/证据 | 解除条件 | Owner |
| --- | --- | --- | --- | --- | --- |
| P0 | 本地浏览器日志和凭证文件处置 | CLOSED | 用户确认已通过普通文件管理器清理；复核 `.tmp/m012-e2e.json` 不存在，`.playwright-cli/` 剩余文件数为 0。没有读取其内容；两处仍被 ignore。 | 若以后重新使用该目录，禁止保存可重放凭证或未脱敏日志。 | 用户本机数据处置 |
| P0 | 生产入口未配置可信客户端 IP / 代理边界 | OPEN | 当前数据库限流是跨实例原子计数；没有 `MOONLIGHT_TRUSTED_CLIENT_IP_HEADER` 时按资源/匿名会话限制，无法抑制换 token/IP 的源站刷请求。不能信任客户端自己发送的 X-Forwarded 头。 | M-014 配置只接受真实边缘代理净化的 `X-Real-IP` 或 `CF-Connecting-IP`；阻断公网直连源站；用部署环境测试伪造头不可绕过。 | M-014 部署 |
| P0 | HTTPS、正式域名和 Secure Cookie 尚未在部署代理验证 | OPEN | 本轮本地服务只在回环地址测试。 | 配置 TLS、精确 `BETTER_AUTH_URL`/`MOONLIGHT_PUBLIC_ORIGIN`、受信任转发；验证个人/双人/商家 Cookie 的 Secure、HttpOnly、SameSite 与退出/撤销。 | M-014 部署 |
| P0 | 紧急停用缺少带审计的运营入口 | OPEN | PG 实测把虚构 venue 设为 suspended 后个人答题读取/写入被拒；目前无专用 operator 页面/审计记录可在事件中安全触发和复核。 | 建立最小权限、留痕、可复核的值班操作流程或运维入口；演练停用与恢复。不得用普通下架代替。 | M-014 运维 |
| P0 | 隐私披露、数据保留和删除流程未建立 | OPEN | 匿名 Attempt/Submission/Feedback 持久保存，Cookie 到期不会删除数据库记录；没有可靠顾客身份/复购指标。 | 上线前完成用户隐私告知、保存期限、用户/门店请求处理、备份过期与依法合规审查；不得声称可识别真实顾客或营销归因。 | 产品/法务 + M-014 |
| P1 | npm 审计报告 4 项 moderate | OPEN | `npm audit` 与 `npm audit --omit=dev` 均报告 `drizzle-kit@0.31.11 -> @esbuild-kit/esm-loader@2.6.5 -> @esbuild-kit/core-utils@3.3.2 -> esbuild@0.18.20`；`npm ls --omit=dev` 仍含该 peer dependency 链，调用面尚未确认。npm 建议强制降级 drizzle-kit 到 0.18.1，属破坏性变更，本轮不盲目执行。 | 评估兼容升级/peer 依赖替换；锁定修复并复跑 migrate、构建与 DB 门禁。 | 依赖维护 |
| P1 | 本地 Chrome＋PostgreSQL 全链路回归 | RESOLVED | M-013R2 使用真实 Chrome 155、两个独立双人会话、D 盘 PostgreSQL 18.6 完成个人/双人/商家/版本/下架/二维码/评分/报表/限流/紧急停用/禁用与登出；数据库故障 503→恢复 201；默认 93 passed/5 skipped、PGlite 16/16、真实 PG 5/5。详见 `TEST_MATRIX.md`。 | 已解除本地 E2E 验收阻断；部署条件见其他 P0/P1。 | M-013R2 |
| P1 | 桌码轮换后既有匿名会话语义 | RESOLVED（M-014 产品决定） | Chrome＋PG 实测：旧码新建返回 404；已授权 Cookie 继续读绑定 Attempt 返回 200。用户明确指定普通轮换保留合法进行中会话；紧急门店暂停仍阻断敏感读写。 | 按 `docs/DECISIONS.md` 保持回归。若未来要立即撤销进行中参与，另立变更设计可审计撤销。 | 产品负责人 |
| P1 | 生产开户、密钥轮换、监控与备份恢复未验收 | OPEN | 本机真实 PG 不表示生产环境建立完成；本轮不会部署、改远端或配置生产密钥。 | M-014 定义受控开户/轮换/告警、备份恢复与故障演练，并证明 secrets 不进入日志或构建产物。 | M-014 |
| P1 | 受控环境远程 Migration runner 未实现 | OPEN | `db:migrate:local` 明确拒绝非 loopback；普通 `drizzle.config.ts` 当前仅声明 schema/out/dialect，没有远程连接配置。远程部署现在不能安全执行 4 条已存在 migration。 | 设计显式 opt-in 的一次性 release job、独立迁移身份和审计，先对空 staging 数据库试运行；禁止把本地凭证或 app superuser 用于迁移。 | Release engineering |
| P0 | Railway origin 可绕过 Cloudflare Access | OPEN（M-014S 未部署验证） | Cloudflare Access 只保护绑定其应用的 hostname；当前 Next 服务没有验证 `Cf-Access-Jwt-Assertion` 的代码，任何已暴露的 Railway `*.up.railway.app` hostname 都不能假定自动继承自定义域的 Access 策略。当前无 Railway/Cloudflare 资源，无法证明 origin 私有或不可直连。 | 首选 Railway Next service 不开启 Public Networking，由同项目私网 cloudflared Tunnel + Protect with Access 提供唯一入口；若 origin 必须公开，先实现 RS256/JWKS、精确 issuer/audience/exp、Host allowlist 的 fail-closed origin gate。对 Railway 域名、IP、伪造/无效 JWT 与所有页面/API 实测绕过拒绝，再允许受限 staging。 | Release engineering + Security |
| P0 | Railway / Cloudflare HTTPS 与 Host/URL 语义未验 | OPEN | 本地 `request-origin.ts` 同时核验配置 Origin、Host 和 `Request.url` scheme；Cloudflare Tunnel 到 Railway 私网 HTTP upstream 的外部 HTTPS、外部 Host 与 Next Request URL 转换尚未测。 | 仅通过真实 Access + HTTPS Tunnel 浏览器实测 callback、Origin/CSRF 写入、Cookie 和每个顾客/商家 API 后关闭。不得放宽 Origin/Host 校验或直接信任伪造 forwarded headers。 | M-014S |

## M-014 本地演练更新

- D 盘新隔离 PostgreSQL cluster、source/restore 两库、四条现有 migrations、15 张 public 表及 `pg_dump`/`pg_restore` 实际验收结果见 `docs/BACKUP_RESTORE_RUNBOOK.md`。演练没有使用或清空历史 `moonlight_dev`。
- 当前基线依赖审计 `npm audit` 和 `npm audit --omit=dev` 都是 4 项 moderate；生产安装树实际包含 Drizzle Kit/esbuild peer 链。Next build 的 48 份 NFT trace 没有引用该链，但 `next start` 非 standalone 的依赖安装树仍包含它，调用可达性未确定，故继续 OPEN P1。
- M-014 远程 staging 为 `NOT_RUN / EXTERNAL_AUTH_REQUIRED`：没有获授权的供应商账户、测试域名/DNS、平台访问控制或远程秘密。公网正式开放仍禁止；本地演练不替代真实 HTTPS 和代理入口验收。M-014 完成了 D 盘 Migration、备份恢复与真实 Chrome/PG 本地回归，细节见 `docs/STAGING_ACCEPTANCE.md`。
- M-014 方案文档已提出数据保留草案；自动清理、顾客实际隐私告知、删除请求流程仍未实现/审查，继续 OPEN P0。紧急停用仍缺少最小权限写入 API 与 append-only 审计表，继续 OPEN P0。
- M-014S Railway + Cloudflare Access 仅完成本地设计。Railway generated domain 绕过、Tunnel 下 Origin/Host/scheme、实际 Access policy、Postgres 私网与远端 Migration runner 都没有云端证据；见 `docs/STAGING_HANDOFF.md`。任何远端功能状态均不得标 PASS。

## 结论

本地浏览器和 PostgreSQL 的安全链路已按任务范围验证通过。公网入口的 HTTPS、清洗后的可信代理/IP、可审计紧急停用、隐私数据生命周期仍是 OPEN P0；依赖审计和 release migration runner 为 OPEN P1。普通桌码轮换后的既有会话语义已由产品负责人在 M-014 明确，并已纳入回归，不再是待确认项。因此不能把本仓库标为公开试点或生产就绪，也不能把本地 PASS 作为 M-014 部署 PASS。
