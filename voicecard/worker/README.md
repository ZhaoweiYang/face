# VoiceCard · Cloudflare Workers 版

与 `voicecard/app.py` 相同的接口和同一份前端（`../static`），运行在 Cloudflare 上：

| 用途 | Python 版 | Cloudflare 版 |
| --- | --- | --- |
| 接口 | FastAPI | Worker（`src/index.ts`，无框架依赖） |
| 数据 | SQLite 文件 | **D1** `voicecard-db`（表结构见 `migrations/`） |
| 录音 | 本地目录 | **R2** `voicecard-audio`（不公开，只能经 Worker 按卡片令牌读取） |
| 前端 | FastAPI 托管 | Workers Static Assets |
| 限流 | 进程内存 | Workers Rate Limiting 绑定 |
| 密码 | scrypt | PBKDF2-SHA256（Workers 只支持这个） |
| 转码 | ffmpeg（可选） | 无；前端优先录 AAC（mp4），各平台都能播 |

服务器、HTTPS、扩容都由 Cloudflare 负责。免费额度（每天 10 万次请求、D1 5 GB、R2 10 GB）对这个项目绰绰有余。

## 一、部署

D1 数据库和 R2 存储桶已经在账号里建好，表结构也已初始化，`wrangler.jsonc` 里填好了 ID。剩下两种方式二选一：

### 方式 A：从 GitHub 自动部署（推荐，无需本地环境）

1. 打开 Cloudflare 控制台 → **Workers & Pages** → **Create** → **Import a repository**。
2. 授权并选择 `ZhaoweiYang/face` 仓库。
3. 按下表填写：

   | 设置 | 值 |
   | --- | --- |
   | Project name | `voicecard`（必须与 `wrangler.jsonc` 的 `name` 一致） |
   | Production branch | 含有本目录的分支 |
   | Root directory | `voicecard/worker` |
   | Build command | 留空 |
   | Deploy command | `npx wrangler deploy` |

4. 保存后自动构建。之后每次往该分支 push 都会自动重新部署。
5. 部署完成后网址为 `https://voicecard.<你的子域>.workers.dev`。

> 以后若新增 `migrations/0002_*.sql`，在本地执行一次
> `npx wrangler d1 migrations apply voicecard-db --remote`，或把 Deploy command 改成 `npm run deploy`
> （需要构建 token 有 D1 编辑权限）。

### 方式 B：本地命令行部署

```bash
cd voicecard/worker
npm install
npx wrangler login        # 浏览器里授权
npm run deploy            # 应用数据库迁移 + 部署
```

### 绑定自己的域名（中国大陆访问建议必做）

`*.workers.dev` 在中国大陆经常无法访问。如果你有托管在 Cloudflare 的域名：

- 控制台 → Worker `voicecard` → **Settings** → **Domains & Routes** → **Add** → **Custom domain**，填 `voice.你的域名.com`；
- 或者在 `wrangler.jsonc` 里取消 `routes` 那行的注释并改成你的域名，再部署。

**写进 NFC 卡片的网址一旦写入并锁定就改不了**，所以请先确定最终域名，再生成卡片。

## 二、生成卡片

```bash
cd voicecard/worker
npm run cards -- mint -n 20 --base-url https://voice.你的域名.com -o cards.csv
npm run cards -- list              # 编号、状态、主人、留言数（不含网址）
npm run cards -- unclaim 3         # 解除认领
npm run cards -- revoke 3          # 停用卡片
```

网址只在生成时输出一次（数据库里只存哈希），写完 NFC 卡片后请删除 `cards.csv`。
写卡步骤见 [../README.md](../README.md#写入-nfc-卡片)。

## 三、配置

`wrangler.jsonc` 的 `vars`：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SESSION_DAYS` | `30` | 登录有效期 |
| `MAX_SECONDS` | `180` | 单条留言最长秒数 |
| `MAX_AUDIO_MB` | `10` | 单条留言最大体积 |
| `MAX_MESSAGES` | `50` | 每张卡片最多留言数 |
| `PBKDF2_ITERATIONS` | `100000` | 密码哈希强度。每次登录约 50 ms CPU；**Workers 免费版每请求只有 10 ms CPU**，若注册 / 登录报错 1102，改成 `10000` 后重新部署（已注册账号不受影响，哈希里记录了各自的次数） |

限流（`ratelimits`，按 Cloudflare 机房计数，窗口只能是 10 或 60 秒）：

| 绑定 | 规则 |
| --- | --- |
| `RL_MISS` | 每 IP 每分钟最多 10 次无效卡片令牌，超出返回 429 |
| `RL_API` | 每 IP 每分钟 300 次 API 请求 |
| `RL_LOGIN` | 每 IP 每分钟 10 次登录失败 |
| `RL_REGISTER` | 每 IP 每分钟 5 次注册 |
| `RL_UPLOAD` | 每用户每分钟 10 次上传 |

如需更强防护，可在域名的 **Security → WAF → Rate limiting rules** 里再对 `/api/cards/` 加一条规则。

## 四、本地开发与测试

```bash
npm install
npm run dev          # 本地 D1/R2 模拟，http://localhost:8787
npm run cards -- mint -n 1 --base-url http://localhost:8787 --local
npm test             # 启动 wrangler dev 跑接口测试（防遍历、认领、权限、Range 等）
npm run typecheck
```
