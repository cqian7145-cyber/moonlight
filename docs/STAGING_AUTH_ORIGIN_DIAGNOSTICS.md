# Staging 商家登录 Origin 临时诊断

本次只添加本地诊断代码；未访问 Railway、未连接远端数据库、未 Push 或部署，未修改账号、Runner、CSRF、Origin、代理头信任或 Cloudflare Access 策略。

## 审计发现

- `getMerchantAuth()` 使用 `BETTER_AUTH_URL` 创建并缓存认证实例；`createMerchantAuth()` 将 URL 归一到 origin，设置 `trustedOrigins: [baseUrl.origin]`，并保持 CSRF、Origin 校验开启、`trustedProxyHeaders: false`。
- 本地安装的 Better Auth 1.7.12 在每个 HTTP 请求中解析实际 `trustedOrigins`，也可能合并库支持的额外可信来源配置。`onRequest` 插件接收到的上下文是本次请求实际使用的上下文；此钩子位于 Origin 中间件之前、库自身的限流检查之后。被限流提前返回的请求不会产生该诊断行。
- 诊断读取 `context.baseURL`（可能带 `/api/auth`）和 `context.trustedOrigins`，不通过环境变量重新推算，不通过请求 Host 重建认证配置。
- 若实际 Origin 与实际可信来源完全匹配，当前静态配置本应允许 Origin 检查。现有信息不足以确认线上根因；应先排除旧部署/旧认证实例、环境配置与实际请求头不一致，不应先开启代理头信任或放宽可信来源。

## 开关与日志范围

只在运行时变量 `MOONLIGHT_AUTH_ORIGIN_DIAGNOSTICS=1` 时启用；缺失、`0` 或 `true` 都不启用。仅匹配 `POST /api/auth/sign-in/email`，不读取 query、body、Cookie、Authorization，也不输出整个请求、上下文、错误或进程环境。

日志前缀为 `[moonlight-auth-origin-diagnostic]`，JSON payload 严格只有六个字段：`Origin`、`trustedOrigins`、`baseURL`、`Host`、`X-Forwarded-Host`、`X-Forwarded-Proto`。缺失的请求头记为 `null`；JSON 编码防止头值中的换行被展开为额外日志行。诊断不会修改请求、响应或认证决策；日志输出失败被静默忽略。

## 获得授权后的人工部署步骤

1. 先审查本次文件清单与 diff，保留现有未提交文件。确认 Railway Web 实际关联分支、Autodeploy、Watch Paths 和当前部署提交；Push 可能触发自动部署。本次未核验 Dashboard，不能承诺 Push 不影响当前 Web。
2. 在单独获得 Push/部署授权后，仅发布经审查的诊断改动。先保持诊断变量未设置，核对新 Web 部署的提交与健康状态；不要修改 Postgres、migration、建号 Runner 或任何数据库变量。
3. 在 Railway **Web 服务运行时变量**中短暂设置 `MOONLIGHT_AUTH_ORIGIN_DIAGNOSTICS=1`，按平台正常流程应用变量并确认新实例生效。不要改认证 URL、trustedOrigins、代理头信任、Cloudflare Access 或 CSRF 设置来凑通过。
4. 获授权操作者通过既有 Access 白名单，在 `https://moonlight.xizimist.com/login` 人工发起一次登录。密码只输入浏览器密码框，不发送给 Codex、不写脚本/命令/日志。不要导出 HAR 或全量请求头。
5. 只查看以该前缀开头的 JSON 行，对比实际 Origin、实际 trustedOrigins、实际 baseURL 与三个代理相关头。若无日志，先确认开关、部署提交、请求路径及是否先触发限流；不要提高重试频率。仅分享上述六字段，避免复制其他平台日志中的敏感内容。
6. 采集一次足够证据后，立即删除该变量或改为 `0`，按正常流程应用，并确认后续登录不再产生诊断行。保留日志按现有访问权限与保留策略管理；定位完成后另行移除临时代码。

实际线上根因和登录修复仍待上述受控取证；本地 HTTP/PGlite 测试不能代替 Railway、Cloudflare 和真实 Chrome 验证。
