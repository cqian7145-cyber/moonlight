# Moonlight M-013 安全审查

审查范围：当前 M-012 前置提交及 M-013 工作树；目标是 M-014 前的本地候选版本，不表示已部署或通过法律审查。2026-10-26 检查。完整测试分层见 [TEST_MATRIX.md](./TEST_MATRIX.md)，发布条件见 [RELEASE_BLOCKERS.md](./RELEASE_BLOCKERS.md)。

## 威胁边界与权限矩阵

服务端把个人、双人和商家会话分为三种独立凭证。桌码和邀请链接是定位/邀请能力，不证明顾客身份；内部 UUID 不是授权凭证。商家每次请求重新读 Better Auth session、账号状态和 venue membership。

| 主体 | 凭证与资源范围 | 可读 | 可写 | 拒绝证据 |
| --- | --- | --- | --- | --- |
| 未认证访客 | 无；有效桌码仅定位一间 active venue | 桌码页最小门店名、活动标题、题数；邀请摘要 | 同源且有效桌码下开始个人参与、创建邀请；主动同意后加入 | 无效/停用桌码、未同意、无效邀请被拒；API 不接受客户端 Attempt/Venue ID |
| 个人玩家 A | `moonlight_attempt` HttpOnly Cookie + 自己的 token hash 命中记录 | 自己进度、题目、结果、本人评分 | 本人逐题提交；完成后本人评分一次 | 双人 Cookie 不作个人授权；另一个 token 得不到 A 的 Attempt；写入要求同源 |
| 双人玩家 B | 独立 `moonlight_group_attempt` Cookie 与自己的 Attempt | 自己进度及题目；两人均完成后共同结果 | 主动同意加入、本人答案、退出、本人评分 | 邀请令牌不能代替成员 Cookie；完成前不返回同伴答案；独立连接 PG 验证并发末席仅一人成功 |
| Staff | Better Auth 有效 session + 当前 venue active membership | 授权门店经营摘要、当前发布和桌位概览、聚合报表 | 无 owner 写操作 | 真实 Chrome session 下草稿写请求 403；禁用 membership 后旧 session 不再列出门店 |
| Owner | Better Auth 有效 session + 自己门店 owner membership | 自己门店的草稿、版本、桌位和报表 | 自己门店草稿、发布/普通下架、桌码管理 | 跨店 UUID 不能扩大 scope；写事务在写入时锁定并复核 membership |
| 跨店 Owner | 自己门店 session + 不同 venueId 路径 | 自己获授权门店数据 | 仅自己门店操作 | 真实 Chrome 直请求报表 API 返回 403；真实 PG 专项也复验 403 |
| 已禁用账号/成员 | 旧 Cookie/session，但 account disabled 或 membership 非 active | 无受保护门店数据 | 无 | 服务端逐请求重新查库；撤销状态使后续请求失败，不依赖客户端按钮 |

## 攻击面与控制

