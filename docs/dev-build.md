# 前端构建（web → web/dist）

## 为什么要打包

前端原本是「几十个 ES 模块 + 20 份样式表」裸跑，网关对文本资源发 `no-store`
（改完必须立刻生效，不能靠缓存），于是**每次冷启动都要重走 100 来个往返**。
在 200ms 级别的移动链路上，这笔开销比传输的字节本身贵得多。

现在 `web/` 由 esbuild 合成两份产物，入口只剩一个 `<script>` + 一个 `<link>`。
实测冷启动请求从 103 降到 16（其中静态资源从 99 降到 3，其余都是接口调用）。

## 怎么构建

```powershell
npm install            # 只装 esbuild（devDependency）
npm run build          # 构建一次
npm run build:watch    # 改文件自动重建（开发时用）
```

产物：

| 文件 | 内容 |
|---|---|
| `web/dist/app.<8位hex>.js` | 整个模块图（入口 `web/app.js`），ESM，已压缩，带 sourcemap |
| `web/dist/app.<8位hex>.css` | 20 份样式表按层叠顺序合并，已压缩 |
| `web/dist/app.<8位hex>.js.map` | 只在开发者工具里拉，手机不会请求 |
| `web/dist/manifest.json` | `{ js, css, builtAt, hash }`：这一批产物叫什么 |

`web/dist/` 不进仓库（见 `.gitignore`）。每次构建都会清掉不属于这一批的文件
（旧的固定名 `app.js` / `app.css`、上一版哈希文件），所以 dist 里永远只有一套。

**哈希是内容哈希**：构建先写固定名，再按产物字节算 sha256 取前 8 位 hex 重命名。
同一份源码连构两次，文件名和总哈希都不变——变了就说明「每次构建都会让所有手机的缓存失效」。
JS 的哈希只算代码本体，不含 `sourceMappingURL` 那行（那行要跟着哈希名改写，算进去会循环）。

## 页面引用是稳定的，哈希名由网关注入

`web/index.html` 里始终写 `/dist/app.js` 与 `/dist/app.css`。网关返回 `/` 或
`/index.html` 时读 `manifest.json`，把这两个引用替换成哈希名再发出去。

为什么不在构建期改写 HTML：那样 HTML 自己就成了构建产物，模板与产物混在一起，
测试与浏览器夹具也没法再从源文件里读出「入口是哪个」。现在的分工是：
源文件写稳定名、构建写清单、网关做替换，三者各自可测。

清单读取按 mtime + 大小缓存，构建重写清单后下一次请求就会用新的，不用重启网关。
清单缺失或写坏时，首页原样发出（仍然是 `/dist/app.js`），不是 500。

## 缓存分级

| 路径 | `cache-control` | 理由 |
|---|---|---|
| `/dist/` 下清单点名的 js / css | `public, max-age=31536000, immutable` | 名字跟着内容走，同一个 URL 永不换内容 |
| `/`、`/index.html` | `no-store, no-cache, must-revalidate` | 页面是「指向哪一版产物」的唯一开关 |
| `/dist/manifest.json`、dist 下其它文件 | `no-store` | 清单变了必须立刻可见；sourcemap 不在缓存收益里 |
| 已换版的哈希名、`/dist/app.js`、`/dist/app.css` | `no-store` | 见下面的兜底映射 |
| 其余前端源文件 | `no-store, no-cache, must-revalidate`（非文本 `no-cache`） | 名字不带哈希，改完必须立刻生效 |

「发布了新代码，手机还是旧的」这条链是这样断的：构建换哈希名 → 清单换名字 →
首页每次回源、拿到新名字。只要首页不进缓存，旧哈希文件被删也不会被引用到。

## 旧产物名的兜底映射

dist 里只留当前一套（不保留上一代，不占磁盘）。旧 HTML 可能还在某个标签页/WebView 里
按旧名字来取，所以网关对「问的是构建产物本身」的路径做了一层兜底：

- 精确命中清单里的名字 → 真文件，`immutable`；
- 已换版的 `app.<hex>.js` / `app.<hex>.css`，以及打包第一版的固定名 `app.js` / `app.css`
  → 用当前清单对应的产物字节回答，`no-store`；
