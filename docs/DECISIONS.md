# Moonlight V1 决策记录

## 当前产品形态

- 服务大学城社交型小酒馆。
- 无大屏，以桌面二维码引导顾客在手机 H5 随时轻互动。
- 个人模式必须可用，顾客可以独自开始和完成一轮玩法。
- 双人默契与房间联机属于后续 M-007～M-009，不作为当前默认体验。
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
