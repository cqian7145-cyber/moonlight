# Moonlight M-013 测试矩阵

所有数据库验收只追加本任务随机虚构的 venue/room/attempt/feedback；测试后没有删除业务行。浏览器状态、handler 测试和真实 PostgreSQL 多连接测试分列记录，不互相替代。M-013R2 的自动门禁、真实 PostgreSQL 专项与 Chrome 全链路于 2026-10-26 完成。

## 质量门禁

| 命令 | 状态 | 证据 |
| --- | --- | --- |
| `npm run lint` | PASS | M-013R 串行运行 exit 0 |
| `npm run typecheck` | PASS | M-013R `tsc --noEmit` exit 0 |
| `npm test -- --reporter=dot` | PASS | M-013R：14 个文件通过、3 个文件 skip；93 passed / 5 skipped。5 个跳过项的精确名称与开关原因见下节；随后都在真实 PostgreSQL 专项中通过。 |
| `npm run test:db` | PASS | M-013R：16/16 PGlite migration/约束测试通过；独立串行运行，exit 0 |
| `npm run build` | PASS | M-013R2 production build exit 0；最终页面数量以本次构建输出为准 |
| `git diff --check` | PASS | M-013R2 最终复核工作树差异，无空白错误 |

第一轮并行 npm 门禁因多个 PGlite worker 同时初始化完整 migration，触发 10 秒 `beforeEach` 超时；串行重跑全套后通过，单独串行 DB 门禁 16/16 通过。并行失败不作为最终测试结果隐藏，资源争用和随后串行结果均在报告中说明。

## 集成与 HTTP handler（PGlite）

| 范围 | 通过结果 | 局限 |
| --- | --- | --- |
| 个人桌码、创建/恢复、答题、结果、撤码语义、紧急门店停用 | 包含在完整 93 passed 中 | PGlite 模拟 PostgreSQL API，不能证明网络协议或多 PG 连接竞争 |
| 双人创建/加入/会话隔离/答题/共同揭晓/过期 | 包含在完整 93 passed 中 | 不证明生产浏览器 Cookie、HTTPS 或公网代理 |
| 反馈幂等、同值重试、异值冲突、频控 429 | 包含在完整 93 passed 中 | PGlite 单客户端；真实 PG 竞态另列 |
| 商家 owner/staff/跨店/禁用与原点校验 | 包含在完整 93 passed 中 | Chrome 访问路径需单独实测 |
| Origin/Host/X-Forwarded 伪造 | 新增 `request-security` 与 `attempt-api` 场景通过 | 需在正式 ingress 的代理配置上复验 |
| 7/30 天报表、门店范围、无数据和历史版本 | 包含在完整 93 passed 中 | UI/SQL 显示一致性需 Chrome 复验 |

### 默认跳过的五项测试

以下测试均使用 `it.skipIf(process.env.MOONLIGHT_REAL_PG !== "1")`。默认主测试未启用真实 PostgreSQL，因此显示为 skipped；本轮显式设置该开关，并按隔离库约束单独执行，全部通过。

| 测试 | 默认跳过原因 | M-013R 专项结果 |
| --- | --- | --- |
| M-009：`serializes two independent invitees at the final seat without a ghost attempt` | 需要真实 PostgreSQL 多连接；默认不连接本机数据库 | PASS |
| M-011：`serializes two owner publications on separate PostgreSQL connections and keeps one active` | 需要真实 PostgreSQL 多连接；默认不连接本机数据库 | PASS |
| M-013：`serializes independent answer retries, rejects conflicting answers, and blocks reads after venue suspension` | 需要真实 PostgreSQL 并发与门店停用验证；默认不连接本机数据库 | PASS |
| M-013：`denies staff writes, cross-venue owner IDs, and revoked memberships with real PostgreSQL sessions` | 需要真实 PostgreSQL 会话与授权复核；默认不连接本机数据库 | PASS |
| M-013：`allows only one durable rating when independent clients submit different values concurrently` | 需要真实 PostgreSQL 独立连接竞争；默认不连接本机数据库 | PASS |

## 真实 PostgreSQL 18.6 多连接专项

命令（loopback D 盘实例、fixture 虚构且随机唯一）：

```powershell
$env:MOONLIGHT_REAL_PG='1'
npm test -- src/server/m009-postgres-concurrency.test.ts src/server/m011-postgres-publication-race.test.ts src/server/m013-postgres-security.test.ts --reporter=dot
```

M-013R 实际命令使用 `MOONLIGHT_REAL_PG=1`，最终运行：3 个文件、5/5 通过。多个连接池独立建立，并对锁竞争使用 5–8 秒 lock timeout、8–12 秒 statement timeout。测试日志确认 migration 历史为 4 条，没有删除历史记录。

