# M-014 预发布与发布门禁验收

日期：2026-10-26。此文只记录可复核的本地演练和明确未执行项。任何本地地址和假数据都不是实际 staging URL 或酒馆试点。

## 前置与 Git 审查

- 期望前置 HEAD `33111ed404cd33f95e419604c01d55065a9765e1`；本轮开始时 `main` 与其一致，工作区干净。
- `origin/main` 现场只读查询仍为 `2970a6902251dbf7fe2e1071bbef40840c726717`，相对跟踪引用本地领先 5 个提交。没有发现远端 main 变化；未 push。
- 五个本地领先提交共涉及 98 条文件路径。文件名检查未发现 `.env` 实例、`.local`、`.tmp`、Playwright 输出、数据库或 dump/log；高置信度私钥/GitHub token/带用户名密码 Postgres URL 模式扫描命中 0 个文件。所有对象均位于本机 D 盘忽略目录，不纳入提交。此模式扫描不是专用 secret scanner，也不审查公开历史中 M-014 前更早的提交。
- `.playwright-cli/` 仍为 0 个文件，`.tmp/m012-e2e.json` 不存在。`.env.local` 与本地 M-013R2 配置备份仍被忽略。

## A. 本地发布模拟

| 验收项 | 结果 | 证据/边界 |
| --- | --- | --- |
| 基线代码门禁 | PASS | `npm run lint`、`typecheck`、默认测试 93 passed / 5 skipped、`test:db` 16/16、build 35 页生成。5 个真实 PG 专项另独立 5/5 通过。 |
| 真实 PostgreSQL Migration | PASS | D 盘新隔离 PostgreSQL 18.6 cluster，创建新 source/restore DB；通过 `db:migrate:local` 执行现有 4 条迁移并重复执行成功。15 张 public 表。四条历史 migration 未修改。 |
| 备份恢复 | PASS | source 执行 `pg_dump -Fc`，恢复到另一个空数据库；15 表、迁移、虚构用户/session、门店关系、不可变版本、房间、3 Attempt、9 Submission、3 Feedback、哈希关联计数逐项相同。仅虚构 fixture。 |
| 真实 Chrome + 生产构建 + PostgreSQL | PASS（本机） | 2026-10-26 对 M-014 生产构建重跑真实 Chrome 155 + D 盘 PostgreSQL 18.6。个人三题与刷新恢复、双人独立同意/席位与共同揭晓、owner 登录/草稿/不可变发布/历史版本、下架与桌码轮换、评分、报表页面、限流、紧急停用、membership/account 撤销、登出全部 PASS；新增仅为合成行（5 Attempt、9 Submission、3 Feedback、1 PlayGroup、2 ActivityVersion、2 Publication）。账号已禁用、4 个活动 session 已过期、6 个 membership 已禁用；未删除数据。 |
| Origin / Host / X-Forwarded 头 | PARTIAL（本地探针 PASS） | 本地生产 listener 探针结果：有效 Origin/Host + 随机无效桌码到达业务校验并返回 404；恶意 Origin 返回 403；恶意 Host 返回 403；匹配 Origin/Host 但伪造 X-Forwarded-Host/Proto 不改变业务检查（404）。这只证明 loopback listener 的当前行为；真实 ingress 未配置，`X-Real-IP` / `CF-Connecting-IP` 仍不能宣称公网可信。 |
| TLS、平台访问门禁、代理真实 IP | NOT TESTABLE LOCALLY | localhost 使用 HTTP，不能证明 HTTPS/Secure Cookie、证书、真实 proxy chain 或外部访问控制。 |
| 紧急停用 | PASS（机制）/ BLOCKED（审计操作） | PostgreSQL + Chrome 已验证 suspension 拒绝进行中个人敏感读取；真实 PG 专项还验证双人读写拒绝。产品规则已记录。应用目前无受控停用 API 和 append-only audit event。 |
| 报表页面与 SQL | PARTIAL | Chrome 页面加载实际经营复盘；自动化集成测试覆盖 SQL 聚合、门店范围、双人 Attempt/房间口径和历史版本。本轮没有逐指标把 Chrome 每个显示数字与独立 SQL 查询逐项比对。 |

M-014 的本地部署命令与 PostgreSQL 实际演练详见 [部署方案](DEPLOYMENT_PLAN.md)、[备份恢复手册](BACKUP_RESTORE_RUNBOOK.md)。由于紧急操作审计/数据生命周期尚有 P0，当前不能标记 `LOCAL_READY`。

## B. 受限远程 staging

**NOT_RUN / EXTERNAL_AUTH_REQUIRED。** 没有获准的平台账户、地区、付费计划、测试域名/DNS、平台访问控制和远程密钥。没有创建 service/database，没有部署，没有真实 HTTPS URL，也没有向公网开放匿名 H5。

需要在后续得到明确授权的资源/决定：

1. 选择供应商/地区和费用上限；确认是否允许创建付费资源。
2. 提供测试域名及 DNS/TLS 变更许可；确认受限入口（平台私有 access 或已审查的 allowlist）及测试者范围。
3. 授权受控 staging 部署及仅虚构 seed 数据；不得上传本机数据库或 `web/.env.local`。
4. 批准专用密钥管理、应用 DB 与 migration DB 身份；确认私网/TLS、受信代理头清洗和源站隔离。
5. 先解决 release migration runner 缺失；之后对远程 migration、认证回调和代理链单独评审。

## C. 公网正式开放

**BLOCKED / 未授权。** 本任务没有此项授权。当前 P0：真实 HTTPS/代理/IP 边界、紧急停用审计、顾客隐私告知与自动保留/删除流程；P1：moderate 依赖链分析/修复、release migration runner、生产备份/告警/密钥轮换。真实顾客、商家和桌码均未导入。

## 三层结论

- A 本地演练：Migration、备份恢复、默认门禁、PG 专项、真实 Chrome 全链路和本地 Origin/Host 探针通过；真实 TLS、反向代理和外部入口仍未验证。整体状态 `PARTIAL`，不等于部署或发布 PASS。
- B 受限 staging：`NOT_RUN / EXTERNAL_AUTH_REQUIRED`。
- C 正式开放：`BLOCKED / 未授权`。
- 项目总状态：`PARTIAL`；远程部署不会自动进行。详见 [Release Blockers](RELEASE_BLOCKERS.md) 与[数据留存草案](PRIVACY_AND_RETENTION_DRAFT.md)。

## M-014 决策记录

- 普通桌码轮换立即阻止旧码创建新参与；使用已签发匿名 Cookie 的合法进行中 Attempt 可以继续读取、答题和完成。门店紧急停用（`venues.status = suspended`）阻断顾客敏感读写，包括进行中的个人和双人参与。正常活动下架只影响新参与，不撤销已经绑定的不可变版本。依据为产品负责人本轮明确要求；相关 M-013R2 浏览器/PG 行为已回归。
- 价格、供应商、地区与拓扑只是方案评估，没有创建账号/资源、采购、改 DNS、部署或导入客户数据。M-014 本地 pass 只证明 D 盘模拟、当前自动门禁和本机浏览器/数据库验收，不代表受限预发布或公网开放。
