# Moonlight Web

这是 Moonlight V1 唯一的 Next.js 应用。产品边界、开发状态和完整启动说明见仓库根目录的 [README](../README.md)。

```powershell
npm ci
npm run dev
```

开发服务器默认监听 `http://localhost:3000`。

## 数据库基础

- `src/db/schema.ts` 是 9 张 PostgreSQL 表的 Drizzle schema；`drizzle/` 是受版本控制的 SQL migration。
- `npm run test:db` 在每个测试独立创建的 PGlite 内存实例执行迁移并验证约束，不读取 `DATABASE_URL`。
- `npm run db:generate` 只生成 migration，不连接数据库。生成后需审查 SQL。
- `npm run db:migrate:local` 需要显式设置 `DATABASE_URL`，且配置会拒绝非 loopback 地址。命令不会启动 PostgreSQL。
- 当前没有生产迁移命令；PGlite 测试不替代在真实 PostgreSQL 上的部署前验收。
