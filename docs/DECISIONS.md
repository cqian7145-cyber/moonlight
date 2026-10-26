# Moonlight V1 决策记录

## 当前产品形态

- 服务大学城社交型小酒馆。
- 无大屏，以桌面二维码引导顾客在手机 H5 随时轻互动。
- 个人模式必须可用，顾客可以独自开始和完成一轮玩法。
- 双人顾客页面和顾客 API 已在 M-009 开放为仅限两人的自愿邀请挑战；商家正式功能仍留待后续任务。
- 商家后续负责启用内容和查看复盘；当前任务不建设正式商家后台。

## 当前技术方向

- 单体 Web 应用：Next.js 16.x App Router、React、TypeScript、Tailwind CSS。
- 后续数据库候选：PostgreSQL + Drizzle；当前演示不接数据库。
- 当前不引入 WebSocket、Redis、微服务或 AI 依赖。

## 被替代的旧假设

旧材料中的“大屏 + 每 15 分钟同步活动”不再是默认产品方案。当前以桌面二维码、手机 H5、个人模式优先为准；双人玩法留待后续任务评估。

## M-004 数据模型与迁移

- 使用 PostgreSQL 方言的 Drizzle schema 与已审查 SQL migration。正式服务端适配器使用 `pg`；集成测试只使用每例新建、进程内的 PGlite，不读取 `DATABASE_URL`，不将 PGlite 当作部署存储。
- 实体为 `venues → venue_tables`、`venues → activity_templates → activity_versions`、`venues → publications → play_groups → attempts → submissions`，以及 `attempts → feedback`。Publication 独立记录某门店启用的不可变题包版本；它不是顾客游玩记录。
- 门店、题包及版本、发布记录、临时组队通过复合外键携带 `venue_id`，防止跨门店关联。临时组队与参与记录也以 `(play_group_id, publication_id)` 复合外键保持同一发布；桌位可空，但非空时必须属于同一门店。仍需 M-005 在事务内校验邀请加入、并发容量、发布状态和过期时间。
- UUID 是内部主键。桌位公开码和参与会话令牌只存单向哈希；它们不是登录或管理凭据。双人邀请仅存哈希。个人与双人参与分别受检查约束；双人参与必须有组队记录及参与者自己的同意时间。答案不包含身份字段，feedback 仅为一次 1–5 分评分。
- `activity_versions` 是追加式快照；migration trigger 拒绝更新和删除，并在插入时校验 `cues` 为非空数组、cue 的 `key`/`prompt` 非空、choices 至少两项且为非空字符串、cue key 不重复。应用层仍需只创建完整版本，不提供编辑已发布版本的接口。
- 首版每个门店最多一个 active publication，由 PostgreSQL 部分唯一索引保证。各表状态使用枚举/检查约束限定取值；M-004 不定义或执行完整状态转换规则。
- 演示页面仍完全不依赖数据库。迁移集成测试执行 `drizzle-kit generate` 产物并验证重复 migrate、唯一约束、外键、跨门店一致性、同组同发布、版本冻结和单店唯一 active publication。

## M-005 服务端领域层

