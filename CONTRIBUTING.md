# 参与贡献

先读 [README](README.md) 的「这是什么 / 不是什么」：这份代码依赖上游未公开的内部接口，不保证兼容。改动请围绕「让它在自己的机器上更稳」来做，不要指望这里会去追上游的每一次变化。

## 环境

| 需要 | 说明 |
|---|---|
| Node 18+ | 仓库全是源码直跑，没有编译步骤。CI 用的是 22 |
| Windows | 网关的启动/守护/状态脚本是 `pwsh` + `Get-NetTCPConnection` / `Get-CimInstance` / `supervise.cmd` |
| JDK 17+（可选） | `tests/url_guard.test.mjs` 等几个用例会现场 `javac` 编一段 Java 再跑；没装 JDK 它们会红，但那是环境缺失，不是代码错 |
| 真浏览器（可选） | 少数布局/滚动用例需要本机 Chrome 或 Edge；`HANA_SKIP_BROWSER_TESTS=1` 会让它们自己跳过 |
| Android SDK（可选） | 只有要打 APK 才需要（`android/build.ps1` 用 `aapt2` / `d8` / `apksigner`） |

第一次：

```powershell
npm ci
npm run build      # 生成 web/dist；网关启动时也会自动补
```

## 跑测试

```powershell
node scripts/run-all-tests.mjs                    # 全量：165 个文件，约 330 秒
node scripts/run-all-tests.mjs --filter settings   # 只跑文件名含关键字的
node scripts/run-all-tests.mjs --shard 1/4         # 切片，CI 用
node tests/url_guard.test.mjs                      # 单个文件也是独立可跑的
```

约定：

- **每个测试文件都是独立可执行的脚本**，直接 `node tests/xxx.test.mjs` 就能跑，失败以非零退出码收场。不要写依赖执行顺序或共享全局状态的测试。
- runner 给每个文件单独起进程，默认 **60 秒硬超时**、V8 堆 512 MB、Windows 下直接 PID 的 RSS 上限 1024 MB。超时不是洁癖：断言全过但进程不退，比失败更难查。
- 要真实网关、浏览器、PowerShell 或真机的用例，用 `HANA_SKIP_BROWSER_TESTS=1` 或干脆不跑；**不要**为了让它们变绿去弱化断言。

还有一道快速离线门禁和一个元测试：

```powershell
node tests/support/run-audit-safe-tests.mjs        # 固定子集，串行跑，只收快速离线的入口
node tests/audit_manifest_sync.test.mjs            # 校验「磁盘上每个 tests/*.test.mjs 都被显式归类」
```

新增测试文件时**必须**在 `tests/support/run-audit-safe-tests.mjs` 里归类：快速离线稳定的进 `ALLOWLIST`（保持 `.sort()` 顺序），需要网关/浏览器/PowerShell/真机的进 `EXEMPTIONS` 并写清分组理由。漏了会让 `audit_manifest_sync` 变红——这是有意的，不允许有测试悄悄不被跑到。

## 代码风格

- **零运行时依赖**。唯一开发依赖是 esbuild（把前端模块合成一份产物）。加任何新依赖之前先问自己能不能用 30 行原生代码解决；确实要加，在 PR 里说明为什么无法避免。
- **前端是原生 ES 模块**，`web/app.js` 只做装配。不要引入框架、不要引入构建期宏，也不要在 `web/index.html` 里加第二个 `<script>` / `<link>`（`tests/module_preload.test.mjs` 盯着）。
- **注释写「为什么」，用中文**。写清这段代码在防什么、为什么不能换成更直观的写法；「这是什么」由代码本身回答。改动别人写的「为什么」注释时，先确认那个理由真的不成立了。
- **新增样式表**要登记到 `scripts/build-web.mjs` 的 `STYLES`，数组顺序就是层叠顺序，`themes/dark.css` 必须留在最后。
- **网关不读 `X-Forwarded-Proto`**，也**不改宿主源码**；适配只放在网关和前端。这两条是设计前提，不是可以临时绕过的实现细节。
- **Android 壳不开 `addJavascriptInterface`**，网页与原生只走壳创建的 `WebMessageChannel` 端口。
- 不整文件格式化，不顺手重排无关代码；一个 PR 解决一件事。

## 提交前

按顺序跑一遍，全绿再提：

```powershell
npm ci
npm run build
# 所有 web / gateway / scripts 模块过一遍语法检查（和 CI 的 syntax job 同口径）
$targets = @(Get-ChildItem -Path web,gateway,scripts -Recurse -Filter *.js -File) +
           @(Get-ChildItem -Path web,gateway,scripts -Recurse -Filter *.mjs -File)
foreach ($f in $targets) { node --check $f.FullName; if ($LASTEXITCODE -ne 0) { throw $f.FullName } }

node scripts/run-all-tests.mjs     # 至少跑全量；只改一处可以用 --filter 先过一遍
node tests/audit_manifest_sync.test.mjs
```

另外自查两件事：

1. **没有个人配置混进来。** `gateway/remote.json`（你自己的隧道域名）、`gateway/logs/`、`web/dist/`、`android/dist|build|build-artifacts/`、`*.jks` / `*.keystore`、`tests/artifacts/`、`*.log` 都不该出现在提交里。前几项已经在 `.gitignore` 里，别用 `git add -f` 绕过去。
2. **没有真实部署信息。** 代码、注释、测试夹具、截图里都不许出现真域名、真内网 IP、token、cookie、本机用户名/路径。夹具一律用 `example` / `your-domain.example` / `192.168.1.10` 这类占位值。细节见 [SECURITY.md](SECURITY.md)。

## PR 范围

- **一个 PR 一件事**：修一个缺陷、或加一个能力。顺带的大重构请拆出去单独讨论。
- **别改接口契约**：网关的路由、前端与宿主的 HTTP/WS 形状、Android 与网页之间的消息格式，改了要在这里说明「为什么必须改」以及「老版本会怎样」。
- **别碰别人的职责范围**：前端/交互、网关/数据处理、Android 壳的改动请分开提，方便分别 Review。
- **文档跟着代码走**：改动了构建流程、缓存策略、测试门禁的话，同步 `docs/dev-build.md` 或本文件里对应的段落。
- 提交信息写清「改了什么、为什么」；纯格式化的提交请单独一个，不要混进逻辑改动。
