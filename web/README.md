# Moonlight Web

这是 Moonlight V1 唯一的 Next.js 应用。产品边界、开发状态和完整启动说明见仓库根目录的 [README](../README.md)。

```powershell
npm ci
npm run dev
```

开发服务器默认监听 `http://localhost:3000`。

## 数据库基础

- `src/db/schema.ts` 是 15 张 PostgreSQL 表的 Drizzle schema；`drizzle/` 是受版本控制的 SQL migration。M-010 新增商家认证/门店成员表，并保留旧 migration。
- `npm run test:db` 在每个测试独立创建的 PGlite 内存实例执行迁移并验证约束，不读取 `DATABASE_URL`。
- `npm run db:generate` 只生成 migration，不连接数据库。生成后需审查 SQL。
- `npm run db:migrate:local` 需要显式设置 `DATABASE_URL`，且配置会拒绝非 loopback 地址。命令不会启动 PostgreSQL。
- 商家身份由 Better Auth 管理。`BETTER_AUTH_SECRET` 至少 32 字符；`BETTER_AUTH_URL` 必须是可信任的应用 HTTPS origin（本机可用 localhost）。公开 email signup 已关闭。
- 桌码 QR 使用 `MOONLIGHT_PUBLIC_ORIGIN`（未设置时回退到 `BETTER_AUTH_URL`）构造可信顾客入口；公网部署必须配置 HTTPS origin，不能由请求 Host 推导。
- M-011 草稿 JSONB 保存在 `activity_templates.draft_content`。题名随草稿保存；发布时题名和 3×3 题目复制到新的冻结 `activity_versions.content`。新增迁移兼容旧空草稿且不修改已冻结版本。
- 商家运营采用 owner 写入、staff 只读：staff 只能查看当前活动概要和桌位状态。桌位新增/轮换只在一次性响应中返回原码和打印 URL，表内继续只保存 SHA-256 哈希。
- 受控本地建号可使用 `node --import tsx scripts/provision-merchant-local.ts --local-provision`。它要求交互终端及显式确认，且只接受 `127.0.0.1:55432/moonlight_dev`；调用前需在当前进程设置 `DATABASE_URL`，不要把密码放命令行或写入仓库。
- `npm run db:seed:m007b:local` 从 `web/.env.local` 读取连接，仅允许 `localhost`/loopback 上的 `moonlight_dev`；使用稳定主键插入虚构验收数据，已存在数据必须与预期一致，否则回滚并退出。有效桌码保存在被忽略的 `D:\moonlight\.local\m007b-fixture.json`。
- 当前没有生产迁移命令；PGlite 测试不替代在真实 PostgreSQL 上的部署前验收。
