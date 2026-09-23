# T1a.10 执行记录（派生缓存：配额 + LRU）

> 只写实测。未做的明确列出。

## 一、任务与判据

| 产出物 | 完成判定 |
|---|---|
| 派生缓存：配额 + LRU | **超配额按 LRU 淘汰；缓存键含 mtime/size** |

设计依据（`方案设计.md`）：

| 处 | 要求 |
|---|---|
| 8.3 | 缓存键 = 源文件路径 + mtime + size + 转换参数，**源一变自动失效**；**配额（默认 5 GB）+ LRU 淘汰**，设置页可调、可一键清空 |
| 11.5 / 1001 | 「能重建的就不要迁移」；缓存目录按内容哈希命名，**可整体丢弃重建** |
| 风险 7 / 1049 | 宿主附件库无上限且永不自动清理 ⇒ 派生数据**必须自带配额** |
| 1292 | 设置项 `cacheQuotaMb` 默认 `5120` |
| 1364 | 错误码 `CACHE_QUOTA_EXCEEDED`（提示可清空缓存） |
| 11.4 / 1115 | 首次 COG 转换是分钟级：后台任务 + 进度 + **先查配额** |

## 二、交付物

| 文件 | 职责 |
|---|---|
| `packages/gis-core/src/cache-key.ts`（新） | 内容派生键 + 布局版本 + 路径段安全校验 |
| `packages/gis-core/src/cache.ts`（新） | `DerivedCache`：配额 / LRU / 两段式原子提交 / 扫描重建 / 清空 / 降级 |
| `packages/gis-core/src/index.ts`（改） | `static Config`（`cacheDir`、`cacheQuotaMb`）+ 暴露 `ctx.gis.cache`，激活时预热 |
| `packages/gis-core/tests/cache.spec.ts`（新） | 25 条测试 |
| `scripts/t1a10-real-instance.mjs` + `scripts/t1a10-probe.mjs`（新） | 可重跑的真实实例验证（真 `dsh --profile gisweb` 启动三次） |

## 三、六个设计决定

1. **键 = 版本 + kind + extension + 规范化源路径 + size + mtime + 排序后的参数**（sha256 前 32 位，`ck_` 前缀）。参数排序 ⇒ 同一次请求怎么拼都是同一个键；路径按 dataset id 的同一口径归一（反斜杠→斜杠、小写）⇒ Windows 上同源同键。**kind / extension 只能是安全路径段**，否则一个拼错的 `kind` 就写到缓存根外面去了。
2. **目录即状态。** 内存索引只是加速器：`open` 扫描重建，用文件 mtime 当「最后使用时间」，并**清掉上次崩溃留下的 `.partial`**。删掉整棵树是受支持的操作（`clear()` 或直接 `rm -r`）——这正是设计 11.5 要的「可整体丢弃重建」。
3. **两段式写入。** `begin(identity, 估算字节)` → 调用方写 staging 路径（`<artifact>.partial`）→ `commit` 原子 rename。取消或崩溃留下的半成品**永远不会被当成命中**。**配额在 `begin` 就查**（设计要求的「先拒绝再失败」），`commit` 再用真实大小查一次，不合格就把 staging 删掉。
4. **配额是实时读的函数，不是构造时的数字。** `cacheQuotaMb` 是 volatile 字段，`quotaBytes: () => config.cacheQuotaMb.get() * 1024 * 1024`，所以**改设置下一次操作就生效**（单测里用可变闭包断言了这条）。`cacheDir` 则**不是** volatile——换目录要重载，因为树的身份就是它的位置。配额 0 = 关闭缓存。
5. **LRU 跨进程**：命中时刷新该文件的 mtime（默认每小时最多刷一次，避免热路径每次都写盘）。不刷的话重启后 LRU 顺序会退化成「写入顺序」——那就不叫 LRU 了。
6. **降级要吵，但不能连坐。** 目录建不起来时：警告一行、`resolve` 一律当 miss（**miss 是缓存的正常状态**，不能让只读盘毁掉整个地图渲染），但 `begin`/`put` **抛错**——否则调用方会在「永远 miss」里无限重算同一个派生数据而没人发现。

## 四、实测：单元测试 25 条 + 变异检查

`packages/gis-core/tests/cache.spec.ts`：键语义（size/mtime/路径/kind/extension/参数各改一项必须换键；参数顺序无关；路径归一；非法段拒绝）、存取往返（字节内容断言，不是「文件存在」）、配额与 LRU（谁被淘汰、谁留下）、`begin/commit/abort` 的可见性与原子性、**超额时「什么都没写」**（`readdir` 为空）、配额为 0、**实时配额**、开树时按配额收敛、重启后重建索引并保持 LRU、外部删除自愈、`clear` 与 `remove`、不可用目录的降级、以及服务层（配置目录/配额、`<DSH_HOME>/cache/gis` 默认值、激活即建树）。

