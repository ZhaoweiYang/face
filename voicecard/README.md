# VoiceCard · 照片语音留言（NFC）

在照片背后贴一张 NFC 卡片。用手机触碰卡片会打开这张卡片专属的网页：

- **第一位登录并打开它的用户**自动认领这张卡片，成为主人，只有主人可以录制、上传、删除留言；
- **之后触碰的人**（无需登录）只能收听这些留言，可以逐条播放或"依次播放全部"。

纯网页实现，手机不需要安装 App；iPhone（iOS 13+ 可读 NFC 网址）和安卓都能直接用。

## 两个核心需求怎么实现

### 1. 链接不能被爬虫遍历

| 措施 | 说明 |
| --- | --- |
| **128 位随机令牌** | 卡片网址形如 `https://<域名>/c/Dcu3kq4lWMBYNKfU52dA8Q`，令牌由 `secrets.token_urlsafe(16)` 生成，不是自增编号。可能的组合有 2¹²⁸ 种，没有任何规律可遍历。 |
| **网站上不存在任何入口** | 没有卡片列表、站点地图或跨卡片链接；不知道令牌就到不了卡片。API 文档（`/docs`、`/openapi.json`）也关闭了。 |
| **猜测限流** | 每个 IP 10 分钟内最多 20 次无效令牌，超出后连有效令牌也返回 429，扫描器得不到任何信息。 |
| **不做"存在性"提示** | `/c/<任意>` 返回完全相同的页面；无效令牌和格式错误的令牌返回同样的 404。 |
| **数据库只存哈希** | 卡片令牌和登录会话都只存 SHA-256，数据库泄露也拿不到可用网址。 |
| **音频不是静态文件** | 音频只能通过 `/api/cards/<令牌>/messages/<随机ID>/audio` 获取，并核对留言属于该卡片。 |
| **万一网址外泄** | `X-Robots-Tag: noindex`、`robots.txt` 全站禁止、`Referrer-Policy: no-referrer`（点外链不会带出网址）、`Cache-Control: no-store`；管理员可以 `revoke` 停用卡片。 |

> 进一步加强：改用 **NTAG 424 DNA** 芯片的 SUN/SDM 功能，每次触碰生成带计数器和 CMAC 签名的一次性网址，
> 复制下来的网址无法重复使用（见文末"后续计划"）。

### 2. 首个登录用户认领上传权限

- 卡片由管理员预先生成（`cli.py mint`），初始无主。
- 已登录用户打开无主卡片时，页面自动发起 `POST /api/cards/<令牌>/claim`；
  服务端用一条原子 SQL `UPDATE … WHERE owner_id IS NULL` 认领，并发时只有一人成功，其余返回 409。
- 未登录用户打开无主卡片会看到登录 / 注册表单，登录后立即认领。
- 认领用 POST 而不是打开链接（GET）时触发，防止微信等聊天软件的链接预览、浏览器预加载误认领。
- 上传、删除、改标题都校验 `owner_id`；其他人（包括其他登录用户）只能收听。
- 主人换手机时，在卡片页底部点"我是卡片主人，登录后留言"即可。

## 快速开始

```bash
cd voicecard
pip install -r requirements.txt

# 生成 10 张卡片（网址只输出这一次，数据库里只有哈希）
python cli.py mint -n 10 --base-url https://voice.example.com -o cards.csv

# 启动服务
uvicorn app:app --host 0.0.0.0 --port 8100
```

本地调试用 `http://localhost:8100/c/<令牌>`，需加 `VOICECARD_SECURE_COOKIE=0`（否则 http 下登录 Cookie 不生效）。
**手机上录音必须是 HTTPS**（浏览器只在安全环境下开放麦克风）。

### 写入 NFC 卡片

