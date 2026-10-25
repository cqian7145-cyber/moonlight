# Moonlight

Moonlight V1 面向大学城社交型小酒馆：不依赖大屏，顾客扫描桌面二维码即可在手机 H5 里随时轻互动。当前优先验证个人模式的完整体验。

## 技术栈

- Next.js 16.x App Router、React、TypeScript、Tailwind CSS
- Node.js 24.x
- 数据模型采用 PostgreSQL + Drizzle；SQL 迁移由 Drizzle Kit 生成并纳入版本控制
- 数据库集成测试在进程内 PGlite 执行，不依赖 Docker；PGlite 不是生产存储

## 本地开发

```powershell
New-Item -ItemType Directory -Force D:\moonlight\.cache\npm, D:\moonlight\.tmp | Out-Null
$env:npm_config_cache = 'D:\moonlight\.cache\npm'
$env:TEMP = 'D:\moonlight\.tmp'
$env:TMP = 'D:\moonlight\.tmp'
Set-Location D:\moonlight\web
npm ci
npm run dev
```

访问 <http://localhost:3000>。开发依赖、npm 缓存和构建产物位于仓库及其 `.cache`、`.tmp` 目录中。

## 当前能力

- 首页介绍“酒馆扫码即玩”，可进入个人趣味题演示。
- `/t/<tableCode>` 是正式只读桌码入口：校验哈希桌码并读取门店当前有效上架活动；需要配置 PostgreSQL `DATABASE_URL`，本地没有默认样例数据。
- `/play/demo` 提供三道本地选择题、确定性趣味结果和重新开始。
- `/staff`、`/admin` 仅说明尚未开发。
- `/api/health` 提供不依赖数据库的健康检查。
- `web/src/db/schema.ts` 定义 9 张 V1 游戏数据表；`/play/demo` 仍是独立前端演示，不读写数据库，也不代表正式参与记录。
- `web/drizzle/` 保存迁移。可运行 `npm run test:db` 验证迁移和 PostgreSQL 约束，无需配置数据库。
- `npm run db:migrate:local` 仅接受 loopback PostgreSQL URL；它不会启动数据库。没有生产迁移命令。

## 尚未实现

顾客匿名参与写入、答案提交、双人联机业务流程、登录、正式商家后台、AI、微信小程序、支付、上线及顾客数据采集均未实现。桌码入口只读门店当前上架活动；没有 `DATABASE_URL` 时页面显示暂不可用，不会生成演示门店或参与记录。数据库 schema 是后续业务开发的基础，不代表已有可部署的后端。

## 目录

- `web/`：唯一的 Next.js Web 应用
- `docs/DECISIONS.md`：公开安全的产品边界与技术决策
- `AGENTS.md`：项目工作规则

内部产品材料、任务文件、PDF、环境变量、依赖、缓存和构建产物由根目录 `.gitignore` 排除；公开仓库只提交经过审查的安全文件。