- 领域服务位于 `web/src/server/`，每个数据库操作通过调用方传入的 Drizzle client 执行；`server-only` 阻止其进入 Client Component 模块图。测试仅在 Vitest 中将标记解析为空模块，生产 Next.js 构建仍使用官方边界检查。
- 当前活动读取必须同时满足门店 active、publication active、`activated_at <= serverNow`、无 `deactivated_at`、题包版本内容有效且模板未归档。M-004 Schema 没有开始/结束时间窗口字段；结束通过将 publication 置为 inactive 并写入 `deactivated_at` 表达。不会在 M-005 改写 M-004 迁移。
- 活动版本规则固定为 3 道题，每题 3 个非空选项，以匹配 M-003 个人结果算法。数据库 migration 继续允许每题至少 2 项；服务层采用更窄的 V1 业务校验。
- 个人与邀请令牌由 Node `crypto.randomBytes(32)` 生成，只在创建响应中返回原文，数据库保存 SHA-256 哈希；提供给创建 API 的可恢复 token 只能命中已存在参与记录，不能由调用方选取新 token。邀请加入要求单独明确同意。
- 双人房间加入在一个 Drizzle transaction 中先对目标 `play_groups` 行执行 `SELECT ... FOR UPDATE`，然后检查有效成员数并写入成员；同组持锁串行化，拒绝第三席。服务事务不读取或写入其他门店的业务行，关系仍由 M-004 的复合外键兜底。
- PGlite 用真实 M-004 SQL migration 驱动集成测试，覆盖事务、唯一约束、同意/权限、答案幂等、状态与过期。PGlite 为单连接测试环境，不证明 PostgreSQL 多连接锁等待与并发抢占；该真实并发门禁已在 M-009 用独立 PostgreSQL 客户端验证，M-013 仍需覆盖锁超时与重试策略。
- 双人状态映射为 `open -> waiting`、`paired -> ready`，完成状态从两名成员均 completed 派生；Schema 枚举没有 completed/abandoned 组状态，分别以派生结果和 `cancelled`/`expired` 表达，不新增迁移。M-009 的独立真实 PostgreSQL 多连接验收已验证锁等待与最后一席串行化（见 M-009 记录）；M-013 仍需覆盖超时与重试策略。

## M-006 桌码入口与顾客首页

- `/t/<tableCode>` 是动态服务端只读页面；原始桌码只用于 SHA-256 查找，不作为主键或认证。公开投影仅含门店名、当前有效活动标题和题数，查询复用 M-005 的活动可用性校验；不返回内部 ID、内容快照、答案或令牌。
- 无效桌码走 Next.js 友好 not-found 页面；由于该动态页面以 Suspense 流式响应，运行时无效桌码响应状态为 HTTP 200（soft 404），页面 noindex。停用桌位、停用门店、无当前活动和数据库不可用有各自状态文案。桌码页设置 `no-store`、`no-referrer` 和 `noindex`，不在页面日志中记录原始码或底层错误。
- 桌码页的个人入口进入正式个人流程；M-006 当时的双人占位在 M-009 被替换为显式同意后创建房间的入口。桌码页本身仍只读，不创建 Attempt、Submission、PlayGroup。
- 页面数据必须由配置的 PostgreSQL 读取。本地没有数据库连接配置，未采用 PGlite 文件数据库或伪造样例数据；PGlite 仅用于以正式 SQL migration 建库的集成测试。真实 PostgreSQL 与浏览器连库需在后续具备安全隔离的 PostgreSQL 环境时验证。

## M-007 匿名个人参与与会话恢复

- `POST /api/attempts/start` 接受严格 JSON `{ "tableCode": "..." }`；只解析桌码定位门店，再调用 M-005 `startSoloAttempt` 创建或凭 Cookie 恢复，不复制参与状态机。首次创建返回 201，恢复返回 200；`GET /api/attempts/current?tableCode=...` 只读返回该门店下当前 Cookie 对应的个人参与摘要。没有答案提交 API。
- 会话凭证复用 M-005 的 32-byte 随机 token，客户端只通过 `moonlight_attempt` HttpOnly Cookie 持有；数据库仍只保留 SHA-256 哈希，JSON/页面不包含原始 token、哈希或内部 Attempt ID。Cookie 限于 `/api/attempts`、SameSite=Lax、30 天，HTTPS/production 设置 Secure；当前 M-004 Schema 没有 Attempt 过期字段，Cookie 过期后无法经普通浏览器恢复旧记录。
- 写请求必须有与请求 Host + 协议完全一致的 Origin；Next 内部 URL 与入站 Host 不一致时按入站 Host 校验，反向代理可传递协议。缺失、无效、跨站或非 same-origin Fetch Metadata 均拒绝。没有 CORS 放宽。个人开始控件用 Web Locks 对同一浏览器多标签请求串行化；不支持 Web Locks 的浏览器会安全失败，不发送开始请求。
- Route Handler 接受可注入的 Drizzle provider，测试通过 PGlite 和仓库 SQL migrations 调用实际 M-005 服务。生产适配器仍是 `pg`；测试注入不替换生产 DB，也不证明真实 PostgreSQL 或多实例并发行为。
- M-006 的 Chrome 扩展自动化提供器在浏览器选择阶段报无法加载 request-header policy；脱敏诊断表明策略服务初始化 `POST https://ab.chatgpt.com/v1/initialize` 网络失败，应用页面请求未发出，因此没有本地 URL/Origin/Host/HTTP 状态或应用服务器错误可归因。改用 Codex 内置浏览器后本地页面导航与 `/play/demo` 三题交互成功；未放宽应用安全头或 CORS。

