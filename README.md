# 照片 → 3D 人脸（眨眼 / 张嘴 / 左看 / 右看）

上传一张正面人像照片，在浏览器里生成一个可以动的 3D 人脸，点快捷按钮即可 **眨眼、张嘴、左看、右看**。
全部计算在本地完成，照片不会上传到任何服务器。

## 功能

- **上传照片**：点击、拖拽或直接粘贴图片（JPG / PNG / WebP）。
- **生成 3D 版本**：用 MediaPipe Face Landmarker 检测 478 个带深度的人脸特征点，构建带照片贴图的 3D 网格；脸部之外的区域自动接到照片边缘，形成一张有浮雕感的"3D 照片"。可拖拽旋转、滚轮缩放。
- **快捷动作**：
  - 😉 眨眼（一次性动画）
  - 😮 张嘴（切换，露出暗色口腔，牙齿随上唇保留）
  - 👀 左看 / 右看（眼球移动 + 头部随视线偏转，再点一次恢复）
  - 自动演示、复位
  - 键盘：`1` 眨眼、`2` 张嘴、`←` 左看、`→` 右看、`0`/`R` 复位
- **微调**：立体强度、张嘴幅度、眼睛闭合度、视线方向滑杆；网格线显示；自动转动开关；导出 PNG 截图。

## 快速开始

```bash
npm install     # 安装依赖，并把 MediaPipe 的 wasm 运行时复制到 public/mediapipe/
npm run dev     # 本地开发：http://localhost:5173
npm run build   # 类型检查 + 生产构建，输出到 dist/
npm run preview # 预览 dist/
```

构建产物是纯静态文件，可直接部署到任意静态托管（GitHub Pages、Vercel、Nginx 等）。`vite.config.ts` 使用相对 `base`，放在子路径下也能工作。

> 人脸模型文件 `public/models/face_landmarker.task`（约 3.7 MB）已包含在仓库中，运行时不依赖任何外部 CDN。

## 技术实现

```
src/
├── main.ts          UI 交互：上传、按钮、滑杆、键盘、动画编排
├── landmarker.ts    MediaPipe Face Landmarker 封装（GPU 失败自动回退 CPU）
├── faceModel.ts     由特征点构建 3D 网格 + 表情形变（核心）
├── viewer.ts        three.js 场景、贴图、轨道控制、自动摆动
├── tween.ts         轻量参数补间
├── geometry2d.ts    2D 几何工具（射线/多边形、环带三角化、折线插值）
├── landmarks.ts     MediaPipe 特征点索引常量（眼睛、嘴唇、脸部轮廓等）
└── triangulation.ts 468 点标准三角剖分（来自 tfjs-models，Apache-2.0）
```

**网格构建**（`faceModel.ts`）

1. 478 个特征点 → 顶点，`z` 作为深度（可通过"立体强度"放大），纹理坐标直接取照片位置。
2. 标准三角剖分去掉眼睛内部三角形，改为"虹膜扇形 + 虹膜环到眼眶的环带"，这样虹膜顶点移动时瞳孔会跟着动。
3. 嘴唇内环原本是空洞：新增一份下内唇顶点副本作为"牙齿带"（跟随上唇），其下方用暗色网格填充口腔。
4. 从脸部轮廓向照片四边发射射线得到外圈顶点，与脸部轮廓做环带三角化，把整张照片接进网格。

**表情形变**

- 所有 2D 形变在"脸部坐标系"（下巴→额头为纵轴）里进行，倾斜的脸也能正确眨眼、张嘴。
- 眨眼：上眼睑顶点落到对应下眼睑位置，眼睑上方皮肤按距离衰减跟随，眼内顶点塌到下睑线。
- 张嘴：下唇、下巴整体下移（横向按嘴宽衰减），上唇轻微上提，嘴角移动一半。
- 左看 / 右看：虹膜顶点在眼眶内平移（自动夹在眼眶多边形内），同时整张脸绕头部后方的竖直轴偏转，外圈保持不动实现平滑过渡。

## 致谢

- [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
- [three.js](https://threejs.org/)
- 三角剖分数据来自 [tensorflow/tfjs-models](https://github.com/tensorflow/tfjs-models)