- 其它不存在的 `/dist/*`（包括 `.map`、清单、任意文件名）→ 仍然 404。

范围写死在「固定名 + 哈希名形状」两种上：兜底口子开大了，等于任何不存在的路径都能拿到整个包。
不保留上一代产物的代价只是「旧页面拿到的是新代码」，而不是白屏。

## 网关会自动构建

`gateway/server.mjs` 启动时调 `gateway/web-build.mjs`：读 `web/dist/manifest.json`，
**清单缺失、清单点名的文件不在、或有源文件比 `manifest.builtAt` 新**，就重建一次，
然后才 `listen`。所以忘了跑 `npm run build` 也不会让手机跑旧代码；重建失败只记日志、
不拦启动（页面 404 比整站起不来更好排查）。

判断基准是 `builtAt` 而不是产物 mtime：产物名带哈希之后，产物文件的 mtime 每次构建
都会变，拿它当基准会永远判过期、每次启动都重建一次。`builtAt` 取的是构建**开始**时间，
所以构建期间被改动的源文件会在下次启动时重新触发构建（宁可多建一次，不发旧代码）。

判断和重建是两个进程：网关只用 `node:fs` 读清单比时间，真正的打包用子进程跑
`scripts/build-web.mjs`，运行期不依赖 esbuild。

## 改动约束

1. **新增样式表**：必须登记到 `scripts/build-web.mjs` 的 `STYLES`（数组顺序 = 层叠顺序）。
   `tests/web_bundle.test.mjs` 会扫 `web/` 下所有 `.css`，漏登记直接红。
2. **新增模块**：只要被 `app.js` 的 import 图引用就会进包。写了却没人 import 的模块会被
   同一个测试抓出来，要么接线，要么登记进 `ALLOWED_UNBUNDLED` 并写清原因
   （目前只有 `outbox.js`：自动重试与「失败留在输入框」语义互斥，B2 待接线）。
3. **深色主题**：`themes/dark.css` 必须排在 `STYLES` 最后，它靠源顺序覆盖前面的组件规则。
4. **别再往 index.html 加 `<script>` / `<link>`**：`tests/module_preload.test.mjs` 锁死了
   「只有一份入口 + 一份样式表」。
5. **index.html 里那两个引用必须保持 `/dist/app.js`、`/dist/app.css`**：它们是网关注入的
   锚点，改成哈希名就等于把版本钉死在源文件里，之后每次构建都得改 HTML。

## 排查

| 现象 | 先看 |
|---|---|
| 手机上是旧界面 | `/dist/manifest.json` 里的名字变了没；首页响应里 `src="/dist/app.xxxx.js"` 是新名字没；网关日志里有没有「重建前端产物」；强杀 App 重开 |
| 页面白屏、控制台无报错 | 首页注入的哈希文件名是否 404；`npm run build` 是否成功；`dist_cache` / `web_bundle` 测试是否红 |
| 手机拿着旧 HTML 也能跑 | 旧哈希名应该 200 且 `no-store`（兜底映射）；404 就说明兜底没命中 |
| 改了代码但哈希没变 | 构建是否真的跑了；改的是不是被 import 图引用的文件 |
| 样式错乱 | `STYLES` 顺序是否被改动，尤其是 `dark.css` 是否还在最后 |
| 想单步调试 | 源码仍在 `web/`，`tests/*` 直接 import 源文件，不受打包影响；浏览器里用 sourcemap |

## 已经定下来的取舍

**文档层不再发 `Clear-Site-Data: "cache"`**。它当年是为了清掉「旧响应带着 30 天 max-age」
的历史缓存，代价是每次导航都清一次该源的 HTTP 缓存——产物已经带哈希、页面本身 `no-store`
之后，版本切换不再靠清缓存，留着它只会把 immutable 白缓存一遍。所以删掉，
`tests/dist_cache.test.mjs` 与 `tests/gateway-routing.test.mjs` 都锁着「文档响应不带这个头」。

**dist 不保留上一代产物**，改用上面的兜底映射：磁盘只留一套，旧页面不白屏。
