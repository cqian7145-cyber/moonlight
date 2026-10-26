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
| P1 | 桌码轮换对既有匿名会话的即时撤销语义 | OPEN（产品决策待确认） | Chrome＋PG 实测：轮换后旧码新建返回 404；携带既有 Cookie 的 Attempt 使用旧码继续读取返回 200。实现语义是“拒绝新进入、保留已开始参与”。 | 产品负责人确认是否接受既有会话继续；若要求立即撤销，另立变更并设计可审计的会话撤销机制。当前报告不把两种语义混为一谈。 | 产品负责人 |
| P1 | 生产开户、密钥轮换、监控与备份恢复未验收 | OPEN | 本机真实 PG 不表示生产环境建立完成；本轮不会部署、改远端或配置生产密钥。 | M-014 定义受控开户/轮换/告警、备份恢复与故障演练，并证明 secrets 不进入日志或构建产物。 | M-014 |

## 结论

本地浏览器和 PostgreSQL 的安全链路已按任务范围验证通过。公网入口的 HTTPS、清洗后的可信代理/IP、可审计紧急停用、隐私数据生命周期仍是 OPEN P0；审计链为 OPEN P1，轮换后的既有会话语义待产品确认。因此不能把本仓库标为公开试点或生产就绪，也不能把本地 PASS 作为 M-014 部署 PASS。
