# PostgreSQL 备份与恢复演练手册

状态：M-014 本地隔离演练已通过；这些结果不代表生产备份已经配置。历史 `moonlight_dev` 未被清空、迁移或恢复覆盖。

## 本地可复现演练

本次复用 D 盘现有 PostgreSQL 18.6 二进制，在 `.local/m014/pg-data` 创建独立 cluster，端口 `55433`，只监听 `127.0.0.1`，host 认证使用 SCRAM。演练目录/归档在 Git 忽略的 `.local/m014/`，ACL 限制为当前 Windows 用户、SYSTEM 和本地 Administrators；该集群不是 Windows 服务。测试 role `moonlight_m014_app` 非超级用户、不能创建数据库；它仅拥有新建的 source 和 restore DB。所有内容均为虚构数据。

```powershell
# 仅在已创建的 D 盘 M-014 演练集群使用；运行前将密码从受保护的本机秘密存储注入进程环境。
$pg = 'D:\moonlight\.tools\postgresql-18.6\pgsql\bin'
$env:DATABASE_URL = '<loopback test URL for moonlight_m014_source>'
Set-Location D:\moonlight\web
npm run db:migrate:local
# 重跑同一命令以确认已应用 migration 不重复执行。
npm run db:migrate:local
Remove-Item Env:\DATABASE_URL

# 使用受保护的 PGPASSWORD/PGPASSFILE 注入连接口令；不要将口令写在命令行或 shell 历史。
& "$pg\pg_dump.exe" -h 127.0.0.1 -p 55433 -U moonlight_m014_app `
  -d moonlight_m014_source -Fc --no-owner --no-acl `
  -f 'D:\moonlight\.local\m014\source.dump'

& "$pg\pg_restore.exe" -h 127.0.0.1 -p 55433 -U moonlight_m014_app `
  -d moonlight_m014_restore --no-owner --no-acl --exit-on-error --single-transaction `
  'D:\moonlight\.local\m014\source.dump'
```

演练中第一次与第二次 `npm run db:migrate:local` 均 exit 0；source 和全新 restore 数据库均保留四条既有 migration 记录、15 张 public 表。`pg_dump -Fc` 与 `pg_restore --single-transaction` 均 exit 0。独立 SQL 对比源库和恢复库，所有计数一致：auth user/session 1/1，venue/member/table/template/version/publication/play group 1/1/1/1/1/1/1，Attempt 3、Submission 9、Feedback 3。另校验 3 个匿名参与哈希与 1 个邀请哈希均为 64 位 SHA-256 形式，auth session 与成员、双人 Attempt 与唯一 room、publication 与版本的关联各存在。输出只包含汇总计数，不含 session token 或桌码原文。

## 生产建议（尚未配置）

1. PostgreSQL PITR 与逻辑导出并行：至少每日一次加密逻辑备份，建议保留 30 个日备份；PITR 目标至少 7 天。备份副本应位于独立账户/故障域，访问需 MFA、最小权限和操作审计。实际恢复目标 RPO/RTO 由试点负责人批准后再定。
2. 每季度以及每次重大 schema 变更后，把 PITR 或逻辑备份恢复到**新的隔离数据库**；核对 migration 历史、表/索引、记录数、外键、活动版本、反馈关系和认证会话撤销策略。不得把恢复目标直接切成主库。
3. 仅在隔离恢复核验通过后，按变更流程更新服务连接；保留原主库为只读回退点，直到业务抽查通过。数据库回滚不是应用降级的自动副作用。
4. 发布前需确定 PG TLS 校验、app 与 migration 的独立账号、备份加密密钥保管、告警负责人、失败补跑和恢复审批人。

当前生产备份、PITR、异地复制、告警和真实 RPO/RTO 均为 **NOT CONFIGURED / NOT TESTED**。D 盘 `.local/m014/source.dump` 是虚构数据的本地演练产物，不得上传至任何远程服务。