1. 推荐 NTAG213 / 215 / 216 贴纸或卡片（网址约 50 字节，NTAG213 足够）。
2. 用 **NXP TagWriter** 或 **NFC Tools** App，把 `cards.csv` 中的网址以 *URI / 网址* 记录写入。
3. **写完务必锁定为只读**（TagWriter 的 "Protect / Lock"，NFC Tools 的"锁定标签"），
   否则任何人都能把卡片改写成钓鱼网址。
4. 全部写完后删除 `cards.csv`。

### 管理命令

```bash
python cli.py list            # 列出卡片：编号、状态、主人、留言数（不含网址）
python cli.py unclaim 3       # 解除认领（例如主人忘记账号）
python cli.py revoke 3        # 停用卡片（例如网址被公开）
```

## 部署

前面放一个 HTTPS 反向代理（Nginx / Caddy），并让 uvicorn 信任代理传来的客户端 IP（限流依赖它）：

```bash
uvicorn app:app --host 127.0.0.1 --port 8100 --proxy-headers --forwarded-allow-ips=127.0.0.1
```

Caddy 示例：

```
voice.example.com {
    request_body max_size 12MB
    reverse_proxy 127.0.0.1:8100
}
```

限流计数在进程内存中，请用**单个 worker** 运行；需要多实例时把 `security.RateLimiter` 换成 Redis 实现。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VOICECARD_DATA_DIR` | `voicecard/data` | SQLite 数据库与音频文件目录（请备份） |
| `VOICECARD_SECURE_COOKIE` | `1` | 登录 Cookie 只走 HTTPS；本地 http 调试设为 `0` |
| `VOICECARD_SESSION_DAYS` | `30` | 登录有效期 |
| `VOICECARD_MAX_SECONDS` | `180` | 单条留言最长秒数 |
| `VOICECARD_MAX_AUDIO_MB` | `10` | 单条留言最大体积 |
| `VOICECARD_MAX_MESSAGES` | `50` | 每张卡片最多留言数 |
| `VOICECARD_TRANSCODE` | `auto` | 安卓录的 webm/ogg 用 ffmpeg 转成 AAC（`.m4a`），旧款 iPhone 也能播放；`auto` 表示装了 ffmpeg 就转，`off` 关闭 |

## 结构

```
voicecard/
├── app.py           FastAPI：页面、认证、卡片、留言上传与播放、安全响应头、限流、CSRF
├── db.py            SQLite：users / sessions / cards / messages
├── security.py      令牌生成与哈希、scrypt 密码、滑动窗口限流
├── cli.py           生成 / 列出 / 解除认领 / 停用卡片
├── static/          手机网页（原生 JS，无需构建）：收听、登录认领、录音上传
└── tests/           pytest：防遍历、认领竞争、权限、Range 播放等
```

录音使用浏览器 `MediaRecorder`（安卓 / 桌面是 Opus-webm，iOS Safari 是 AAC-mp4），
不支持时退回到系统录音 / 选择音频文件。服务端按文件头识别格式（不信任客户端声明的类型），
音频接口支持 HTTP Range，iOS Safari 才能正常播放和拖动进度。

其他安全细节：密码用 scrypt 加盐哈希；登录失败按 IP 限流且对不存在的用户做同样耗时的校验；
Cookie 为 `HttpOnly; SameSite=Lax; Secure`；写操作要求 `X-Requested-With: voicecard` 请求头
（跨站页面无法附加自定义请求头，以此防 CSRF）；严格的 CSP 禁止内联脚本。

## 测试

```bash
pip install -r requirements-dev.txt
pytest
```

## 后续计划

- **NTAG 424 DNA SUN 动态网址**：每次触碰网址里带加密的芯片 UID + 计数器和 CMAC，服务端验签并拒绝旧计数器，
  可以做到"必须真的碰到卡片才能听"，截图或转发的网址会失效。
- 手机号 / 微信登录（目前是用户名 + 密码）。
- 主人转让卡片、多位共同主人、访客留言待审核。
- 音频存到对象存储（S3 / OSS），用短期签名 URL 下发。
