# AI 视频引擎（服务端）

前端默认是"即时 3D"模式（浏览器内网格形变，秒出但偏假）。部署本服务后，
上传照片会由 **LivePortrait** 神经网络重演出一组短视频（眨眼、张嘴、左看、右看、
数字 0–9 的口型），前端自动切换为播放这些预生成片段，效果自然得多。

每个片段都从中性姿态开始、回到中性姿态结束，因此可以任意顺序无缝衔接。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 引擎状态：`{ok, engine, error, clips}` |
| `POST` | `/api/animate` | 表单字段 `image` 上传照片，返回 `{job_id, status}`；同一张图按哈希缓存 |
| `GET` | `/api/jobs/{id}` | `{status, progress, current, neutral, clips{name: url}}` |
| `GET` | `/api/clips/{id}/{file}` | 片段视频与中性静帧 |

`status` 为 `queued → running → done | error`，`progress` 0–1，`current` 是正在渲染的片段名。

## 在 GPU 机器上部署（推荐 Docker）

```bash
# 在仓库根目录
docker build -t face3d-server -f server/Dockerfile .
docker run --gpus all -p 8000:8000 -v face3d-data:/app/server/data face3d-server
```

镜像构建时会克隆 LivePortrait 并从 HuggingFace 下载权重（约 1.5 GB），首次构建较慢。
启动后前端访问 `http://<机器>:8000/`（镜像已包含构建好的前端，也可以单独部署前端并把
`VITE_API_BASE` 指向本服务）。

## 手动部署

```bash
# 1. LivePortrait（需要 CUDA GPU，实测 8 GB 显存足够）
git clone https://github.com/KwaiVGI/LivePortrait /opt/LivePortrait
cd /opt/LivePortrait
pip install -r requirements.txt
huggingface-cli download KwaiVGI/LivePortrait --local-dir pretrained_weights --exclude "*.git*" "README.md" "docs"

# 2. 本服务
cd <仓库>/server
pip install -r requirements.txt
FACE3D_ENGINE=liveportrait LIVEPORTRAIT_DIR=/opt/LivePortrait \
  uvicorn app:app --host 0.0.0.0 --port 8000
```

系统需要 `ffmpeg`（LivePortrait 依赖）；片段编码使用 `imageio-ffmpeg` 自带的 ffmpeg。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FACE3D_ENGINE` | `mock` | `liveportrait` 或 `mock`（无 GPU 的联调假引擎，只会平移/变暗照片） |
| `LIVEPORTRAIT_DIR` | `LivePortrait` | LivePortrait 仓库路径（内含 `pretrained_weights/`） |
| `FACE3D_DATA_DIR` | `server/data` | 任务与片段缓存目录 |
| `FACE3D_FRONTEND_DIR` | `../dist` | 若存在则同时托管前端 |
| `FACE3D_CODEC` | `h264` | `h264`（mp4，浏览器通用）或 `vp9`（webm） |
| `FACE3D_GPU` | `0` | GPU 编号 |
| `FACE3D_HALF` | `1` | 半精度推理；出现黑块时设为 `0` |
| `FACE3D_CROP_SCALE` | `2.3` | LivePortrait 人脸裁剪比例 |

## 动作定义

`motions.py` 用关键帧描述每个片段，参数即 LivePortrait 图像重定向界面上的滑杆
（眼睛开合比、嘴唇开合比、头部相对偏转角、眼球方向、微笑、噘嘴/抿嘴/咧嘴等）。
调节幅度或增加新动作只需改这个文件，无需录制驱动视频。

**方向约定**：左看 / 右看以人物自己的视角为准（人物的左 = 观众的右）。若在你的
环境里方向相反，把 `motions.py` 顶部的 `YAW_CHARACTER_LEFT`、`GAZE_CHARACTER_LEFT`
取反即可。抿嘴（`purse`）的正负方向同样可能因 LivePortrait 版本而异，看效果调整
`_viseme()` 中的符号。

## 本地联调（无 GPU）

```bash
cd server && pip install -r requirements.txt
FACE3D_ENGINE=mock uvicorn app:app --reload          # 假引擎
cd .. && npm run dev                                 # Vite 会把 /api 代理到 :8000
```

## 性能参考

每张照片渲染 14 个片段、约 340 帧。LivePortrait 在 RTX 3090 上约 25–40 fps，
一次生成大约 10–20 秒；结果按图片哈希缓存，重复上传立即返回。
