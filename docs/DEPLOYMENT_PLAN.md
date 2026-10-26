# Moonlight V1 部署方案（M-014 草案）

状态：本地架构评估；没有创建云资源、修改 DNS、推送代码或部署公网服务。价格和能力于 2026-10-26 查阅供应商官方资料，签约前必须复核。

## 推荐目标拓扑

```text
顾客 / 商家浏览器
  └─ HTTPS + 受控访问入口（远程 staging）
       └─ 单个 Next.js 16 Node 服务（Node 24 LTS，next start）
            └─ 同区域私网 PostgreSQL + TLS
                 ├─ 独立迁移作业身份
                 └─ 独立备份、PITR 和隔离恢复目标
```

先使用单一 Node 服务和受管 PostgreSQL，不引入静态导出、Workers、Redis、Kubernetes 或微服务。当前应用依赖 Node `pg`、Better Auth 和服务端 PostgreSQL；`next.config.ts` 未启用 `output: "standalone"`，已验证命令是 `npm run build` + `npm start`。部署前应以实际平台 Node 24 环境重跑构建和启动冒烟。Next.js 自托管文档建议把反向代理放在 Next.js 前面，限制慢请求、异常请求和请求体大小；[Next.js 自托管指南](https://nextjs.org/docs/app/guides/self-hosting)。Next.js 当前最低 Node 版本为 20.9；优先选仍受支持的 Node 24 LTS，并在供应商运行时矩阵确认。[Next.js 安装要求](https://nextjs.org/docs/app/getting-started/installation)。

### 供应商候选

| 候选 | 当前可核实费用 | 地区与 PostgreSQL | HTTPS、备份、网络 | 取舍与结论 |
| --- | --- | --- | --- | --- |
| Render Web + Render Postgres | 官方页面列出小型 Web compute $7/月、小型 Postgres compute $6/月；初始 compute 合计约 $13/月，另核对 storage、出站、税费和 workspace。Pro workspace 另列 $25/月；Hobby/Pro 的 PITR 窗口分别为 3/7 天。实际资源表与限制见[官方价格](https://render.com/pricing)及[备份说明](https://render.com/docs/postgresql-backups)。 | 官方列出 Singapore、Frankfurt、美国多个区；Web 和 DB 应同区使用私网。[地区列表](https://render.com/docs/regions)、[私网](https://render.com/docs/private-network)。 | Web 服务提供 TLS；付费 PG 有 PITR，但逻辑备份和恢复操作仍由项目方演练。私网不能跨 Render 区直接连通。 | **首选候选，尚未选定。** Singapore 是网络试测候选，不代表中国大陆访问、数据驻留或合规已验证。受限访问门禁、地区、备份保留和访问控制要先在账户界面确认。 |
| Railway Web + PostgreSQL | Hobby $5/月最低用量，含 $5 月度 usage credit，超出按实际使用计费；Pro 当前最低用量 $20/月。不是固定总价。[官方价格](https://railway.com/pricing)。 | 有多区部署能力；应先确认服务/数据库是否能选同一区、目标访问地区和供应商数据驻留条款。 | 按使用计费，资源成本需用实际流量和数据库大小估算；访问保护、备份窗口和恢复权限须在计划/项目设置核实。 | 次选。上手简单，但本项目目前没有账户、用量基线或已验证的外部访问控制，不能报总月费。 |
| 自管 VPS + Node + PostgreSQL + Nginx/Caddy | 本轮未选定地区、供应商和规格，**费用待询价**；还要计算备份存储、流量和工程维护时间。 | 地区与网络可自行选择；所有数据库升级、私网、安全组和故障恢复均由运营方负责。 | 必须自行维护 TLS 续期、反向代理、系统补丁、最小权限、监控和备份副本。 | 目前不推荐作为首个试点方案；控制权更高，但夜间值守和恢复责任最大。 |

报价不含税/汇率，未向供应商提交支付信息。若最终试用地点位于中国大陆，还需单独核对域名、备案/跨境服务适用要求、供应商可用性和实测延迟；本任务不作法律结论。

## 运行、安全和发布约定

- 公开 HTTP 仅到供应商 TLS edge；Node upstream 不对公网开放。受限 staging 要有服务端强制访问控制（平台私有访问或经审核的 Access 白名单），不能只隐藏 URL。匿名顾客流程须通过白名单测试者或等价受控入口验证。
- Web 与 PG 同区；应用 DB 使用不具备创建角色/数据库权限的专用用户，迁移作业使用独立一次性身份。PG 不接受公网入站。连接使用供应商推荐的 TLS 校验配置。
- `MOONLIGHT_PUBLIC_ORIGIN` 与 `BETTER_AUTH_URL` 必须是相同 HTTPS origin。反向代理必须保留外部 Host/HTTPS 协议语义；明确只允许的代理入口，剥离客户端提交的 `X-Forwarded-*`，阻断源站直连。仅在确认代理覆盖并净化头之后才设置 `MOONLIGHT_TRUSTED_CLIENT_IP_HEADER`。
- Better Auth、顾客和双人 Cookie 在 HTTPS 验收中检查 Secure、HttpOnly、SameSite、Path、Domain、过期和退出；Origin/CSRF 校验不得关闭。CORS 不使用 `*`。
- 迁移是单独、可审计的发布作业，不在每个 web 实例启动时自动执行。当前 `db:migrate:local` 只允许 loopback；普通 `drizzle.config.ts` 没有可用的远程连接设置。**远程迁移 runner 尚未实现，不能把本地 migration 命令直接用于 staging。**先建立单次、显式 opt-in 的部署迁移作业并经过 review，再授权远程验证。
- 变更前记录当前 artifact/version、migration 历史、备份时间和回滚版本；失败先暂停流量，回滚应用镜像。已执行且不可逆的 migration 不能靠降级代码恢复，须使用已演练的隔离恢复/向前修复。
- 紧急暂停由有权限的负责人执行，状态变更应可追踪；`venues.status=suspended` 会阻断顾客敏感读写。当前没有应用内带审计的停用/解除接口，因此该操作流程未达到值班可用门槛。

## 公网开放前的授权门槛

需单独确认供应商、付费计划/预算、地区、访问控制、测试域名/DNS、秘密管理与证书、远程 migration 身份、实际受限 staging 部署授权。M-014 不会自动执行这些外部操作，也不等于真实酒馆开放批准。
