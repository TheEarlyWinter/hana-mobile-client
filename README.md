# hana-mobile

## 这是什么 / 不是什么

**是什么**：一份自用的 Hana 手机端实现——同源网关 + 重新编写的移动前端 + 极薄的 Android WebView 壳。

**不是什么**：

- **不是官方客户端**，与上游 `hana-server` 的维护者**没有任何隶属或授权关系**；这里的判断、缺陷与取舍都不代表上游。
- **不保证兼容**。它依赖上游**未公开的内部接口**（`127.0.0.1:23917` 上的 HTTP 与 WebSocket 契约）。上游随时可以改，改了这里就可能坏；出现这种情况本仓库没有义务跟上。
- **不提供支持**。没有 issue 响应承诺、没有版本兼容声明、没有升级迁移保证。自己部署后遇到的问题请自行排查（安全相关的报告方式见 [SECURITY.md](SECURITY.md)）。

如果你要的是稳定、可预期的官方支持，用官方桌面端，不要在手机上架这一套。

## 长什么样

一个同源网关、一套自己写的移动前端、一个极薄的 Android WebView 壳；后端仍然是官方 `hana-server`，它那行代码一行没改。手机上打开就是一个正常的聊天界面——会话列表、流式回复、卡片、文件、闲聊、归档都在；但它不是官方 App 的移植，是重新实现的。

```
手机 / 浏览器
     │  http(s)://<网关地址>:24000
     ▼
┌─────────────────────────┐
│  gateway/server.mjs     │  静态托管 web/ + API 反代 + WS 中继 + 卡片托管
└───────────┬─────────────┘
            │  127.0.0.1:23917（本机回环）
            ▼
┌─────────────────────────┐
│  hana-server（官方）     │  源码未改
└─────────────────────────┘

Android 壳（WebView）──只做几件事──> 加载网关地址 / 切换接入方式 / 系统返回键 / 下载与文件选择
```

## 为什么中间要加一层网关

官方服务的登录 Cookie 是 `HttpOnly; SameSite=Strict`，CORS 白名单只放 `localhost` 与 `127.0.0.1`。这意味着**任何跨源客户端都拿不到登录态**：手机直接连 `http://<电脑IP>:23917` 会被判成跨站，Cookie 一律不发，登录必然失败。

网关做的事，就是让前端和它**同源**——页面从 `:24000` 出来，API 也从 `:24000` 走，Cookie 自然带上。网关再用本机回环把请求转给宿主，宿主视角里一切都来自本机。

顺带的好处：静态资源、卡片、下载都在同一处托管，不用为每个东西再开一个口子。

## 目录

| 目录 | 是什么 |
|---|---|
| `gateway/` | 网关：静态托管、API 反代、WebSocket 中继、卡片托管、边界策略 |
| `web/` | 前端源码：78 个零依赖模块，`app.js` 只做装配；构建产物在 `web/dist/`（不进仓库） |
| `web/features/` | 按功能拆出来的部件（闲聊、搜索、归档），注册表负责顺序与销毁 |
| `android/` | 壳：`MainActivity.java` + 手写构建脚本（aapt2 + javac + d8，无 Gradle） |
| `scripts/` | 全量测试 runner、前端打包、发版脚本、真机调试工具 |
| `tests/` | 165 个独立 Node 测试脚本；大多数不需要浏览器，少数（真布局、真滚动）要本机装 Chrome 或 Edge |
| `docs/` | 前端构建与产物缓存的说明（[`docs/dev-build.md`](docs/dev-build.md)） |

## 前端构建

前端原本是几十个 ES 模块 + 20 份样式表裸跑，网关对文本资源发 `no-store`，冷启动要重走 100 来个往返。现在合成两份产物，实测冷启动请求 **103 → 16**（静态资源 99 → 3）。

```powershell
npm install          # 只装 esbuild（唯一的开发依赖）
npm run build        # 构建 web/dist 下的哈希产物与 manifest.json
npm run build:watch  # 开发时自动重建
```

