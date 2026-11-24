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

```
index.html              前端全部逻辑（单文件，无构建步骤）
worker.template.js      Worker 源码，__ASSETS__ 处会被替换成内联资源
build_worker.py         打包脚本：把静态文件塞进模板 → /tmp/ts_worker.js
make_icons.py           生成 PNG 图标（Pillow）
manifest.webmanifest    PWA 清单
sw.js                   Service Worker（外壳网络优先，API 失败回缓存）
icon.svg / icon-*.png   图标
archive/patches/        历史补丁脚本（已应用，仅作记录）
```

---

## 修改与部署

### 改前端

直接编辑 `index.html`，然后：

```bash
cd /var/minis/shared/trendshift-lite/src
python3 build_worker.py
# 产物在 /tmp/ts_worker.js
```

### 部署

```bash
cd /var/minis/shared/trendshift-lite/src
python3 build_worker.py && python3 - <<'PY'
import os, urllib.request
tok = os.environ['CF_API_TOKEN']; acc = os.environ['CF_ACCOUNT_ID']
body = open('/tmp/ts_worker.js', 'rb').read()
url = f"https://api.cloudflare.com/client/v4/accounts/{acc}/workers/scripts/trendshift-lite"
req = urllib.request.Request(url, data=body, method='PUT',
    headers={'Authorization': 'Bearer ' + tok,
             'Content-Type': 'application/javascript'})
print(urllib.request.urlopen(req, timeout=90).status, 'deployed')
PY
```

部署后验证：

```bash
curl -s https://trendshift-lite.logos7313.workers.dev/health
curl -s "https://trendshift-lite.logos7313.workers.dev/api/list?tf=weekly&lang=all&limit=3"
```

### 环境变量

| 变量 | 用途 |
|---|---|
| `CF_API_TOKEN` | Cloudflare API token（Workers 编辑权限） |
| `CF_ACCOUNT_ID` | Cloudflare 账号 ID |

---

## 已知边界

- **洞察（Insights / Fragmentation Index）未实现**：官方这个页面的数据既不在 API 里，也不在服务端渲染的 HTML/RSC 里，是前端现算的。要复现得自己重跑他们的算法。
- **主题 / 热门 / 开发者依赖页面结构**：这三块解析的是官方页面的 Next.js RSC 载荷，**官方改版可能失效**，届时需要重新适配 `rscText()` + `findOne()` 的判据。
- **数据延迟最多一天**：第三方镜像每日 20:17 UTC 同步一次。
- **翻译依赖 Google 免费端点**：无 SLA，限流时会保留英文原文。MyMemory 备用源的免费额度已耗尽。
- **官方 API 用不了**：`api.trendshift.io` 需要 `ts_live_` 开头的付费 key。

---

## 踩过的坑（改之前值得看）

1. **Worker 必须用 `addEventListener('fetch', ...)`**，不能 `export default`——上传报 `Uncaught SyntaxError: Unexpected token 'export'`（错误码 10021）。
2. **首次部署后要开子域**：`POST /accounts/{acc}/workers/scripts/{name}/subdomain` body `{"enabled":true}`，否则 workers.dev 返回 `error code: 1042`。
3. **RSC 数据全嵌在数组里**：遍历时必须往下钻数组，但判定只能在 dict 上做。第一版跳过了数组元素，一个数据都找不到。
4. **翻译必须走客户端**：Worker 出口请求 Google 翻译返回空字符串（`{"zh":[""]}`），浏览器直连正常。
5. **翻译要逐条请求**：批量时用 `\n` 拼多段，但推文正文本身含换行，拆回来对不齐，整批失败。
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
