# TapStory

照片背后贴一张 NFC 卡片，用手机碰一碰就能听到家人留在照片里的声音。
纯网页（手机浏览器），运行在 Cloudflare：Workers + D1（数据）+ R2（录音）。

## 产品流程

```
碰卡片 → 卡片是否已激活？
├─ 否 → 登录（Google / Apple / 邮箱）
│       → 有家庭吗？ 否 → 输入家庭名称创建
│       → 选择家庭并激活 → 给卡片起名（"这个 TapStory 贴在了哪个物品上？"）→ 留言录音
│       → 家庭未升级时，每张卡首次留言成功后 → 升级为家庭版 → 邀请家庭成员
└─ 是 → 留言列表：任何人点一下直接播放（无需登录）
        点「留言录音」→ 已登录？ 否 → 登录
          → 是这个家庭的成员？ 是 → 正常录音留言
          → 否 → 家庭已开通家庭版？
                  是 → 填写身份和申请理由，发送申请 → 管理员在「家庭成员」里同意
                  否 → 标准版仅支持 1 人留言 → 升级为家庭版 → 再发送申请
```

| | 标准版（免费） | 家庭版 |
| --- | --- | --- |
| 谁能留言 | 仅 1 人（家庭管理员） | 不限人数的家庭成员 |
| 音频 | 永久保存 | 永久保存 |
| 邀请家人 | — | 邀请链接、审核加入申请 |
| 价格 | — | 季付 9.9 元/月（每季 29.7 元）、年付 6.9 元/月（每年 82.8 元） |

App 内三个分页：**卡片**（家庭的所有卡片）、**家庭成员**（邀请、审核申请、移除成员）、**我的**（名字、套餐、切换 / 新建家庭、退出）。

## 防止被爬虫遍历

- 卡片网址 `https://<域名>/c/<令牌>`，令牌是 128 位随机数，不是编号；D1 里只存 SHA-256。
- 没有任何卡片列表或站点地图；`/c/<任意>` 返回同一个页面，无效与格式错误的令牌返回同样的 404。
- 每个 IP 每分钟最多 10 次无效令牌（Workers Rate Limiting），超出返回 429。
- `X-Robots-Tag: noindex`、`robots.txt` 全站禁止、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`。
- 家庭成员在 App 里按卡片编号打开卡片，服务端校验成员身份；非成员拿不到编号。
- 管理员可以停用外泄的卡片：`npm run cards -- revoke <编号>`。

## 部署（GitHub Actions → Cloudflare）

D1 `tapstory-db` 和 R2 `tapstory-audio` 已在 Cloudflare 账号里建好，ID 写在 `wrangler.jsonc`。
[`.github/workflows/tapstory.yml`](../.github/workflows/tapstory.yml) 每次 push / PR 跑测试，
push 到默认分支（或手动 *Run workflow*）时构建网页、应用数据库迁移并部署。

在仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 必需 | 说明 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | 是 | 模板 **Edit Cloudflare Workers**，再加 **Account · D1 · Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | 是 | Cloudflare 控制台 Workers & Pages 页右侧 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 否 | 开启 Google 登录 |
| `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | 否 | 开启 Apple 登录 |
| `RESEND_API_KEY` | 否 | 用 [Resend](https://resend.com) 发送邮箱验证码 |

可选的 secret 会在部署时同步到 Worker；没配置的登录方式在登录页自动隐藏。

### 上线前务必修改（`wrangler.jsonc` → `vars`）

- `EMAIL_DEV_CODES: "1"` 是**测试模式**：邮箱验证码直接显示在页面上，任何人都能登录任意邮箱。
  配好 `RESEND_API_KEY` 和 `EMAIL_FROM` 后改成 `"0"`。
- `PAYMENT_MODE: "demo"` 表示升级家庭版**不扣款**直接生效。接入真实支付前不要对外收费。
- 中国大陆访问 `*.workers.dev` 不稳定，请绑定自己的域名（取消 `routes` 注释），并在生成卡片前确定域名。

### 登录方式配置

- **Google**：Google Cloud Console → APIs & Services → Credentials → OAuth client ID（Web application），
  Authorized redirect URI 填 `https://<域名>/api/auth/google/callback`。
- **Apple**：Apple Developer → Identifiers 建 Services ID（即 `APPLE_CLIENT_ID`），开启 Sign in with Apple，
  Return URL 填 `https://<域名>/api/auth/apple/callback`；Keys 里建一个 Sign in with Apple 的 key，
  下载的 `.p8` 文件内容即 `APPLE_PRIVATE_KEY`，Key ID 即 `APPLE_KEY_ID`。
- **邮箱**：Resend 里验证发件域名，`EMAIL_FROM` 改成该域名下的地址。

同一个已验证邮箱用不同方式登录，会合并到同一个账号。

## 生成卡片并写入 NFC

```bash
cd tapstory
npm install
npx wrangler login
npm run cards -- mint -n 20 --base-url https://tap.example.com -o cards.csv
npm run cards -- list
```

网址只在生成时输出一次。用 NXP TagWriter 或 NFC Tools 把网址以 URI 记录写入 NTAG213/215/216，
**写完锁定为只读**（防止被改写成钓鱼网址），全部写完后删除 `cards.csv`。

## 开发

```bash
npm install
npm run dev         # 构建网页 + 本地 D1/R2，http://localhost:8787
npm run typecheck   # Worker 与网页两套 TypeScript 检查
npm test            # 在 wrangler dev 上跑完整产品流程的接口测试
```

```
worker/           Cloudflare Worker
  index.ts        路由、安全响应头、CSRF、SPA
  auth.ts         邮箱验证码、Google、Apple 登录，会话
  app.ts          卡片、家庭、申请、邀请、留言、升级
  security.ts     令牌、哈希、ES256 签名、音频格式识别
web/              手机网页（Preact + Vite）
  pages/          Card（碰卡后的全部流程）、Login、Home（卡片 / 家庭成员 / 我的）、Join
  components/     Messages（语音气泡播放）、Recorder（麦克风录音）、Plans（升级、申请）
migrations/       D1 表结构
scripts/cards.mjs 生成 / 列出 / 停用卡片
```

## 待确认

- **支付**：目前是演示模式。需要确定接入哪家（微信支付、支付宝、Stripe 等）。
- **谁能付费升级**：现在任何登录用户都能为卡片所属家庭付费（例如访客送给家人），付费后仍需管理员同意才能加入。