网关启动时按清单里的 `builtAt` 与源文件 mtime 判断是否过期，**过期、清单缺失、或清单点名的文件不在就自动重建**，忘了打包也不会让手机跑旧代码。这里不能用产物 mtime 当基准：产物名带哈希，文件名每次都变，那样会永远判过期、每次启动都重建。细节、约束与排查见 [docs/dev-build.md](docs/dev-build.md)。

产物名带内容哈希（`app.<8hex>.js` / `app.<8hex>.css` + `manifest.json`），首页在响应时按清单注入真名。哈希产物发 `immutable` 长缓存，页面本身 `no-store`，所以**改代码下次打开就是新的，没改的 bundle 一条请求都不发**（真机实测：第二次冷启动 `/dist/` 请求 0 条）。

## 你需要的环境

| 需要 | 为什么 |
|---|---|
| **Node 18+** | 网关、构建脚本、测试 runner 都直接跑源码，没有编译步骤 |
| **一台装了官方桌面端 Hana 并已登录的电脑** | 网关自己不跑模型，只把宿主在 `127.0.0.1:23917` 上的接口反代出来；宿主没装、没登录、端口不同，网关都起不来 |
| **Windows** | 启动与守护脚本是 Windows 专用的：`start.ps1` / `status.ps1` / `stop.ps1` 用 `Get-NetTCPConnection`、`Get-CimInstance`，守护走 `supervise.cmd`。装 PowerShell 7 也补不出等价实现 |
| **可选的 Android SDK** | 只有要自己打 APK 才需要（`android/build.ps1` 直接用 `aapt2` / `d8` / `apksigner`，不依赖 Gradle），另需 JDK 17 |

不需要的：数据库、Docker、云服务账号、任何运行时 npm 依赖。唯一开发依赖是 esbuild（构建前端用）。

## 跑起来

```powershell
# 0. 首次：按 package-lock.json 装依赖（网关启动时会自己构建 web/dist，也可以先跑 npm run build）
npm ci

# 1. 起网关（会自动把宿主 API 反代到 24000）
gateway/start.ps1 -Mode lan

# 2. 手机和电脑连同一个 Wi-Fi，浏览器打开
#    http://<电脑IP>:24000
```

电脑上桌面端 Hana 需要是开着的——网关自己不跑模型，它只是转发。

## 别的电脑怎么用

分两种情况，别混在一起：**只是拿别人的电脑当客户端**，和**把整套服务搬到另一台电脑上**。

### 当客户端：什么都不用装

浏览器直接开网关地址，前端全在网关那边：

```
http://<网关所在电脑的IP>:24000
```

手机同理——壳里在「接入方式」填这个地址即可，不需要那台电脑装任何东西。

### 当服务端：换一台电脑跑

前提是这台电脑上**已经装了官方桌面端 Hana 并登录**。网关不跑模型，它只是把宿主的 `127.0.0.1:23917` 反代出来；宿主没装、没登录、或换了端口，网关都起不来。

```powershell
# 1. 拿代码（clone 或直接拷目录都行），装唯一一个依赖
npm install

# 2. 起网关（会自动把宿主 API 反代到 24000）
gateway/start.ps1 -Mode lan

# 3. 另开一个窗口确认它在听
(Invoke-WebRequest http://127.0.0.1:24000/ -UseBasicParsing).StatusCode   # 期望 200
```

手机和这台电脑连同一个 Wi-Fi，浏览器打开 `http://<这台电脑的IP>:24000`。