- **对象与字段越权（BOLA/IDOR）**：个人接口通过 Cookie token hash 取 Attempt；双人接口通过本人的 token hash取 Attempt；商家资源查询同时限制 `venueId` 和资源 ID。答案、反馈和报表对外只投影所需字段。版本与 publication 仍由复合外键和不可变快照约束。
- **认证与会话**：继续使用 Better Auth 1.7.12；禁止公开注册、密码最短 12 位、邮箱登录每 60 秒 5 次、数据库 rate limit、12 小时商家 session、session cookie cache 关闭、HttpOnly/SameSite=Lax，production Secure。账号禁用与 membership 撤销需每次访问检查。历史会话与浏览器文件处置见下文。
- **CSRF / 代理头**：顾客写 API 以配置的 `MOONLIGHT_PUBLIC_ORIGIN` 或 `BETTER_AUTH_URL` 精确比对 Origin、Host 和入站 URL 协议；不信任任意 `X-Forwarded-Host/Proto`。商家写请求同样要求 trusted origin，拒绝跨站 `Sec-Fetch-Site`。真实代理若重写入站 URL 协议，需正确配置应用外部 origin 并验证 HTTPS。
- **接口刷写**：新限流使用既有 `auth_rate_limits` 表、单条 PostgreSQL UPSERT 原子计数，限制按操作与身份隔离、60 秒窗口，并返回 429/Retry-After；存储键为 SHA-256 后值，不存原始会话令牌或 IP。配置可信 IP 时主要写接口约 120 次/分钟、读取 600 次/分钟（邀请预览 300 次、评分写 120 次）；未配置时按资源/匿名会话计数，评分写限 10 次/分钟。较高可信来源阈值降低酒馆/校园共享 NAT 误封，但不构成容量测试或异常流量保护；未配可信来源时攻击者可换身份规避。可信入口只能通过显式配置 `MOONLIGHT_TRUSTED_CLIENT_IP_HEADER` 选择 `x-real-ip` 或 `cf-connecting-ip`，部署层必须清除外部伪造头且封闭直连源站。
- **并发与一致性**：参加答案按 `(attempt_id,cue_key)` 唯一约束进行幂等写入；异值并发返回冲突。Feedback 按 attempt 唯一约束竞争。M-005 组队席位锁、M-011 门店发布锁在独立 PG 池中重跑并观测到锁等待。测试仅插入随机虚构数据，不删除历史行。
- **紧急停用 / 桌码轮换**：门店 `venues.status = suspended` 作为紧急总开关；个人与双人题目、提交、状态/结果读取及评分必须拒绝。真实 Chrome＋PG 中停用后现有个人读取返回 409，恢复门店后测试库保持可用；独立 PG 专项同时覆盖双人读写拒绝。正常下架只阻止新参与，旧 Attempt 保持原不可变版本；Chrome 证明发布新版本和普通下架后既有 Attempt 仍能读原题。桌码轮换后旧码的新启动返回 404，但旧码加既有 Cookie 的个人 Attempt 仍返回 200；当前契约是轮换阻止新进入，不立即撤销已开始参与。该语义需产品负责人确认。紧急开关当前由受控数据库运维更新，没有面向商家的带审计操作 UI，属于发布阻断。
- **缓存、注入与错误**：私有响应 no-store、no-referrer、noindex、nosniff、Vary Cookie；输入用严格 JSON/Zod，题目按纯文本 React 渲染，不接受 HTML。API 错误只返回稳定错误码，不输出数据库 URL、SQL 或堆栈。M-013R2 真实 Chrome 与构建验收已完成，见测试矩阵。

## 个人数据与本地凭证

- 个人与双人 cookie 的浏览器有效期分别约 30 天和 15 分钟；数据库 Attempt 不随浏览器 Cookie 过期而自动删除。匿名凭证不能识别真实顾客，评分以 Attempt 关联，不向同伴共享原始答案；商家仅看聚合数据。
- M-012 账号表中 5 个合成验收账号已禁用、4 个认证 session 已撤销；数据库没有删除用户或历史业务行。扫描临时 Playwright 输出时，一个旧邀请 token hash 命中合成 PlayGroup，已轮换哈希而非删除房间或历史 Attempt。
- 用户确认已在普通文件管理器中清理指定临时对象。M-013R 复核 `.tmp/m012-e2e.json` 不存在，`.playwright-cli/` 仍为空目录（0 个文件）；未读取内容，精确 ignore 仍防止后续误加。此前记录的合成账号/session 已停用/撤销，邀请哈希已轮换；没有删除历史业务数据。
- M-013R2 新建的合成商家账号已按 `m013r2-*@example.test` 精确范围停用，相关未过期 auth session 到期，关联 membership 禁用；本次清理只更新认证/授权状态，不删除账号、session 或业务行。输出仅记录汇总计数，没有打印合成身份或凭证。
- 未发现需要报告的已提交凭证；本轮工作区不暂存密钥、数据库文件或测试账号资料。对公开远端的历史提交扫描不能替代专用 secret scanner / GitHub secret scanning。

## M-013R2 可信 Origin 与风险裁决