## M-007B 真实 PostgreSQL 与 Chrome 验收

- 本机验收使用 EDB PostgreSQL 18.6 官方免安装 ZIP，解压于 `D:\moonlight\.tools\postgresql-18.6`，数据与日志位于 `D:\moonlight\.local`；实例仅监听 `127.0.0.1:55432`，pg_hba 只允许 SCRAM，未注册 Windows 服务。连接凭据在被忽略的 `web/.env.local`；超级用户密码只用于初始化，之后没有保存。
- `npm run db:migrate:local` 通过 pg adapter 执行仓库 Drizzle SQL migration；重复迁移成功，数据库记录 1 条 migration、9 张 public 表。`npm run db:seed:m007b:local` 可重复运行，插入并核验稳定 ID 的全虚构 Venue、桌位、三题题包、不可变版本和 publication；不会更新或删除行。桌码原文仅保存在被忽略的本地 fixture 文件，数据库只存哈希。
- 使用现有 Google Chrome 安装版和临时固定 Playwright 1.56.1，从 D 盘临时目录和独立 D 盘浏览器配置运行。有效桌码页显示虚构门店/题包；首次点击后创建；刷新与第二标签均恢复；已有 Cookie 的三次 POST 均返回 resumed/200，SQL Attempt 行数不变。跨店读取 401，未知桌位 404，停用桌位/门店 409，无上架活动 409，恶意 Origin 403；清 Cookie 后读取 401 并显示开始按钮。375px/390px 下 document/body 无横向溢出，开始按钮可用。生产构建在本地 HTTP 的 Set-Cookie 仍包含 Secure（`NODE_ENV=production`）；Chrome localhost 接受该 Cookie 并成功刷新恢复，生产部署仍应使用 HTTPS。
- SQL 验收最终记录 3 条虚构 `solo/in_progress` Attempt、0 条 Submission。三条来自独立匿名浏览器配置文件；其中一次早期 Playwright 检查把生产模式正确发送的 `Secure` 属性误判为期望 false，浏览器在创建后关闭，留下一个不可恢复的虚构测试行。没有清理或删除它；后续同一 Chrome 配置文件的刷新、多标签和重试均不再增加行数。任务验收前后没有触碰真实顾客数据。
- 本地根路由、`/play/demo`、`/staff`、`/admin`、`/api/health` 均返回 HTTP 200。浏览器 request-header policy 提供器仍在应用导航前失败；本次通过已安装 Chrome + Playwright 的本地临时安装完成真实浏览器验收，没有放宽应用安全头或 CORS。
- 未进行多 PostgreSQL 客户端事务/锁竞争测试（层 D `NOT_RUN`）；未测试首次无 Cookie 的并行 POST。M-007 Web Locks 只覆盖同一支持该 API 的浏览器 UI 多标签，服务端没有跨实例幂等键；两个首次无 Cookie 的并发 POST 仍可能创建两个独立匿名参与。Cookie 30 天过期后因 Schema 无参与记录过期字段而无法恢复旧记录。

## M-008 正式个人答题与结果恢复