| 用例 | PostgreSQL 证据 | 结论 |
| --- | --- | --- |
| M-009 双人末席争抢 | 独立连接；1 个加入成功、1 个 GROUP_FULL；观测到 Lock wait；最终恰 2 人、0 幽灵参与 | PASS |
| M-011 两 owner 同时发布 | 2 个 handler 池并发；观测到行锁等待；一个 201，一个 stale 409；active publication 恰 1 | PASS |
| M-013 同一答案并发重试 | 独立连接提交同一 cue/相同值；created + duplicate，数据库仅 1 行 | PASS |
| M-013 异值答案竞争和紧急停用 | 不同值恰 1 次成功、1 次拒绝；suspend 后答题读取/写入均拒绝；原行保留 | PASS |
| M-013 评分竞争 | 独立连接提交不同评分；201 + 409；数据库仅 1 条 Feedback | PASS |
| M-013 实际 PG 商家授权 | Staff 写入、跨店 Owner、撤销 membership 的旧 session 均 403；未产生 draft；合成账号结束时禁用/session 撤销 | PASS |

这些专项不代表生产并发容量测试，也未证明完成与退出、到期、运营暂停在所有交错下的形式化状态机安全。Migration 历史仅查询；没有修改或重置已有 migration。

## 真实 Chrome 与全链路

| 场景 | 状态 | 证据/后续 |
| --- | --- | --- |
| Chrome 个人三题→结果→评分 | PASS | Chrome 155 + PG：有效桌码、Attempt、三次提交、刷新恢复结果、本人反馈写入；375px 无溢出。 |
| 两个 Chrome 会话双人邀请→同意→答题→共同揭晓→各自评分 | PASS | 独立 A/B 浏览器上下文和匿名凭证；第三人席位拒绝；完成前隐藏结果；各自答题、共同揭晓和独立评分；390px 无溢出。 |
| owner 发布 V1→顾客开始→发布 V2→旧参与仍读 V1 | PASS | Chrome 验证草稿保存、不可变发布与旧 Attempt 继续读取原版本；数据库版本记录增加符合预期。 |
| Staff 只读、跨店拒绝、登出后失效 | PASS | Chrome 中 staff 写入和跨店读取 403；membership/账号禁用后旧会话失权；单独 Chrome 登出后受保护 API 401，DB session 数归零。 |
| 报表 7/30 天、历史版本和权限 | PASS | Chrome 加载商家复盘并呈现 7 天数据，覆盖 owner/staff、跨店和历史版本；真实 SQL handler 聚合另由自动化集成测试覆盖。此次浏览器脚本没有逐指标与独立 SQL 查询做逐项对账。 |
| 375/390px、失效桌码、429/503、刷新/回退 | PASS | 多视口无横向溢出；失效/已轮换桌码新启动 404；实际限流 429；数据库中断写入 503，恢复后重试成功且仅一条 Submission。 |
| `/play/demo` 不持久化 | NOT RUN | 不属于 M-013R2 指定 Chrome 回归场景；未以本轮数据声称已验证。 |
| 二维码轮换后的现有会话 | PASS（契约待产品确认） | 旧码不能开新 Attempt（404）；旧码加已存在的个人 Cookie 仍能读绑定 Attempt（200）。当前是“阻止新进入、保留已开始参与”。 |
| 紧急停用 | PASS | Chrome 中 venue suspended 后，现有个人参与读取被拒；独立 PostgreSQL 专项还覆盖双人读取/写入拒绝。 |

可信 Origin 根因是旧 `localhost:3000` 配置与浏览器/服务 `127.0.0.1:3001` 不一致。使用标准、被 Git 忽略的 `web/.env.local` 将应用公开 Origin 与 Better Auth Base URL 配置为实际本地地址；此前配置先做受 ACL 保护的本地备份，并为原先缺少的 Better Auth secret 生成新的本机随机值。值未输出、提交或外传。Origin 与 Host/CSRF 检查保持启用。敏感临时对象经用户确认清理并复核：`.tmp/m012-e2e.json` 不存在，Playwright 日志目录剩余文件数为 0。此次真实 Chrome、PG SQL 差量和故障恢复结果均已完成；合成测试账号已禁用，相关认证会话已失效，没有删除历史业务记录。

## 安全审计

- M-013R `npm audit` 与 `npm audit --omit=dev` 各报告 4 项 moderate：`drizzle-kit@0.31.11 -> @esbuild-kit/esm-loader@2.6.5 -> @esbuild-kit/core-utils@3.3.2 -> esbuild@0.18.20`，受影响范围 `esbuild <=0.24.2`。`npm ls --omit=dev` 仍显示 drizzle-kit 经 Better Auth peer dependency 在生产树；代码检索未发现 Better Auth 运行时代码直接导入该 CLI/构建工具，因此运行时可利用性未证实，不能把审计项简单归类为 dev-only。`npm audit fix --force` 建议会破坏性降级 drizzle-kit 至 0.18.1，本轮未执行，保留为 P1 依赖治理项。

- Better Auth 的登录失败限流依旧由现有认证插件处理；新增顾客/商家操作限流用 DB UPSERT 原子计数。未配置可信 ingress IP，不能宣称能阻挡换会话/换 IP 的分布式刷流量。
- 真实 PG 错误回滚/短锁超时可在专项中观察；没有执行清空数据库、破坏历史记录或人为关闭共享实例的故障实验。
- 开发门禁和真实 PostgreSQL handler/并发专项不能替代真实 Chrome 回归，也不能代替 HTTPS 生产部署、移动真机、隐私合规与备份恢复演练。
