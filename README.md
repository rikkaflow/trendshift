# Trendshift

GitHub 趋势榜的手机客户端，以 PWA 形态运行，可"添加到主屏幕"当 App 用。
比官方站更轻（外壳 ~19 KB vs 340 KB）、无广告、无追踪，并提供官方站没有的
跨期历史回溯与仓库排名走势。

- **线上**：https://trendshift-lite.logos7313.workers.dev/
- **部署**：单个 Cloudflare Worker（静态外壳 + 数据 API）

---

## 功能

| 栏目 | 内容 | 数据源 |
|---|---|---|
| 本周 / 今日 / 本月 / 今年 | 趋势榜，25 条/期，可回溯历史期次 | 第三方静态镜像 |
| 热议 | X 上的开源项目讨论，应用内读全文 | 官方内部接口 |
| 主题 | 64 个 AI 归类主题，点进去看该主题下的仓库 | 页面 RSC 载荷 |
| 热门 | 长期反复上榜的仓库 | 页面 RSC 载荷 |
| 开发者 | 趋势开发者榜，带头像/简介/关注者 | 页面 RSC 载荷 |
| 统计 | 各语言每月新增 Star / Fork | 官方内部接口 |

**通用能力**

- 16 种语言筛选（实际覆盖数据里的全部 50 种）
- 三种排序：榜单排名 / 涨星数 / 总星数
- 跨期搜索（搜全部历史期次，不只是当期）
- 仓库详情：描述机翻中文、Stars/Forks/Issues、排名走势图、历史期次
- 描述自动机翻中文，可随时切原文；译文本地缓存
- 标签栏可拖动排序、可隐藏（长按标签进入）
- 离线可看上次数据

---

## 架构

```
浏览器 (PWA)
   │
   ├── 静态外壳：index.html / manifest / sw.js / icon
   │      └── 全部内联进 Worker 脚本（单文件部署，无对象存储）
   │
   └── /api/* ──► Cloudflare Worker ──► 三个上游
                                        ├── quantavil.github.io/trendshift/data/
                                        ├── trendshift.io/api/*
                                        └── trendshift.io/<page>?_rsc
```

**为什么数据要过 Worker**

1. 第三方镜像的 `weekly-all.json` 有 1.9 MB，手机直接拉太重 → Worker 切片后每次只回 0.4–17 KB
2. `trendshift.io/api/social-mentions/latest` 没有 CORS 头，浏览器直连被拦
3. 上游数据在 Worker 边缘缓存 6 小时，多个用户共享一份

---

## 文件

### 本地回归测试

需要 Python 3 与 Node.js；运行完整离线回归套件：

```bash
sh tests/run.sh
```

该入口先检查 Python 语法并构建 Worker，再运行 KV / 前端 / Worker 行为测试；Worker 运行时测试会使用刚构建的 `/tmp/ts_worker.js`。

```
index.html              前端全部逻辑（单文件，无构建步骤）
worker.template.js      Worker 源码，__ASSETS__ 处会被替换成内联资源
build_worker.py         打包脚本：把静态文件塞进模板 → /tmp/ts_worker.js
upload_worker.py        上传（multipart，携带 TR_KV 绑定）
deploy.sh               打包 + 上传 + 验证一条龙
cloud_sync.py           云端增量翻译（跑在 GitHub Actions，本地不用管）
translations.json       译表兜底快照（KV 不可用时由 Worker 内联返回）
tests/                  回归测试与 `sh tests/run.sh` 一键入口（全部不联网）
.github/workflows/daily-translate.yml   每日定时任务
make_icons.py           生成 PNG 图标（Pillow）
manifest.webmanifest    PWA 清单
sw.js                   Service Worker（外壳网络优先，API 失败回缓存）
icon.svg / icon-*.png   图标
archive/patches/        历史补丁脚本（已应用，仅作记录）
```

---

## 翻译：云端增量，本地零参与

这是本项目的核心设计——**翻译是离线批处理，不是实时功能**。

```
上游镜像 (quantavil.github.io)
      │  每天 04:17 UTC，GitHub Actions 拉 3 个 JSON（一次拿全部期次）
      ▼
cloud_sync.py ── 抽出所有英文简介 ── 对比 KV 里已有的 ── 只翻新增
      │            （Gemini lite 多 key 并发，503/429 退避重试）
      ▼
Cloudflare KV  key = tr.json
      │
      ├─→ Worker /tr.json   → 前端启动时一次拉表，直接查，不发请求
      └─→ Worker /api/tr    → 表里没有的（新上榜/超长）才实时翻译兜底
```

**为什么这样设计：**

| 做法 | 问题 |
|---|---|
| 每次打开页面实时翻译 | 每屏几十条请求，慢、耗额度、还会因限流降级成英文 |
| 本地每天跑脚本再上传 | 手机得开机、脚本得维护，机器不在就跑不了 |
| **云端增量（当前）** | 本地完全不管；只翻新增；追加数据不重新部署代码 |

**关键：代码与数据解耦。** 译表存 KV，不在 Worker 脚本里。加几十条译文只写 KV（几百毫秒），不用重新上传 589 KB 脚本，也不会因为构建失败导致线上停更。

