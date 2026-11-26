# Trendshift 备份说明

**当前版本：v6.9**（tag 指向 `0d9e76c`）· 线上 https://trendshift-lite.logos7313.workers.dev/

## 备份位置

| 位置 | 内容 | 用途 |
|---|---|---|
| **GitHub 仓库** `rikkaflow/trendshift` | 完整 git 历史 + v5 … v6.9 标签 | 主备份，跨设备可用 |
| **GitHub Releases** `v6.9` | 3 个附件：bundle / Worker 快照 / KV 译表导出 | 离线恢复包，不依赖本机 |
| `/var/minis/shared/work/trendshift-review-1125` | 开发工作副本（当前 HEAD = master） | 本机开发 |
| `/var/minis/shared/work/trendshift-review-1125/backup/` | 同上三个文件的本地副本 | 离线恢复 |
| **Cloudflare KV** `trendshift-tr` | 译表 `tr.json`（1878 条） | 线上数据，云端每日自增 |

### GitHub Release `v6.9` 附件（可直接下载）

https://github.com/rikkaflow/trendshift/releases/tag/v6.9

| 附件 | 大小 | sha256 前缀 |
|---|---|---|
| `trendshift-v6.9.bundle` | 908,519 B | `9bf7e0b2109a21a3…` |
| `deployed-worker-v6.9.js` | 689,797 B | `f0f53ba93ab079d3…` |
| `tr-v6.9.json` | 389,775 B | `70ae1134975a9b3e…` |

**已实测的三层验证**（不是「上传成功」就算）：

1. 下载三个附件 → sha256 与本地**逐字节一致**
2. 用下载的 bundle 克隆 → HEAD=`0d9e76c`、11 个标签齐全
3. 从该克隆跑 `build_worker.py` → 产物与 `deployed-worker-v6.9.js` **逐字节一致**

第 3 步是关键：它证明备份不仅能恢复源码，还能恢复出**和线上跑的完全一样**的产物。

> **注意**：译表有两份。KV 里的是线上权威数据（每天自动增长）；
> `src/translations.json` 只是构建期内联兜底快照，KV 不可用时 Worker 才用它。
> 恢复时**不要**用仓库里的旧快照覆盖 KV。

## 恢复

```bash
# 从 GitHub 仓库（推荐）
git clone https://github.com/rikkaflow/trendshift.git src

# 或从 Release 附件（仓库挂了也能恢复，无需本机备份）
git clone https://github.com/rikkaflow/trendshift/releases/download/v6.9/trendshift-v6.9.bundle src

# 恢复后重建 + 部署（需要 CF_API_TOKEN / CF_ACCOUNT_ID）
cd src && ./deploy.sh
```

## 从 v6.7 到 v6.9 的改动

| 版本 | 内容 |
|---|---|
| v6.8 | 审计核实修复（KV 读保护 / tr 长度契约 / 译表竞态 / 历史栈 / 快照键） |
| v6.9 | **过滤器**（减法：推广腔/自荐无内容/刷屏/同文）+ **雷达**（发现：对口×冷门×扎实）+ **默认入口**（排序第一 = 打开默认） |

v6.9 新增 9 个测试文件、150+ 断言，全部从源码抽取函数而非复制副本，含变异负控。

## 日常维护成本

- **翻译**：GitHub Actions 每天 04:17 UTC 自动跑，手机不用开机
- **改代码**：才需要 `./deploy.sh`
- **改译文**：不用管（写 KV，不重建 Worker）

## 密钥位置（复现必须）

| 项 | 位置 |
|---|---|
| CF API | 环境变量 `CF_API_TOKEN` / `CF_ACCOUNT_ID` |
| KV 命名空间 | `TR_KV` 绑定（id 见 Cloudflare 后台） |
| Gemini keys | Worker secret `GEMINI_KEYS` |
| GitHub Secrets | `CF_ACCOUNT_ID` / `CF_API_TOKEN` / `TR_KV_ID` / `GEMINI_KEYS`（写这些**必须**用 `GITHUB_TOKEN_FULL_RIGHT`） |
