# gateway/remote.json：隧道（tunnel）模式的配置

`remote.json` 只在 `start.ps1 -Mode tunnel` 和 `status.ps1` 里被读取，字段名必须和下面的示例一致：

| 字段 | 谁读 | 用途 |
| --- | --- | --- |
| `publicBaseUrl` | `start.ps1`、`status.ps1` | 打印「手机该填的地址」：公网入口的完整 URL，带 `https://` 和结尾 `/` |
| `allowedOrigins` | `start.ps1` | 逐项拼成 `HANA_GW_ALLOWED_ORIGINS`（逗号分隔）交给网关，用于写请求的 Origin 校验；每项只能是一个 Origin，写错就让启动失败 |
| 其他字段 | 不读 | 写了也被忽略 |

示例见同目录 `remote.json.example`，JSON 不支持注释，所以说明写在这里：

```json
{
  "publicBaseUrl": "https://your-tunnel-host.example.com/",
  "allowedOrigins": ["https://your-tunnel-host.example.com"]
}
```

## 怎么用

1. 复制一份改名成 `remote.json`（脚本**不会**自动创建，也不会覆盖）。
2. 把 `your-tunnel-host.example.com` 换成你自己的隧道域名，**不要**保留 example.com。
3. 启动：`pwsh -NoProfile -File gateway\start.ps1 -Mode tunnel`

## 注意

- `allowedOrigins` 每项只写一个 Origin：`scheme://host[:port]`，scheme 只能是 `http` 或 `https`。结尾多一个 `/` 会被规范化掉；再带路径、查询串、片段、userinfo（`user:pass@`）、空白或逗号都不合法。
- 非法项的语义是**启动失败**，不是“静默忽略”：`start.ps1` 先把每一项交给 `gateway/security-policy.mjs` 的 `validateAllowedOrigin`（`node gateway/security-policy.mjs --check-origins`），只要有一项不合法就报出原因并退出；就算绕过脚本直接把 `HANA_GW_ALLOWED_ORIGINS` 塞给网关，服务端也按同一份实现严格解析，配错同样起不来。这样不会出现“以为放行了、实际少了一条、手机端写请求 403 却查不到原因”。
- 校验只有一份实现（`security-policy.mjs`），PS 脚本里不再另写正则：两边规则一旦漂移，最危险的情况是一边放行一边拒绝。
- 隧道要转发到本机 `127.0.0.1:24000`。公网 HTTPS 转到本机 HTTP 时，scheme 已经不同；即使保留原始 `Host`，仍须把公网 Origin 写进 `allowedOrigins`。命中该名单可通过写请求与 WS 的 Origin 校验，不要求 Host 同时相同。
- 不用 tunnel 模式时这个文件存在也没影响：`usb` / `lan` / `tailscale` 模式都不读它。
- 这里只有公开的入口地址，不放 token、cookie 之类凭据；真要有凭据也别写进这个文件，网关不读。

## 公网 TLS 在网关外终止：`HANA_GW_EXTERNAL_HTTPS`

tunnel 模式下 `start.ps1` 会自动给网关注入 `HANA_GW_EXTERNAL_HTTPS=1`（不管有没有 `remote.json`）。网关把它当作“浏览器看到的是 https”，影响两处：

- 上游签发的 `Set-Cookie` 逐条补 `Secure`（网关自己跑 HTTP 时不会补）；
- 卡片 CSP 里给浏览器解析的绝对地址前缀（`script-src` / `img-src` / `connect-src` 等）用 `https://<Host>/gw/card/...` 打头；本机监听的 `http://<Host>/gw/card/...` 同时保留，所以直接开 `http://127.0.0.1:24000` 看本地页时卡片仍能加载。

约定：**绝不读 `X-Forwarded-Proto`**。那个头客户端也能伪造，用它决定 Security 相关属性等于把策略交给调用方。

### 这个变量归 `start.ps1` 管，自建反代请照下面两条走

`start.ps1` 把 `HANA_GW_EXTERNAL_HTTPS` 当成自己管的受管变量：

- `-Mode tunnel`：注入 `1`；
- `-Mode usb` / `lan` / `tailscale`：显式注入**空值**（等于清空）。你事先在 shell 里 `export`/`$env:` 设的值同样会被清掉，不会带进网关。

所以“先手工设 `HANA_GW_EXTERNAL_HTTPS=1`，再用 `start.ps1` 启动”是**走不通**的，公网反代只有两条可行路径：

1. **用 tunnel 模式**（推荐）：`pwsh -File gateway\start.ps1 -Mode tunnel`，本地仍然监听 `127.0.0.1:24000`，把 Nginx / Caddy 反代到那里。公网 HTTPS Origin 必须写进 `remote.json` 的 `allowedOrigins`，不能只靠保留 Host。`HANA_GW_EXTERNAL_HTTPS` 由脚本注入。
2. **绕过 start.ps1，自己带环境变量直接起网关**：把 `HANA_GW_EXTERNAL_HTTPS=1`（以及 `HANA_GW_HOST` / `HANA_GW_PORT` / `HANA_GW_ALLOWED_ORIGINS` 等）放进进程环境后直接 `node gateway\server.mjs`。这条路径没有守护进程和自动重启，`gateway\stop.ps1` 也不会认它。

建议两种路径都保留原始 `Host`。这不是命中 `allowedOrigins` 后的额外鉴权条件；但卡片 CSP 仍按请求 Host 生成绝对地址。改写 Host 时，即使 API 与 WS 通过校验，卡片资源仍需另外核验。

## 可调环境变量

这些不是 `remote.json` 的字段，是给网关进程的环境变量；默认值够用时不用碰。

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `HANA_GW_EXTERNAL_HTTPS` | 未设 | 公网 TLS 在网关外终止时设 `1`：`Set-Cookie` 补 `Secure`，卡片 CSP 用 `https://` 前缀。**由 `start.ps1` 管理**：只有 tunnel 模式注入 `1`，其它模式会清空（见上一节的两条反代路径） |
| `HANA_GW_WS_UPSTREAM_TIMEOUT_MS` | `10000` | WebSocket 连上游的“连接 + 握手”总超时；超时回 504 并关闭，不把客户端 socket 永远挂着 |
| `HANA_GW_CARD_TOKEN_TTL_MS` | `300000` | 卡片资源令牌有效期（上限 30 分钟） |
| `HANA_GW_CARD_TOKEN_MAX` | `1000` | 进程内同时有效的卡片令牌上限，超出按最旧淘汰 |