**日常你什么都不用做。** 想手动补一次：

```bash
gh workflow run daily-translate -R rikkaflow/trendshift
# 或直接调脚本（本地临时跑，等价于云端行为）
GEMINI_KEYS=... python3 cloud_sync.py
```

**首次初始化**（换账号 / 换 KV 时才需要）：把 `translations.json` 写进 KV，key 用 `tr.json`。

---

## 修改与部署

> **只有改代码才需要部署。** 日常译文更新由 GitHub Actions 自动写 KV，不涉及部署。

### 改前端

直接编辑 `index.html`，然后：

```bash
cd /var/minis/shared/trendshift-lite/src
./deploy.sh              # 打包 + 上传 + 验证
./deploy.sh --dry-run    # 只打包，产物在 /tmp/ts_worker.js
```

`deploy.sh` 内部走 `upload_worker.py`（multipart）。**不要用单文件 PUT** —— 那样会丢掉 `TR_KV` 绑定，译表链路静默失效。

### 环境变量

| 变量 | 用途 |
|---|---|
| `CF_API_TOKEN` | Cloudflare API token（Workers 编辑权限） |
| `CF_ACCOUNT_ID` | Cloudflare 账号 ID |
| `TR_KV_ID` | KV 命名空间 ID（默认已写死在 `upload_worker.py`） |

GitHub Actions 需要同名 secrets：`CF_ACCOUNT_ID` / `CF_API_TOKEN` / `TR_KV_ID` / `GEMINI_KEYS`。

---

## 已知边界

- **洞察（Insights / Fragmentation Index）未实现**：官方这个页面的数据既不在 API 里，也不在服务端渲染的 HTML/RSC 里，是前端现算的。要复现得自己重跑他们的算法。
- **主题 / 热门 / 开发者依赖页面结构**：这三块解析的是官方页面的 Next.js RSC 载荷，**官方改版可能失效**，届时需要重新适配 `rscText()` + `findOne()` 的判据。
- **数据延迟最多一天**：第三方镜像每日 20:17 UTC 同步一次。
- **翻译分两层**：①**预翻译表**（主力）——云端每天把全部英文简介离线翻好存进 Cloudflare KV，前端启动时一次拉 `/tr.json` 直接查表，命中就不发任何请求；②**实时兜底**——表里没有的（新上榜、超长推文）才走 `/api/tr`，Worker 用 Gemini lite 多 key 翻译。Gemini 免费档无 SLA，503/429 时会保留英文原文。
- **官方 API 用不了**：`api.trendshift.io` 需要 `ts_live_` 开头的付费 key。

---

## 踩过的坑（改之前值得看）

1. **Worker 必须用 `addEventListener('fetch', ...)`**，不能 `export default`——上传报 `Uncaught SyntaxError: Unexpected token 'export'`（错误码 10021）。
2. **首次部署后要开子域**：`POST /accounts/{acc}/workers/scripts/{name}/subdomain` body `{"enabled":true}`，否则 workers.dev 返回 `error code: 1042`。
3. **RSC 数据全嵌在数组里**：遍历时必须往下钻数组，但判定只能在 dict 上做。第一版跳过了数组元素，一个数据都找不到。
4. **Worker 出口请求 Google 翻译返回空字符串**：`{"zh":[""]}`，浏览器直连正常——所以翻译改由 Worker 调 Gemini API（带 key），不依赖 IP。
5. **批量翻译不能用 `\n` 拼多段**：推文正文本身含换行，拆回来对不齐，整批失败。改用 `<|SPLIT|>` 标记；仍对不齐就把批次对半拆开重试（`cloud_sync.py`）。
6. **service-worker 格式的绑定必须手动聚合**：`addEventListener('fetch')` 里 KV / secret 都是独立全局常量，不塞进 `env` 对象就永远读不到（`env.TR_KV` 为 undefined）。同一个坑在 Gemini key 上踩过一次，KV 上又踩一次。
7. **单文件 PUT 无法携带 KV 绑定**：必须走 `multipart/form-data`（metadata 段 + script 段），见 `upload_worker.py`。用普通 PUT 上传会把绑定弄丢，前端静默退化成实时翻译。
6. **`fixed` 全屏层在 Android WebView 上可能整层不绘制**：改成文档流互斥切换（`body.detail` 时隐藏 header/main/footer）才稳定。
7. **所有跳转必须压历史栈**：否则 Android 手势返回会直接退出应用。统一走 `go(state)`。
8. **不要直接链 `x.com`**：会触发系统「在应用中查看此帖子」弹窗，网页端无法禁用。用复制链接代替。

---

## 历史