- `GET /api/attempts/questions?tableCode=...` 以 HttpOnly Cookie 和当前桌码解出参与者作用域，再从 Attempt 的 `publication_id -> activity_version` 读取当时绑定的不可变三题；响应只投影 `cueKey`、展示文字、合法选项、本人的已答进度和活动标题，不返回版本原始 JSON、答案键、Attempt ID 或会话令牌。
- `POST /api/attempts/answer` 只接收 `{tableCode,cueKey,optionIndex}`，复用 M-005 `submitAnswer` 事务/唯一约束/完成状态转换。相同答案重试不新增行；已提交题目的不同答案返回冲突；最后一道有效题写入时 M-005 在事务内自动标记 Attempt completed。完成后相同请求通过只读核对返回 duplicate，不再写库；其他答案不得覆盖既有选择。
- `GET /api/attempts/result?tableCode=...` 先校验参与和门店作用域，再复用 M-005 `getSoloResult` 及确定性 `calculateSoloResult`；未完成时不泄露结果。没有引入 AI、双人交互、迁移或新的存储依赖。
- `/play/<tableCode>` 只从服务端重新读取题目和进度；提交成功响应并再次确认服务端状态后才前进，网络中断时可重试。完成后刷新通过已完成 Attempt 取回相同结果。上架活动下架后，只要桌位及门店仍有效，已开始的个人 Attempt 按 M-005 绑定版本继续；桌位/门店停用仍按 M-007 的入口范围拒绝访问。Cookie 生命周期、活动题目 3x3 限制沿用旧规则。
- 正式答题页设置 no-store、no-referrer 和 noindex。`/play/demo` 仍是独立本地演示，不读写数据库。
- M-008 实测基线来自 M-007B 虚构 PostgreSQL：3 条 `in_progress` Attempt、0 条 Submission。一次早期真实 Chrome 检查因测试选择器失配在提交前退出，产生一条未答的虚构 Attempt；没有删除。正式 Chrome 流程创建了另 1 条 Attempt 并完成 3 道不同 cueKey 答题；最终 SQL 为 4 条 `in_progress`（包含旧基线三条和未答测试行）、1 条 `completed`、3 条 Submission、3 个不同 cueKey。正式流程刷新与第二标签重复读取同一结果，记录数不变。
- Playwright 驱动本机 Chrome 的成功记录：开始 `201`；三题提交 `201/201/200`；相同答案重复 `200 duplicate`；不同答案 `409 answer_conflict`；无 Cookie 读题 `401`。375px 和 390px 视口均无横向溢出。API 集成测试从正式 SQL Migration 的 PGlite 实例执行；全套 Vitest 63 项通过，另验证下架 publication 后旧 Attempt 仍使用绑定版本继续答题。
- PostgreSQL 18.6 的 migration 仍为 1 条、public 表 9 张；本任务未修改 SQL Migration。真实 PG 多客户端并发专项为 `NOT_RUN`，顺序浏览器测试不能证明跨客户端锁竞争。

## M-009 双人默契与共同揭晓