实际 listener 固定为 `http://127.0.0.1:3001`。此前 Chrome 分别使用 `http://127.0.0.1:3001` 与 `http://localhost:3010`，两者不但互不相同，且都与先前的 `localhost:3000` 配置不匹配。代码核对确认：`MOONLIGHT_PUBLIC_ORIGIN` 由顾客同源检查和二维码公开入口直接读取；`BETTER_AUTH_URL` 在 `getMerchantAuth()` 读入后显式作为 Better Auth `baseURL`，`trustedOrigins` 同样固定到该 Origin。Better Auth 没有代码内不同 baseURL 覆盖；`trustedProxyHeaders`、Origin/CSRF 校验保持启用。Next.js 按其环境文件加载规则读取 `web/.env.local`，当前进程无同名 Origin 覆盖，`web/.env.production.local` 不存在。此前的 403 根因是 Origin 配置仍是 `http://localhost:3000`，与浏览器实际 Origin/Host/端口不相同。

已使用标准、Git 忽略的 `web/.env.local` 统一 `MOONLIGHT_PUBLIC_ORIGIN` 和 `BETTER_AUTH_URL` 为 `http://127.0.0.1:3001`。原配置先复制至 `.local/m013r2-env-local.backup`，ACL 限制为当前用户、SYSTEM、Administrators；备份和 `.env.local` 均被 Git ignore。检查发现 Better Auth 本地密钥原先不存在，因此本机文件另生成 48-byte 随机 `BETTER_AUTH_SECRET`；值未输出到终端/报告、未写入源代码、未提交。无效桌码同源 POST 到达业务校验并返回 404 `table_not_found`，恶意 Origin 仍 403 `same_origin_required`；Attempt 计数无变化。真实 Chrome 登录 HTTP 200、草稿与二维码写入成功再次证明 `BETTER_AUTH_URL`、密钥和写入 Origin 在运行时生效。

真实 Chrome 155 + D 盘 PostgreSQL 18.6 回归通过：个人三题/结果刷新/自愿评分；两个隔离双人会话自愿加入，第三席拒绝，完成前结果不可见；owner 登录、草稿、不可变版本发布、旧参与版本保留、普通下架/上架、二维码生成轮换；staff 写入与跨店报表 403；member/account 禁用和登出使旧会话失去权限；7 天报表读取；数据库原子限流 429 且响应仅含 `rate_limited`；门店紧急暂停拒绝已有参与读取。数据库停机时答题写入 503，恢复后同一答案重试 201，SQL 仅新增一条 Submission，没有伪造成功状态。375/390px 无横向溢出。完整差量和分别分类的证据在 [TEST_MATRIX.md](./TEST_MATRIX.md)。

Origin/CSRF/Host 检查没有放宽，跨站写入仍拒绝。明确观察到桌码轮换后旧码不能开始新参与，而已有个人 Cookie 会话对旧码绑定 Attempt 仍返回 200；当前实现选择保留已开始的体验。该行为已由产品决策记录，但负责人仍应确认是否要在紧急轮换时额外撤销现有匿名会话。

本地代码与 E2E 验收通过不等于生产可用。OPEN P0 仍包括 TLS/正式代理边界、受清洗的可信客户端 IP、紧急停用的审计操作以及隐私告知和数据保留；OPEN P1 包含 4 项 npm moderate 与二维码轮换撤销语义确认。依赖链为 `drizzle-kit -> @esbuild-kit/esm-loader -> @esbuild-kit/core-utils -> esbuild@0.18.20`；`npm audit --omit=dev` 也报告该传递链，源码未发现 runtime 对 drizzle-kit/esbuild CLI 的直接调用，但不能断言其不可达。未执行破坏性自动降级；npm 建议版本为 `drizzle-kit@0.18.1`。

## 参考

- [OWASP ASVS 5.0](https://asvs.owasp.org/downloads/)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [Better Auth Rate Limit](https://better-auth.com/docs/concepts/rate-limit)
- [PostgreSQL Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