### 换电脑时最容易踩的五个坑

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 网关起不来，报端口占用 | 24000 被上次的进程或别的程序占着 | `Get-NetTCPConnection -State Listen -LocalPort 24000` 找到 PID，确认后再处理 |
| 首页能开，登录失败 / 接口 403 | 宿主不在这台机器的回环上，或宿主没登录 | 网关必须和宿主同一台机器，且走 `127.0.0.1:23917` |
| 首页白屏，控制台找不到 `/dist/app.*.js` | `web/dist` 不进仓库，那台机器没构建过 | `npm install && npm run build`；网关启动也会自动补，但需要 esbuild 在 |
| 本机能开，手机连不上 | Windows 防火墙拦了入站 | 首次弹窗时勾「专用网络」，或手动放行 24000 |
| macOS / Linux 上 `start.ps1` 跑不了 | 网关的启动与守护脚本是 Windows 专用的（`Get-NetTCPConnection`、`Get-CimInstance`、`supervise.cmd`） | 目前没有等价脚本；真要跨平台得自己写启动与守护，光装 PowerShell 7 不够 |

两台电脑各跑各的网关没问题，但**别让 A 的网关指向 B 的宿主**：这条路依赖本机回环和宿主侧的 Cookie 策略，跨机会被判成跨站。

公网访问（隧道）是额外一套，默认不开；上面的链路只解决“能连上”，公网那一套是另一回事（见下面的「公网隧道」一节）。

## 三种连法：局域网 / 公网隧道 / 本机 USB（附 Tailscale）

先分清两套名词，不然后面一定乱：

- **网关启动模式**（`start.ps1 -Mode ...`）决定**监听哪个地址、cookie 要不要带 `Secure`、允许哪些 Origin**。它只影响服务端。
- **壳里的接入方式**（本机 / USB、Tailscale、公网隧道、自定义）只决定 **App 打开哪个 URL**，以及该 URL 存在本地哪一格。

两者可以任意组合，但只有四种“对得上”的组合：

| 连法 | 网关怎么起 | 监听地址 | 手机壳里选 | 填什么 | 加密 | 谁能连到 |
|---|---|---|---|---|---|---|
| 局域网 | `-Mode lan` | `0.0.0.0:24000` | 自定义 | `http://<电脑IP>:24000` | ❌ 明文 | 同一 Wi-Fi 下的任何人 |
| 公网隧道 | `-Mode tunnel` | `127.0.0.1:24000` | 公网隧道 | `https://<你的域名>/` | ✅ CF 边缘终止 TLS | 整个互联网（靠登录拦） |
| 本机 / USB | `-Mode usb` | `127.0.0.1:24000` | 本机 / USB | `http://127.0.0.1:24000/` | 不过网络 | 只有这台电脑 |
| Tailscale | `-Mode tailscale` | `<100.x 地址>:24000` | Tailscale | `http://100.x.y.z:24000` | ✅ Tailscale 加密 | 你自己的 tailnet |

不知道自己现在跑的是哪种、手机该填什么，直接问：

```powershell
pwsh -File gateway\status.ps1
# （示例输出）
#  模式       : tunnel
#  监听地址   : 127.0.0.1:24000（本项目 node PID 27516）
#  上游服务器 : 0.0.0.0:23917 在监听（PID 25208）
#  手机填写   : https://your-domain.example
```

### 局域网

最少的步骤，也是唯一没有加密的那条。

```powershell
gateway/start.ps1 -Mode lan
```

它做两件事：监听 `0.0.0.0:24000`（不再只是本机），并显式设 `HANA_GW_ALLOW_INSECURE_LAN=1`——网关默认拒绝“非回环 + 明文”的组合，不打开这个开关就起不来。

手机侧：壳里选「自定义」，填 `http://<电脑IP>:24000`。IP 用 `gateway\status.ps1` 看，或 `ipconfig` 找 `192.168.x.x`。

验证：

```powershell
(Invoke-WebRequest http://127.0.0.1:24000/ -UseBasicParsing).StatusCode   # 本机，期望 200
(Invoke-WebRequest http://<电脑IP>:24000/ -UseBasicParsing).StatusCode    # 走局域网，期望 200
```

