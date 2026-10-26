# Moonlight 环境变量矩阵

只记录变量名称、用途和约束，不存放当前本机 URL、密码或 Secret。预发布/生产值只允许通过平台密钥管理设置；不得把 `web/.env.local` 复制到部署环境。

| 变量 | Local | Staging / Production | 来源与校验 |
| --- | --- | --- | --- |
| `DATABASE_URL` | 可选；本机 loopback PostgreSQL；不得打印或放命令行参数 | 必填，指向同区域私网 PostgreSQL，启用供应商支持的 TLS 证书校验。仅应用最小权限用户可用 | `web/src/db/index.ts`；格式为 PostgreSQL URL。迁移作业使用独立、短期权限身份。 |
| `BETTER_AUTH_URL` | 本地可信 HTTP loopback origin | 必填，公开 HTTPS origin | Better Auth Base URL 和 trusted origin；至少一个 origin，无路径/查询/片段。 |
| `BETTER_AUTH_SECRET` | 每台开发机独立随机值，至少 32 字符 | 必填，由密钥管理系统提供；与本地、测试和其他环境隔离 | 不能写进 `.env.example`、Git、构建产物或日志；轮换须遵守会话失效方案。 |
| `MOONLIGHT_PUBLIC_ORIGIN` | 与本地浏览器实际 Origin 一致；可在代码中回退 `BETTER_AUTH_URL` | 必填，与 `BETTER_AUTH_URL` 完全相同的 HTTPS origin | 顾客写 API 同源检查与二维码 URL；不能从任意请求 Host 拼接。 |
| `MOONLIGHT_TRUSTED_CLIENT_IP_HEADER` | 默认不设置；loopback 测试不信任客户端 IP 头 | 只有 ingress 会覆盖同名头、清除客户伪造值且源站被封闭时才设置为 `x-real-ip` 或 `cf-connecting-ip` | 代码仅校验头名和值的 IP 格式，不验证请求是否来自可信代理；配置本身不构成代理信任。 |
| `NODE_ENV` | `development` 或测试工具设置的 `test` | 平台设为 `production` | 生产 Cookie `Secure` 行为依赖 production；不能在公网服务设置为 development。 |
| `PORT` / `HOSTNAME` | Next 默认值或本机显式端口 | 平台提供；监听只绑定容器/内部接口，不暴露 PG 或内部管理端口 | `npm start` 使用 `next start`；平台需验证其端口注入方式。 |
| `MOONLIGHT_REAL_PG` | 仅在本地隔离数据库专项测试临时设为 `1` | 不设置 | 启用 5 个需要真实 PostgreSQL 的专项测试；不得放进服务运行环境。 |
| `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` | 不设置 | 仅当实现 Access JWT origin verifier 后，由配置提供 issuer 和指定 application audience | 当前代码没有读取这两个变量；设置值本身不启用 Cloudflare Access 验签。 |
| `MIGRATION_DATABASE_URL` | 不设置 | 仅提供给未来 staging-only one-off migration job | 提议变量，runner 和独立 DB role 尚未实现；不能传给 Web runtime。 |

Railway 的平台变量 `PORT` 由平台注入；Cloudflare Tunnel token 只注入 tunnel service，不传给 Next Web service。具体的 Railway/Cloudflare 准备与绕过设计见 [STAGING_HANDOFF.md](STAGING_HANDOFF.md)。

## 样例占位

下面仅表示格式；`<...>` 是说明性占位符，不是可直接复制的值：

```dotenv
DATABASE_URL=<postgresql://APP_USER:PASSWORD@PRIVATE_HOST:5432/DB_NAME?sslmode=verify-full>
BETTER_AUTH_URL=<https://STAGING_HOST>
BETTER_AUTH_SECRET=<SECRET_MANAGER_REFERENCE>
MOONLIGHT_PUBLIC_ORIGIN=<https://STAGING_HOST>
MOONLIGHT_TRUSTED_CLIENT_IP_HEADER=<x-real-ip|cf-connecting-ip; only after ingress verification>
NODE_ENV=production
```

不要把样例直接保存为可运行环境文件。环境缺失时应用应 fail closed：不启动商家认证/数据库功能，不回退到公开或猜测出来的 origin。远程环境变量尚未创建或验证。