- 复用既有 `createPlayGroup`、`joinPlayGroup`、`getPlayGroupState`、`getPlayGroupResult`、`leavePlayGroup` 及 `submitAnswer`，保持九张 Schema 表和既有 SQL Migration 不变。数据库组行 `SELECT ... FOR UPDATE` 串行化加入；真实 PostgreSQL 验收使用两条独立连接确认只有一个邀请加入成功、成员数保持 2 且没有第三条 Attempt。
- 顾客 API 为 `POST /api/play-groups`、`POST /api/play-groups/invitation`、`POST /api/play-groups/join`、`GET /api/play-groups/current`、`GET /api/play-groups/questions`、`POST /api/play-groups/answer`、`GET /api/play-groups/result`、`POST /api/play-groups/leave`。除邀请预览仅需一次性邀请秘密外，所有成员读取、答题和退出都必须使用加入后发出的组队 Cookie；房间 ID、桌码和邀请链接本身不授权成员读取。
- `moonlight_attempt` Cookie 保持 `Path=/api/attempts`。双人凭证使用独立 `moonlight_group_attempt`，HttpOnly、SameSite=Lax、Secure 依 HTTPS/生产环境设置、无 Domain、Path `/api/play-groups`，有效期不超过 15 分钟。服务端只保存 M-005 生成的会话哈希。个人凭证和组队凭证不会互相认证。
- 邀请凭证为 32 字节随机值，仅数据库保留哈希。房主页面把其置于分享链接的 URL fragment；fragment 不随初始页面请求发送。受邀页加载后立即移除 fragment，再通过同源 `POST /api/play-groups/invitation` 获取不含身份数据的门店/玩法摘要；预览不消费邀请、不写库，B 需再次明确同意才 POST 加入。邀请约 15 分钟过期且房间最多两位成员。
- 双人当前状态仅投影本人答题数与朋友是否加入/完成，不含朋友答案、Attempt/PlayGroup ID、令牌或哈希。题目来自本人 Attempt 绑定版本，仅返回题干、三个选项和本人进度。结果端点在两人完成前返回 `result_not_ready`；完成后仅返回双方各自选择、逐题相同/不同和确定性提示，不返回内部记录标识。GET 状态/题目/结果不执行过期状态写入；命令请求会按 M-005 事务处理过期和退出。
- 普通 Publication 下架后，既有参与继续使用绑定版本；Venue 紧急 suspended 会阻断题目、答题、状态及结果读取。加入/答题/退出等写请求要求同源 Origin；接口响应 `no-store`、`no-referrer`、`noindex`，错误不包含数据库细节。页面采用有限 2.5 秒轮询，没有 WebSocket；创建入口也用浏览器 Web Locks 减少同设备多标签重复创建。
- 本地自动化质量：M-009 新增 PGlite＋真实 SQL Migration HTTP handler 覆盖及原个人模式回归。真实 Chrome 使用两个完全隔离 BrowserContext 连到 D 盘 PostgreSQL 18.6；第三上下文重复邀请加入被拒；375/390px 无横向溢出；原个人答题完成且组队 Cookie 未变。D 层并发测试通过两条 `max:1` PostgreSQL 池、不同 `pg_backend_pid` 和测试专用短暂延迟触发器观察真实 Lock wait；测试只追加随机虚构行，不清理历史数据。最终数量与执行记录见本任务验收报告。
- 风险：邀请可以转发，不能证明同桌；无账号意味着没有跨设备恢复；Cookie/房间会在 15 分钟后过期。当前没有跨实例持久化匿名创建限流，浏览器 Web Locks 只减少同设备重复创建，部署前应评估可靠的速率限制。HTTPS、微信内置浏览器、真实移动网络及生产部署尚未验收。
- 依赖审计记录：当前 `npm audit` 报 4 项 moderate（重复/传递项）：`drizzle-kit@0.31.11 -> @esbuild-kit/esm-loader@2.6.5 -> @esbuild-kit/core-utils@3.3.2 -> esbuild@0.18.20`，对应 esbuild <=0.24.2 开发服务器 Origin 边界公告 GHSA-67mh-4wv8-2f99；当前直接 `drizzle-kit` esbuild 0.25.12、Vite esbuild 0.28.2 不在该范围。该链属于开发工具链，不作为部署运行时依赖；audit 给出的 `drizzle-kit@0.18.1` 修复建议会跨大版本降级，本任务未执行自动修复或强制升级。

## M-010 商家认证与门店级授权

