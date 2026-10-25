# Moonlight V1 决策记录

## 当前产品形态

- 服务大学城社交型小酒馆。
- 无大屏，以桌面二维码引导顾客在手机 H5 随时轻互动。
- 个人模式必须可用，顾客可以独自开始和完成一轮玩法。
- 双人顾客页面、联机 API 与商家正式功能仍留待后续任务；M-005 只建立未对外开放的服务端领域规则。
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
- PGlite 用真实 M-004 SQL migration 驱动集成测试，覆盖事务、唯一约束、同意/权限、答案幂等、状态与过期。PGlite 为单连接测试环境，不证明 PostgreSQL 多连接锁等待与并发抢占；M-013 及真实组队开放前必须在真实 PostgreSQL 验证两到三客户端抢位、锁等待、超时和重试。
- 双人状态映射为 `open -> waiting`、`paired -> ready`，完成状态从两名成员均 completed 派生；Schema 枚举没有 completed/abandoned 组状态，分别以派生结果和 `cancelled`/`expired` 表达，不新增迁移。

## M-006 桌码入口与顾客首页

- `/t/<tableCode>` 是动态服务端只读页面；原始桌码只用于 SHA-256 查找，不作为主键或认证。公开投影仅含门店名、当前有效活动标题和题数，查询复用 M-005 的活动可用性校验；不返回内部 ID、内容快照、答案或令牌。
- 无效桌码走 Next.js 友好 not-found 页面；由于该动态页面以 Suspense 流式响应，运行时无效桌码响应状态为 HTTP 200（soft 404），页面 noindex。停用桌位、停用门店、无当前活动和数据库不可用有各自状态文案。桌码页设置 `no-store`、`no-referrer` 和 `noindex`，不在页面日志中记录原始码或底层错误。
- 桌码页的个人入口只链接现有 `/play/demo`，并说明演示不保存记录；双人入口明确尚未开放。该页面不创建 Attempt、Submission、PlayGroup，也不引入公开 API。
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