**风险要说清楚**：这条路上没有 TLS，同一 Wi-Fi 下的人可以嗅到登录 cookie，也可以直接访问你的会话。只在自家或自己办公室的网络上开，别在咖啡馆用。

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 本机能开，手机打不开 | 防火墙拦了入站 | 首次弹窗勾「专用网络」，或手动放行 24000 |
| 起不来，报需要 ALLOW_INSECURE_LAN | 只改了 `HANA_GW_HOST` 没走脚本 | 用 `start.ps1 -Mode lan`，别手改环境变量 |
| 页面能开，接口返回 403 | 宿主没登录，或请求根本没到宿主 | 先在电脑上看看桌面端 Hana 是否已登录 |
| 手机打开是错误页 | 地址写错（不是 24000，或用了 https） | 局域网模式是 `http://`，端口跟 `-Port` 一致 |

### 公网隧道（VPS + Cloudflare + frp）

不在同一网络时用这条。五段各管一段，弄混了就会查错地方：

```
手机 ──https:443──> Cloudflare 边缘        ← 证书、TLS、HTTP/2 都在这里终结
                          │ 命名隧道
              VPS 136.x.x.x 上的 cloudflared  ← 把域名映射到本机某个回环端口
                          │ http://127.0.0.1:24080
                VPS 上的 frps                    ← 只绑回环，公网摸不到
                          │ frp over TCP 7000 + tcpMux + token
                家里电脑的 frpc                  ← 断线自动重连
                          │ http://127.0.0.1:24000
                    网关（-Mode tunnel）
```

| 组件 | 在哪 | 配置文件 | 职责 |
|---|---|---|---|
| Cloudflare | 云 | 面板里的 DNS + 隧道 | 终结 TLS，把 `https://<域名>` 送到 VPS |
| cloudflared | VPS | 系统服务 | 命名隧道的服务端，ingress 指向 `127.0.0.1:24080` |
| frps | VPS | `frps.toml` | 接 frpc 的连接，把 24080 转到隧道上 |
| frpc | 本机 | `%USERPROFILE%\hana-tunnel\frpc.toml` | 把本机 24000 送出去，token 鉴权 |
| 网关 | 本机 | `gateway/remote.json` | 只监听回环，`EXTERNAL_HTTPS=1` 让 cookie 带 `Secure` |

`remote.json` 不放仓库：公开仓库里只有模板 `gateway/remote.json.example`，用之前自己复制改名成 `gateway/remote.json`，把里面的示例域名换成你自己的（换域名、`allowedOrigins` 怎么填、写错了会怎样，见 [`gateway/remote.md`](gateway/remote.md)）。不复制也能起 `-Mode tunnel`，只是允许的 Origin 为空，手机端的写请求会被挡。

```powershell
gateway/start.ps1 -Mode tunnel
```

这个模式下：监听 `127.0.0.1`（公网唯一入口是 CF 的 443）、`HANA_GW_EXTERNAL_HTTPS=1`（Set-Cookie 补 `Secure`）、允许的 Origin 从 `gateway/remote.json` 读。手机壳里选「公网隧道」，填 `https://<你的域名>/`。

**几个容易误解的地方**

- **TLS 是 Cloudflare 给的，不是你自己签的。** 好处是不用管证书、不用开 80；代价是流量经过它。
- **为什么不直接连 VPS 的 443**：如果你的 VPS 上 443 已被别的服务占着，腾不出来就只能让 CF 做前端。腾出来之后可以换成 Caddy 终结证书 + `ssh -R`，链路能少一跳。
- **frp 用 TCP 不用 QUIC**：这个版本开 QUIC 会报 `work connection pool is full, discarding`，并发一上来就 502。
- **token 不在仓库里**：两端各存一份，`remote.json` 只放域名和允许的 Origin。
- **网关不对外**：`HANA_GW_HOST=127.0.0.1`。就算 CF 挂了，公网也连不到你的电脑。