- 固定使用 Better Auth `1.7.12`（MIT）及其 PostgreSQL Drizzle adapter；实装前按官方 release 与适配器/Next 集成文档核对稳定版本及 peer 范围。该版本声明支持 Next.js 14/15/16、Drizzle ORM 0.45.2+ 与 pg 8；项目当前 Next.js 16.4.3、Drizzle ORM 0.45.4、pg 8.23.1 满足范围。未升级 Next/Drizzle/pg，也未选 beta/RC。实现采用官方 email/password、Route Handler 与 DB 限流能力，不自制密码散列、会话签名或令牌。
- 新 migration `0001_blushing_sumo.sql` 新增 `auth_users`、`auth_sessions`、`auth_accounts`、`auth_verifications`、`auth_rate_limits` 与 `venue_members` 六张表和 owner/staff、active/disabled 两个枚举；原 M-004 `0000_red_spiral.sql` 与九张玩法表不改写。账号 ID 使用认证库字符串主键，membership 用真实外键关联 `venues` 与认证用户，并保证每用户/门店唯一。
- 不引入 Better Auth Organization/Teams 插件：`venues` 仍是唯一门店权威数据源，`venue_members` 显式关联它。当前权限只需 owner/staff 两个角色和禁用状态；扩展组织、邀请、多层运营角色需另立 ADR。
- 公共邮箱密码注册关闭，认证 Route Handler 即使接收直接注册 HTTP 请求也拒绝。唯一创建工具 `scripts/provision-merchant-local.ts` 仅接受显式 `--local-provision`、非 production、loopback `moonlight_dev` 的 55432 端口、交互输入密码及最终人工确认，不在命令行、输出或源码中设置默认密码。外部生产开户仍须另行建立受控运营流程。
- 会话有效期 12 小时、校验与撤销均由 Better Auth server API/数据库完成；登出删除服务端 session。cookie cache 关闭。商家 session cookie 使用独立 `moonlight_merchant` 前缀、HttpOnly、SameSite=Lax、生产 Secure、Path `/`，不会复用个人 `moonlight_attempt` 或双人 `moonlight_group_attempt`。生产部署需提供至少 32 字符 `BETTER_AUTH_SECRET`、精确 `BETTER_AUTH_URL` 与 HTTPS。
- `createMerchantAuth` 将 trusted origin 限定为配置 URL origin，关闭不可信 proxy header 信任；写请求沿用 Better Auth origin/CSRF 校验。Better Auth DB rate limiter 的邮箱登录规则为每 60 秒最多 5 次，采用 PostgreSQL 存储；不配可信入口 IP header 时不能假定分布式的用户级限速，正式反向代理接入时需先验证并明确可信代理边界。
- `venue-auth.ts` 是 `/staff`、`/admin` 与未来商家 API 的权威 DAL。每请求使用数据库 session 重新识别用户、查询启用账户和 active membership，不信任客户端传入 role；当前门店 ID 必须再经 membership 校验。staff 可读其门店最小资料但不可读 owner API；owner 仅管理自己所属门店。空授权、停用 membership、停用账号、无效 session 与数据库异常均不会被当作授权通过。
- `/login`、`/staff`、`/admin` 和商家 API 禁缓存、no-referrer、noindex；`headers()` 在认证检查前读取，使 Cache Components 在请求时读取授权，阻止静态预渲染配置错误或跨会话私有内容。页面受 Suspense 边界保护，当前版本仍需在任何新的商家页面/API 中复用该 DAL，不以隐藏 UI 代替授权。
- 验收：真实 PostgreSQL 18.6（D 盘、loopback）重复应用 0001 migration；原九张业务表及 M-009 触发器保留，测试不清理历史虚构记录。PGlite 真实 migration 集成测试覆盖 signup 拒绝、散列存储、通用错误、Cookie 属性、登出撤销、限流、same-origin、角色/跨店/禁用。真实 Google Chrome 三个隔离上下文覆盖 owner、staff、无成员账户，退出和旧 cookie、停用 membership/account、跨店 URL/API、signup HTTP、375/390px 布局与私有响应头。随后运行既有 M-009 Chrome + PostgreSQL 脚本，实际完成双人揭晓与个人三题答题；新增游戏行均为随机虚构验收数据。
- 未覆盖部署 HTTPS 反向代理、可信客户端 IP 限流、密钥轮换、账户找回与邮箱验证投递、真实商家运营开户、生产监控、多实例/高并发认证压力；在这些验证完成前不宣称生产就绪。经营报表（M-012）、AI 或平台管理员未实现。

## M-011 商家自助运营

