# Worker 化解码 执行记录（设计 6.4 L1 的性能要求）

> 只写实测。未做的明确列出。

## 一、为什么做：先量，再改

设计里写着「栅格解码必须放进 Web Worker」，但「必须」要有数字。于是先量（`gdal_create` + `gdal_translate -of COG` 造样本，用现有 `readCogImage` 在窗口上限 2048 px 下计时）：

| 样本 | 窗口上限下的解码 | 结论 |
|---|---|---|
| A 小 COG 256×128 | **33 ms** | 无感 |
| B **8000×8000 COG（带概视图）** | **5259 ms** | ✗ 卡 5 秒 |
| C 8000×8000 普通 GeoTIFF（无概视图，183 MB） | **2723 ms** | ✗ 卡 3 秒 |

**B 是意外**：以为概视图会让它变快，实测没有（窗口上限并没有把读放大变成读小读）。**结论：主线程会冻结 3–5 秒** ⇒ Worker 不是「原则」，是「测量结果」。缩小上限不是选项（图会糊）。

## 二、实现

| 环节 | 做法 |
|---|---|
| 读取器怎么进 worker | 插件 chunk 由模块加载器发给**页面**，worker 没有 `window.__ModuleLoader__` ⇒ worker **无法 import** 持有 TIFF 读取器的 chunk。因此读取器以**文本**形式随我们的 chunk 旅行，用 Blob URL 实例化为 **classic worker**（UMD 包装因此能挂到 `self`）——与 MapLibre 自带 worker 同一手法（契约 #22 早有先例 ✓） |
| 文本怎么来 | 客户端预设新增 **`?raw` 资产插件**（`resolveId` + `load`）：裸包名经**浏览器构建偏好**解析（否则会拿到 Node 版，契约 #32），本地路径直接读 |
| 什么跨边界 | **原始样本**（Transferable，零拷贝），不是 RGBA。**理由不只是性能**：RGBA 展开在 worker 里就必须 import 我们共享的像素模块 ⇒ worker chunk 与 COG chunk 互相 require ⇒ 加载器无法解析 chunk require（契约 #31/#39）。展开留在主线程（O(像素) 的简单算术，数十毫秒） |
| 兜底 | 页面没有 Worker/Blob 时（jsdom、异形嵌入）走主线程；那条路**独立成 chunk**，浏览器永不下载第二份读取器 |

## 三、实测（8/8）

- **`check:cog` 8 项全过**，新增一条**决定性断言**：`page.on('worker')` 观察到 worker 被创建 ⇒ 解码确实**不在主线程**；同时「无绘制问题」「经字节路由 Range 读取」「读的是窗口不是整文件」全部保持 ✓。
- 单测 2 条：本环境（jsdom）无 worker ⇒ 走兜底 ✓；worker 源**含读取器与处理器、且我们自己那段不含任何 import/require** ✓（读取器是 UMD 还是 ESM 由预设决定，node 环境断言不了，故交给浏览器检查 ✓）。
- 全量：节点 **197 通过 + 1 跳过**、web **13 通过**、产物契约 ✓。

## 四、🔴 抓到的两个坑

1. **blob worker 里的相对 URL 会相对 `blob:` 解析**：`fetch('/api/gis/blob?...')` 变成 `blob:http://host/api/...` ⇒ 网络错误、**0 次 Range 请求**。修法：主线程用 `document.baseURI` 解析成**绝对 URL** 再传进 worker。
2. **序列化共享函数会制造 chunk 环**（详见第二节）：最初把 `toRgba` 的源码序列化进 worker（想防漂移），结果 worker 需要 import 该模块 ⇒ 与 COG chunk 互相 require ⇒ 加载器直接报 `missed the module table`。改成「原始样本过界、展开留主线程」后环消失 ✓ —— **防漂移的目标由架构达成，而不是由字符串拼接达成**。

## 五、诚实边界

1. **发布体积翻倍**：`client.decode-worker.js` 548 kB（内联 UMD 文本）+ `client.geotiff.js` 615 kB（无 Worker 时的兜底）= 1.16 MB。**浏览器实际只会下前一份**（后者永不请求），但仓库里的产物总量变大了；要消掉它得让兜底也不带读取器（例如彻底不支持无 Worker 环境）。
2. **预览体的字节也走 worker，但仍是「整份字节」**：48 MB 上限不变。
3. **只验证了小 COG 的端到端**（`check:cog` 的 fixture）：8000² 那三个样本只在 **Node 里计时**，没有在浏览器里跑过 B/C ⇒ 「worker 里的 5 秒」没有直接测过（测的是主线程的 5 秒）。要补需一个大 COG fixture（`check:exit` 那条路已有 1.89 GB 源文件，可在其上再生成一个 COG）。
4. **worker 常驻**：为一次解码启动后不回收（`stopDecodeWorker` 存在但没有调用点）。多图层场景需要按需回收。
5. **进度条仍是字节轮询**（T2.11 的判定），与实际解码进度无关。