验证（重点看 `cache-control` 和状态码，而不是只看能不能打开）：

```powershell
curl.exe -sS -D- -o NUL https://<你的域名>/            # 期望 200 + no-store
curl.exe -sS -D- -o NUL https://<你的域名>/dist/<app 哈希>.js   # 期望 immutable
```

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 502 / `Unable to reach the origin` | frpc 断了，或 frps 没起 | 看 frpc 进程与 VPS 上 `systemctl status frps` |
| 能开页，登录 403 | 宿主没登录，或 origin 不在白名单 | 先确认本机 200；再查 `remote.json` 的 `allowedOrigins` |
| 并发时偶发 502 | QUIC 连接池满 | 换回 TCP（`transport.protocol = "tcp"`） |
| 公网打得开、本机反而打不开 | 网关没起，只是隧道通着 | `pwsh -File gateway\status.ps1` 看监听与 PID |

部署顺序：frps → frpc → 网关 → 手机。顺序反了也能起来，但排障时看不出是哪一段先断的。这条链路的具体配置（VPS 上的 `frps.toml`、本机的 `frpc.toml`、Cloudflare 的 ingress）根据你自己的环境写，仓库里不存。

### 本机 / USB

改代码、验收、排查全走这条：不经过任何网络，不依赖 Wi-Fi，也不涉及 TLS。

```powershell
adb reverse tcp:24000 tcp:24000      # 手机的 127.0.0.1:24000 → 电脑的 24000
gateway/start.ps1 -Mode usb
```

手机壳里选「本机 / USB」，地址固定 `http://127.0.0.1:24000/`。手机上的“本机”经 `adb reverse` 落到电脑的回环，所以这条路上**两边都以为自己在说 localhost**。

```powershell
adb reverse --list        # 看映射还在不在
```

`adb reverse` 在 App 重启、adb server 重启、拔插线之后会掉，掉了就重跑一次。这是这条通道唯一的毛病。

### Tailscale

不想开端口、也不想让流量经过 CDN 时用这条。

```powershell
tailscale up                       # 首次
gateway/start.ps1 -Mode tailscale  # 监听 tailnet 的 100.x 地址
```

它要求 `tailscale` 命令存在且已登录，否则直接报错退出——**不会悄悄退回其他模式**。手机侧装同一个 tailnet 的 Tailscale，壳里选「Tailscale」，填 `http://100.x.y.z:24000`。

好处：端到端加密、不暴露公网端口、不依赖任何第三方 CDN。代价：两端都要装 Tailscale；打洞失败时走中继，速度看中继质量。

### 换连法时要改哪些地方

| 改什么 | 不用动什么 |
|---|---|
| 网关重启成新 `-Mode` | 代码、APK、`web/dist` 都不用动 |
| 壳里换「接入方式」+ 地址 | 不用重装 APK |
| 隧道相关的：`remote.json` 的 Origin、CF 的 ingress、frpc 的目标 | 前端一行不改 |

还有两个容易忽略的副作用：

- **主题按 origin 存在本机**（`localStorage`）。从 `127.0.0.1` 换到域名，或从局域网 IP 换到域名，深色会回到默认，要重选一次。
- **同一端口只能有一个网关**。`tunnel` 和 `lan` 不要同时起两个；切换时先把旧的停掉（`gateway\status.ps1` 能看到当前那个的 PID）。

## 测试

```powershell
node scripts/run-all-tests.mjs              # 全量，165 个文件，约 330 秒
node scripts/run-all-tests.mjs --shard 1/4  # 只跑四分之一，CI 用
node scripts/run-all-tests.mjs --filter settings
```

每个文件单独起 Node 进程，**默认硬超时 60 秒**；V8 堆上限默认 512 MB。Windows 默认用 `tasklist` 每秒采样直接测试 PID 的 RSS（1024 MB），超限算失败；这不是整棵进程树的内存硬上限。RSS 监控仅在 Windows 生效，`--max-rss 0` 可显式关闭。

