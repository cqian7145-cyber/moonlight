# M-014S2｜Railway＋Cloudflare Staging 成本估算

预算上限：**USD 10/月**。本文件用 Railway 公开单价建立容量场景，不是账户报价；未创建服务，未使用 Cloudflare/Railway Dashboard。实际用量、最低实例配置、备份能力、税费、域名续费、账单币种、账户优惠和额外功能需获批后核验。

## Railway 当前公开计价基线

Railway 定价文档当前列出 Hobby USD 5/月、资源单价 RAM USD 10/GB-month、CPU USD 20/vCPU-month、egress USD 0.05/GB、volume USD 0.15/GB-month。Hobby 的订阅抵扣资源用量：若资源用量 USD 3，则总计为 USD 5；若资源用量 USD 8，则总计为 USD 8。实际以账户 plan 和账单为准。

估算包含三个 24/7 服务：Next Web、PostgreSQL、cloudflared。Postgres volume 和公开流量也计入。Cloudflare side 仅暂按现有 Zero Trust Free 可用时 USD 0 建模；这不是确认后的承诺。暂不含域名购买/续费、备份/PITR 超额、税费和其他 workspace 服务。

| 场景 | Web 平均 RAM / CPU | PostgreSQL 平均 RAM / CPU | Tunnel 平均 RAM / CPU | PG volume / egress | 月资源估算 |
| --- | --- | --- | --- | --- | ---: |
| 极乐观容量假设 | 0.25 GB / 0.05 vCPU | 0.25 GB / 0.05 vCPU | 0.125 GB / 0.025 vCPU | 1 GB / 5 GB | RAM $6.25 + CPU $2.50 + volume $0.15 + egress $0.25 = **$9.15**；Hobby 账单估算约 $9.15。 |
| 温和常驻假设 | 0.50 GB / 0.10 vCPU | 0.50 GB / 0.10 vCPU | 0.125 GB / 0.025 vCPU | 2 GB / 10 GB | RAM $11.25 + CPU $4.50 + volume $0.30 + egress $0.50 = **$16.55**；超预算。 |

这是“平均消耗 × 按月单价”的敏感性场景，不是 Railway 最低配置，也不是性能承诺。Web 构建/运行峰值、PostgreSQL 缓存、并发访问、备份、外发日志或应用重启都可能提高用量；$9.15 场景只有 $0.85 余量，因此不能据此承诺三服务可长期低于 $10。

## 预算控制建议

1. 先在独立 Staging Workspace 中确认计划、三服务的最小可运行配置、PostgreSQL storage/backup 计价及是否有最低消耗。若估算或实际 bill projection 超过 USD 10，停止部署；不要通过删备份、开放公网 DB、关闭安全检查或使用不稳定实例来压价。
2. 由账单负责人在 Workspace 设置例如 USD 7 的 compute email alert 和 USD 10 的 compute hard limit。Railway 文档说明达到 hard limit 会将该 Workspace 所有 workloads 下线以停止更多 compute 用量；这会造成 Web、PG、Tunnel 同时停止。应使用仅包含该 Staging 的隔离 Workspace，避免影响其他应用。
3. Hard limit 是资源用量停机护栏，不是税费、订阅、域名、备份、Cloudflare 或其他外部账单全包保证；实际是否能设置所需阈值、对哪些服务生效必须在 Dashboard 复核。Phase A 未更改任何 limit。
4. 不按长期 Serverless 假设计价：若启用 serverless 导致 Web 休眠，Tunnel 到 Web 的冷启动、访问延迟、DB 连接与 healthcheck 必须先实测；cloudflared 与 PostgreSQL 也仍需按实际用量计费。

## 预算决策

当前结果：**CONDITIONAL / 尚未证明 USD 10/月可满足**。极乐观计算贴近上限，较普通常驻假设会达到约 USD 16.55/月。需要在未创建服务前确认 Railway 资源配置与预估；Phase B 只应在可接受预算、独立 Workspace hard limit 和备份成本已审批后继续。

价格来源（核对日期 2026-10-27）：

- [Railway pricing](https://docs.railway.com/pricing)
- [Railway cost control](https://docs.railway.com/pricing/cost-control)
- [Railway private networking](https://docs.railway.com/networking/private-networking)
- [Cloudflare Zero Trust getting started](https://developers.cloudflare.com/cloudflare-one/setup/)
