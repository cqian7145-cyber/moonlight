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
- 顾客点击「自己玩」后，`POST /api/attempts/start` 创建或恢复匿名个人参与；`GET /api/attempts/current?tableCode=<tableCode>` 通过 HttpOnly Cookie 读取状态。接口不接收客户端 Attempt/Venue/Publication ID，不返回会话令牌或答案。
- `/play/demo` 提供三道本地选择题、确定性趣味结果和重新开始。
- `/staff`、`/admin` 仅说明尚未开发。
- `/api/health` 提供不依赖数据库的健康检查。
- `web/src/db/schema.ts` 定义 9 张 V1 游戏数据表；`/play/demo` 仍是独立前端演示，不读写数据库，也不代表正式参与记录。
- Cookie 名为 `moonlight_attempt`，HttpOnly、SameSite=Lax、Path=`/api/attempts`、30 天有效；生产响应设 Secure（生产部署应使用 HTTPS），开发模式的本地 HTTP 不设 Secure。`next start` 的本地生产构建也设 Secure；Chrome 可在 localhost 接受该 Cookie，但这不代表局域网 HTTP 可用。写请求要求 Origin 与入站 Host/协议同源，缺少 Origin 时拒绝。
- `web/drizzle/` 保存迁移。可运行 `npm run test:db` 验证迁移和 PostgreSQL 约束，无需配置数据库。
- `npm run db:migrate:local` 仅接受 loopback PostgreSQL URL；它不会启动数据库。没有生产迁移命令。

### D 盘隔离 PostgreSQL 验收

本机验收实例使用 PostgreSQL 18.6 EDB 官方免安装二进制 ZIP，仅监听 `127.0.0.1:55432`，不注册 Windows 服务；工具、数据、日志和本地凭证分别保存在被忽略的 `.tools/`、`.local/` 和 `web/.env.local` 中。开发应用账号 `moonlight_app` 仅拥有本地 `moonlight_dev` 数据库，不是超级用户；主机连接使用 SCRAM。

首次配置只在本机进行，不应把数据库目录、`web/.env.local` 或 `.local/m007b-fixture.json` 提交到 Git。实例启停和 M-007B 假数据可按以下方式操作：

```powershell
$pg = 'D:\moonlight\.tools\postgresql-18.6\pgsql\bin'
& "$pg\pg_ctl.exe" -D 'D:\moonlight\.local\postgres-data' -l 'D:\moonlight\.local\postgres-log\server.log' -w start
$env:DATABASE_URL = (Get-Content 'D:\moonlight\web\.env.local' | Where-Object { $_ -like 'DATABASE_URL=*' } | Select-Object -First 1).Substring(13)
Set-Location D:\moonlight\web
npm run db:migrate:local
npm run db:seed:m007b:local
Remove-Item Env:\DATABASE_URL
& "$pg\pg_ctl.exe" -D 'D:\moonlight\.local\postgres-data' -m fast -w stop
```

seed 只插入固定 ID 的虚构 Venue、桌位、题包、不可变版本和上架状态；重复运行会核对现有内容，不覆盖或删除数据。有效桌码由本机脚本随机生成并保存到被忽略的 fixture 文件。需要备份时，用 `pg_dump -h 127.0.0.1 -p 55432 -U moonlight_app -d moonlight_dev -W -F c -f D:\moonlight\.local\moonlight_dev.dump`，交互输入密码；不要把备份移入公开仓库。

## 尚未实现

答案提交、判分和结果页、双人联机业务流程、登录、正式商家后台、AI、微信小程序、支付和上线均未实现。桌码页的参与创建需要已配置的 PostgreSQL `DATABASE_URL`；没有数据库时页面与 API 安全地显示/返回暂不可用，不会生成演示门店或伪造参与记录。数据库 schema 和本地 PGlite 测试不代表已有可部署的生产后端。

## 目录

- `web/`：唯一的 Next.js Web 应用
- `docs/DECISIONS.md`：公开安全的产品边界与技术决策
- `AGENTS.md`：项目工作规则

内部产品材料、任务文件、PDF、环境变量、依赖、缓存和构建产物由根目录 `.gitignore` 排除；公开仓库只提交经过审查的安全文件。