超时或 RSS 超限时，只尝试终止本 runner 启动的进程树：Windows 按捕获的 PID 调用 `taskkill /T`，命令最多等待 1 秒；POSIX 使用 runner 自有进程组。不会按进程名或端口杀进程。若再等 1.5 秒后 stdout/stderr 管道仍未关闭，runner 会销毁自己持有的管道并以 `CLEANUP` 不完整结算为失败；后代是否退出未确认，不声称已清理整棵树。测试进程只收到白名单环境变量；真实 `HANA_HOME`、凭据和 `NODE_OPTIONS` 不会继承。`HANA_SKIP_BROWSER_TESTS=1` 会保留；runner 会标出整文件 SKIP 与部分场景 SKIP，跳过的浏览器场景不算已覆盖。

这条硬超时不是洁癖：之前有测试断言全过、日志打出 `ALL PASS`，但进程因为留着定时器永远不退，外面等的人分不清"还在跑"和"已经卡死"。

CI 在 `.github/workflows/ci.yml`：先做一遍语法检查，再把 165 个文件切成四片并行跑。

## 打安装包

```powershell
android/build.ps1 -VersionName 0.9.10 -VersionCode 13
```

产物在 `android/dist/`。构建脚本只用 Android SDK 自带的 `aapt2` / `d8` / `apksigner`，不依赖 Gradle。

发版（打包 + 校验 + 生成下载页）：

```powershell
scripts/release.ps1 -VersionName 0.9.10 -VersionCode 13
```

发布会自动使用 `build.ps1 -Release`。缺现有签名 key 时，在构建前停止，不生成新 key。普通开发构建仍可生成调试 key，不要用它替换发布身份。

版本基线取 Manifest 与 `web/download/latest.json` 的较大值（这个目录不在仓库里，首次发版时不存在，基线按 0 算；脚本会自己建）。新包应递增版本码；同码重发必须同版本、同 SHA256。稳定 SDK 工具、包名、实际版本、非 debuggable 和 APK 签名都要校验通过，才写下载目录。发布拒绝 `-Debuggable`；`-AllowDowngrade` 只放宽版本降低，不跳过其他校验。脚本目前不比对历次签名证书指纹，现有 key 必须妥善保管。

## 几条不该被推翻的决定

- **不改宿主源码**。它升级时我们不该被拖住，所以适配全部放在网关和前端。
- **只加一个打包步骤，不引框架生态**。前端源码仍是原生 ES 模块、零运行时依赖，唯一开发依赖是 esbuild（把 78 个模块合成一份）；Android 侧是手写脚本，不用 Gradle。目标是少一层工具链、少一类“本地能跑、换台机器不行”。
- **壳不许 `addJavascriptInterface`**。那个接口对所有 frame 生效，卡片 iframe 也能摸到原生对象。网页与原生只走 `WebMessageChannel`，端口只能由壳创建。
- **前端更新不靠版本号**。网关对页面发 `no-store`，改完刷新就是新的，不用重装 APK。

## 文档

- [`docs/dev-build.md`](docs/dev-build.md)：前端构建、哈希产物、缓存分级与排查。
- [`gateway/remote.md`](gateway/remote.md)：隧道模式的 `remote.json` 字段与环境变量。
- [`CONTRIBUTING.md`](CONTRIBUTING.md)：怎么跑测试、代码风格、提交前要做什么。
- [`SECURITY.md`](SECURITY.md)：安全模型、漏洞报告渠道、公开部署前该想清楚的事。

## 边界

这个项目只服务自己用：网关默认只监听回环（`-Mode usb`），要局域网得显式 `-Mode lan`，要公网得自己套隧道；没有多用户隔离，没有审计日志，也没有“被人扫到也能撑住”的设计前提。想公开访问请自负安全责任，具体范围见 [SECURITY.md](SECURITY.md)。