- 商家运营采用 owner 写入、staff 只读：owner 可创建/编辑题包草稿、发布新不可变版本、切换/下架当前活动、管理桌位及轮换桌码；staff 仅可查看当前上架活动概要、桌位名称和启停状态。每个服务端读取和写入单独核对 Better Auth 会话、active `venue_members` 和目标门店；写请求额外核对 `Origin` 与 `Host` 是否匹配可信 origin。
- `activity_templates.draft_content` 保存可持续编辑的题名与 3×3 纯文本题目，cue key 由系统生成并在每个问题槽位编辑时保持稳定。模板原 `title` 不随草稿重命名，保护迁移前版本的历史显示标题；发布时将草稿题名与内容复制到新 `activity_versions.content`。版本仍由既有数据库冻结触发器拒绝更新和删除。
- 新 migration 只增加可空草稿 JSONB 与形状约束；既有模板可保留 null 草稿，新写入需题名、三题和每题三选项。未改写任何已应用 migration 或已冻结版本内容。
- 替换当前活动时事务先锁定门店行，再核对 `expectedCurrentPublicationId`，停用旧 publication 并创建新版本/active publication；既有唯一索引继续保证每店最多一个 active。并发旧请求得到 409 并提示刷新。
- 普通下架阻止新 Attempt 取得当前活动；已开始的个人或双人 Attempt 继续按绑定的旧 Publication/版本读题并提交。普通下架不保证立即撤回进行中的内容；紧急撤回仍需另行设计可审计的停止机制。
- 桌码明文只在成功新建或确认轮换的无缓存响应中返回一次，数据库仅存 SHA-256 哈希。已存在的旧码不会再次显示；轮换后旧码不能创建新参与，现有 Attempt 仍按原绑定版本继续。QR 使用 MIT 许可的 `qrcode` 生成，URL 来源于配置的 `MOONLIGHT_PUBLIC_ORIGIN`（本地缺省复用 `BETTER_AUTH_URL`），不使用请求 Host 拼接公开链接。

## M-013 安全加固与全链路回归

- 顾客与商家写请求以配置的 `MOONLIGHT_PUBLIC_ORIGIN`/`BETTER_AUTH_URL` 为可信 origin；严格比对 `Origin`、入站 `Host` 与 `Request.url` 协议，拒绝跨站 Fetch Metadata，不采信任意 `X-Forwarded-*`。正式反代须保证传到 Next.js 的 URL 协议/host 与配置一致；代理/IP 来源边界留作 M-014 部署验收。
- 公开 API 使用既有 PostgreSQL `auth_rate_limits` 表实现操作级固定窗口计数：SHA-256 key + UPSERT 原子增量，返回 429 与 Retry-After；Better Auth 仍负责登录失败限流。可信 IP 仅可在已清洗、不可被公网绕过的入口显式配置 `MOONLIGHT_TRUSTED_CLIENT_IP_HEADER`；未配置时限流退回匿名资源/会话，不能抵抗换 token/IP 的来源攻击。
- 商家草稿和桌码写事务在写入阶段对当前 owner membership 加行锁并复核 active 状态，避免访问检查与写操作间的撤权竞态；发布/普通下架继续锁门店和 membership。读写均按 venue 和具体对象 ID 双重限定。
- 紧急撤回复用 `venues.status = suspended` 的门店级服务端开关，不改变旧 schema/migrations。active venue 检查覆盖个人/双人题目、答案提交、进度/结果与反馈。正常 publication 下架继续只阻止新参与；轮换桌码使旧码无法开启新参与，但已有匿名 Cookie 仍可继续本次 Attempt。当前 suspend 操作为 DB 运维手动操作，没有带审计 UI。
- 原答案唯一约束与 Feedback attempt 唯一约束负责同值幂等和异值冲突；真实 PostgreSQL 18.6 独立池测试重跑 M-009 末席竞争、M-011 publication 并发，并新增答案、评分竞争、owner/staff/跨店/撤销 member 与 suspend 测试。所有测试只追加随机虚构数据，不删除旧行。
- `.playwright-cli/` 精确加入 ignore，减少后续临时日志误提交，但 ignore 不等于秘密已删除。初次处置被本机策略阻止；后由用户通过普通文件管理器清理。M-013R 复核 `.tmp/m012-e2e.json` 不存在且日志目录剩余 0 个文件。凭证账号/session 的停用与撤销、合成邀请哈希轮换依据此前 PostgreSQL 处置记录；没有删除历史业务数据。
- M-013 未启用新功能/服务或新 schema。上线路径仍需要生产 HTTPS、可信代理和来源限流、密钥/开户流程、紧急停用审计、隐私披露与数据保留规则；依赖 audit 还报告 drizzle-kit/esbuild moderate 链。M-013 本地验证不表示 M-014 ready。
- M-013R2 于 2026-10-26 最终重跑 lint、typecheck、93/5 默认测试、16 项 PGlite schema 测试、production build，均通过；显式启用 `MOONLIGHT_REAL_PG=1` 后 M-009/M-011/M-013 三个真实 PostgreSQL 文件 5/5 通过。五项默认 skipped 的测试名称与独立证据见 [TEST_MATRIX.md](TEST_MATRIX.md)。
- 用户按恢复任务在普通文件管理器清理历史 Playwright 输出及 `.tmp/m012-e2e.json`；复核 fixture 不存在且日志目录剩余 0 个文件。之后通过被 Git 忽略的 `web/.env.local` 配置实际可信 Origin，Origin/CSRF/Host 校验保持启用；真实 Chrome 155 + D 盘 PostgreSQL 全链路现已通过，细项见测试矩阵。
- M-013R 的 `npm audit` 与 `npm audit --omit=dev` 各报 4 项 moderate。`drizzle-kit@0.31.11` 经 Better Auth peer dependency 出现在 production dependency tree，最终落到 `esbuild@0.18.20`；未发现 Better Auth 运行时代码直接导入 CLI/构建工具，利用面未确认。强制 npm 修复会破坏性降级，不自动执行，列为 OPEN P1。