**变异检查**（本项目方法论第 4 条的落地）：把 `evictFor` 的淘汰循环短路后重跑 —— **6 条失败**，说明这些断言真的在测淘汰，而不是「跑成功了」。

## 五、实测：真实实例（14 项全过）

`node scripts/t1a10-real-instance.mjs` —— 真 `dsh --profile gisweb` 启动 3 次；缓存根与存储根都被 `--patch` 改到临时目录，`webserver` 行禁用：

```
[1/3] boot A -- 真进程里的配额与淘汰
  PASS  the cache lives where the row config says (...\derived)
  PASS  the quota comes from the row config (1048576 bytes)
  PASS  the second artifact was stored and resolves (614400 bytes)
  PASS  the first artifact was evicted by LRU when the quota was reached
  PASS  a 2 MiB artifact against a 1 MiB quota is refused (CACHE_QUOTA_EXCEEDED)
  PASS  the tree holds exactly one artifact ({"entries":1,"bytes":614400,...})
  PASS  the directory on disk agrees: ["ck_2e020a2d96483601aae1ed7c39319379.bin"]

[2/3] boot B -- 第二个进程读同一棵树，LRU 也活过重启
  PASS  the artifact from boot A is still a hit in a new process
  PASS  the evicted artifact stayed evicted
  PASS  the newly written artifact evicted the least recently used one (LRU read back from disk)
  PASS  still exactly one artifact after the eviction

[3/3] boot C -- 清空
  PASS  clear reports what it freed (614400 bytes)
  PASS  the cache is empty afterwards
  PASS  nothing is left under the cache root: []

ALL REAL-INSTANCE CHECKS PASSED
```

这段证明的是单测证不了的：**Loader 把行 config 交到我们手里**（`cacheDir`/`cacheQuotaMb` 都按 patch 生效）、**`ctx.gis.cache` 穿过 Cordis 的 Proxy 可用**、以及**产物真的落在配置目录里**。

## 六、🔴 真实实例抓到两个单测漏掉的点

**1. `clear()` 作为进程内第一个调用时，`freed` 报 0。**
`clear/begin/commit/abort/remove` 都没有等 `ready()`：索引还没建（`open` 是异步的），于是「释放了多少」按空索引算。单测没抓到，因为测试路径总是先经过 `resolve`/`put`（两者都 `await ready()`）——**冷路径只有真实进程的第一步会走**。
修法：所有变更操作在写链上先 `await this.ready()`（在链内，保证顺序）。回归测试：`reports what clear freed even when it is the first call in a fresh process`。

**2. 改完源码忘了 `pnpm build`，同一个 FAIL 又出现了一次。**
profile 里 `@znlgis/dsh-gis-core` 解析到的是 **`lib/index.js`（构建产物）**，不是 `src`。这既是提醒也是好事：**真实实例验证的正是用户拿到的东西**，但验证前必须重建——否则你验证的是上一次的代码。

## 七、诚实边界

1. **「一键清空」的 UI 入口没有做。** 配额已经可调：gis-core 行现在有 volatile 字段，宿主会自动为它发布设置命名空间并在 Plugins 页渲染表单（这条规则 M1b 已实测）。但清空目前只有两条路：`ctx.gis.cache.clear()`（API 就绪）或直接删目录 `<DSH_HOME>/cache/gis`（设计上支持）。卡片属于 M2/设置页的工作。
2. **没有 TTL。** TTL 是 OGC capabilities 的需求（T4.1），不是派生缓存的属性；届时在 `DerivedCache` 之上加或另做，不预先发明。
3. **两个进程共享同一棵树时索引互不可见**：另一个进程写的条目要等本进程下次 `open` 才可见（写成可删可重建的缓存，这个代价可接受）。当前一 profile 一进程，先记着。
4. **同一个 key 的并发生产者没有互斥**：`begin` 会清掉上一个 staging 文件。M2 里一个数据集一个转换任务，够用；已写进类注释。
5. **命中不重算内容哈希**：只 stat 存在性与大小。条目全部由本进程原子写入，外部篡改不在威胁模型内。
6. **缓存大小是索引口径**（`stats()` 同步返回）；还没 `open` 时它报 0。服务在激活时已预热，实际不会看到这个状态。

## 八、下一步

**M1a 的两笔欠账（T1a.2、T1a.10）至此清零**，M1a 可以按第八节的判据重新勾选。计划里的下一步是 **M2（浏览）**：

- T2.3 的 `/api/gis/blob?id=`：解析 id 必须走 `resolveFresh`（T1a.2）；
- T2.4 的 COG 后台任务：`begin`（先查配额）→ 转换写 staging → `commit`／取消则 `abort`（T1a.10 就是为它设计的 API 形状）。