| 版本 | 内容 |
|---|---|
| v1 | 基础趋势榜：今日/本周/本月/今年 + 语言筛选 + 历史期次 |
| v2 | 改名 Trendshift；应用内仓库详情页；全 50 种语言；修手势返回 |
| v3 | 新增 6 栏目（主题/热门/开发者/统计等）；标签可排序；翻译全覆盖 |
| v4 | 热议改应用内读全文；默认周期改本周 |
| v5 | 统一路由（返回行为一致）；去 X 跳转弹窗；标题即 GitHub 链接 |
| v6 | 榜单无限滚动（滚到底加载更早期次）；一键部署/恢复脚本；备份体系 |
| v6.1 | 顶栏期次选择器跟随滚动自动切换 |
| v6.5 | **预翻译表 + 云端增量**：全站简介离线翻好存 KV，前端直接查表；GitHub Actions 每天自动抓增量、翻译、写 KV，本地无需参与 |
| v6.7 | **审计核实修复**：KV 读失败不再清空译表（`http()` 曾把 curl returncode 当 HTTP 状态码）；`/api/tr` 返回长度与请求对齐；译表竞态（首屏不再白翻已有条目）；历史栈返回次数；`sw.js` 不再 4 秒掐断 tr.json；快照键区分搜索/主题/统计；5 套回归测试 |
| v6.8 | **翻译接口边界 + 云端失败可见**：`/api/tr` 限制请求体 256 KiB、条目 ≤ 40、条目必须为字符串、非 GET/POST → 405，超限在分配响应与调用翻译前拒绝；`cloud_sync` 写入需明确 `success:true`、译文为空/回吐原文/长度错位计入失败（不再被 zip 静默丢尾项），有失败即非零退出；新增 `tests/run.sh` 一键回归 |

---

## 过滤器（减法）

这一项不是新栏目，是**减法**：把官方站塞进阅读路径里的噪声挡掉。

官方站自己带的东西我们已经没有（构建产物里 0 个第三方广告/追踪域名，
`tests/test_noise.js` 有断言）。真正需要剪的是**内容噪声**——
实测 2026-11-26 热议 25 条里有 13 条是推广腔/自荐/同号刷屏/同文贴多个仓库（52%）。

### 规则

| 规则 | 默认 | 判据 |
|---|---|---|
| 推广腔 | 开 | `Introducing` / `What's new in` / `free trial` / `waitlist` / `hackathon` / 加微信 等自我介绍体 |
| 自荐且无内容 | 开 | owner 与账号同名（含前缀相似：`Maveri-Q` ↔ `@Maveriq_`）**且正文 <120 字** |
| 刷屏 | 开 | 同一账号在这一批里 ≥3 条，**只留第一条** |
| 同文 | 开 | 同一段文案（去链接去标点后）被贴到多个仓库 |
| 无实质正文 | 开 | 去掉链接后 <25 字 |
| 最少星数 | 不限 | 榜单条目总星数阈值（100 / 300 / 500 / 1k / 3k） |
| 最少仓龄 | 不限 | 7 / 30 / 90 / 180 天 |
| 已看过 | 关 | 隐藏上一期已经在榜的仓库 |

### 三条设计约束

1. **被挡的不删除**。压暗后原地保留，顶部显示「已挡掉 N 条」，点「查看」逐条展开，每条带原因标签。
   用户必须能看见它挡了什么——否则误杀无从判断，就是又一个黑盒。
2. **每条规则可单独关掉**，关掉后列表立刻重算。全关 = 不过滤（有测试守着）。
3. **规则宁窄勿宽**。只收能在真实样本里找到出处的模板，不收技术名词。
   `Introducing latency metrics` 这类会漏杀，接受；把 `Rust rewrite` 判成推广才是灾难。

### 两条从真实误杀里改出来的判据

第一版规则直接挡掉了 `owner == author` 的所有帖子和同一账号的所有帖，实测发现两处误杀：

- **自荐不等于噪声**。样本里 3 条自荐帖正文都有 266~276 字的具体技术细节
  （讲清做了什么、怎么做的、遇到什么问题），是这批里信息量最高的内容。
  改成「自荐 **且** 正文 <120 字」后，薄自荐（38 字「看看这个仪表盘有多美」）照样挡，
  厚自荐全部保留。
- **刷屏不该连坐内容**。线上有一批同一账号把「10 个开源仓库清单」贴到 10 个不同仓库。
  全挡 = 用户完全看不到这条内容，但它本身有价值。改成「只留第一条」后，
  重复清掉了、信息没丢。

这两条都是先看真实输出、再改判据，不是凭想象调参。`tests/audit_filter.js`
就是干这个的——逐条打印「留/挡 + 原因 + 正文长度」，人工过一遍。

### 为什么不用模型判

试过用模板判据就够：52% 的噪声全部落在五类结构特征里，不需要语义理解。
用模型意味着每次刷新都要花额度、要处理超时、还要解释「为什么挡了它」——
三个成本换 0 收益。判据是纯函数，可以在 Node 里跑真实样本，也可以被变异测试证伪。

### 测试

```sh
node tests/test_noise.js      # 用真实样本，含变异可证伪的断言
python3 tests/preview_server.py   # 本地预览（真实样本喂 mock API）
```

`tests/fixtures/` 存的是 2026-11-26 抓的真实上游数据。测试从 `index.html`
里**抽取**被测函数而不是复制一份，复制会漂移、测试会变成验证副本。