## M-013R2 验收补充

- Chrome 写请求 403 的原因是 `web/.env.local` 中的可信 Origin/Base URL 沿用 `http://localhost:3000`，而 Chrome 与 Next listener 使用 `http://127.0.0.1:3001`。以被 Git 忽略的本机配置统一 `MOONLIGHT_PUBLIC_ORIGIN` 和 `BETTER_AUTH_URL`；备份仅位于 D 盘受 ACL 保护的 `.local/`。不放宽 Origin、Host、CSRF 或代理校验。
- 本地真实 Chrome 155 + PostgreSQL 18.6 回归已通过；具体覆盖、唯一未完成的浏览器级指标 SQL 逐项对账、自动门禁和生产 Release Blockers 见 `TEST_MATRIX.md`、`SECURITY_REVIEW.md`、`RELEASE_BLOCKERS.md`。这项本地验收不表示公网发布就绪。
- 普通桌码轮换使旧码不能创建新 Attempt；已通过本人匿名 Cookie 绑定的合法 Attempt 可继续完成，只要桌位和门店保持 active。轮换不被描述为现有会话撤销。
- 门店状态切为 `suspended` 是紧急停用开关：拒绝个人/双人敏感读取与写入，即使参与已开始；恢复为 `active` 后恢复服务。普通题包下架只阻止新参与，已有 Attempt 仍按绑定的不可变版本继续。当前没有应用内的最小权限状态切换 API 或 append-only 审计表；生产环境不得把直接 SQL 更新冒充为可追责操作。
- M-014 验收只允许在 D 盘虚构数据库和本机回环端口；远程 staging 与公网开放分别需要单独授权。没有供应商、域名、访问控制和远程迁移身份，不创建 staging URL 或宣称 HTTPS 验收通过。
- M-014 将桌码语义明确为：普通轮换阻止旧码启动新参与，但有效匿名凭证可继续已有合法 Attempt；门店紧急暂停会阻断所有顾客敏感读写。正常活动下架仅阻止新参与，历史参与保持绑定不可变版本。该规则是产品决定并有本地浏览器/PG 回归证据，不依赖部署假设。
- M-014 本地真实 Chrome 155 + D 盘 PostgreSQL 18.6 全链路复跑通过；同源/恶意 Origin、Host 和伪造 forwarded headers 的 loopback HTTP 探针结果及其边界见 `docs/STAGING_ACCEPTANCE.md`。B 受限 staging 尚未获外部资源授权，C 公网开放未授权；本地验证不得解释为外部发布验收。
