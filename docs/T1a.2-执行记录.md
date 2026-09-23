# T1a.2 执行记录（数据集登记：storageDomain + id 派生 + 404 语义）

> 只写实测。未做的明确列出。

## 一、任务与判据

计划原文（实施计划 T1a.2）：

| 产出物 | 完成判定 |
|---|---|
| `storageDomain` 定义 + id 派生 + 404 语义（设计 6.6） | 同一数据重复扫描得同一 id；源变更得新 id；未知 id 返回结构化 404 |

计划给的起步资料已经指明缺口：**id 派生与 `DATASET_NOT_FOUND` 都已存在并有测试，缺的只是把注册表落进 storage 并跨进程恢复**；并提示两个坑——`open()` 异步且域名单次占用、`storageDomain` 不能进 `static inject`（否则没挂 storage 的 profile 里整行不激活）。

## 二、交付物

| 文件 | 职责 |
|---|---|
| `packages/gis-core/src/registry-domain.ts`（新） | 域 `gis` / 表 `datasets` 的声明、记录 schema（zod）、`Dataset` ⇄ 记录的双向映射 |
| `packages/gis-core/src/registry.ts`（新） | `DatasetRegistry`：内存表 + 可选持久表，水合 / 落盘 / 淘汰 |
| `packages/gis-core/src/dataset-source.ts`（新） | `sourcePathOf(dataset)`：按 kind 取源路径（**顺带收口运行时契约第 15 条**：`title` 永远不进 argv） |
| `packages/gis-core/src/index.ts`（改） | `[Service.init]` 里用 `ctx.inject(['storageDomain'])` 挂可选持久化；`registerDataset` 变 async；新增 `resolveFresh`；`inspect`/`query` 走 `resolveFresh` |
| `packages/gis-core/tests/registry.spec.ts`（新） | 12 条测试，跑**真实** `dsh-storage` + `dsh-storage-json` + `dsh-storage-domain` |
| `packages/gis-purejs/src/io.ts`（改） | shapefile 家族成员把 **size/mtime** 编进身份（见第五节） |
| `packages/gis-purejs/tests/family-id.spec.ts`（新） | 只改 `.dbf` 也必须换 id |
| `scripts/t1a2-real-instance.mjs` + `scripts/t1a2-probe.mjs`（新） | 可重跑的真实实例验证：真 `dsh --profile gisweb` 启动三次 |

## 三、四个设计决定

1. **持久化是可选依赖，不是硬依赖。** 类插件的 `static inject` 是硬依赖，服务不来就永久 `waiting-for-services`；用 `ctx.inject(['storageDomain'], cb)` + 回调内 `ctx.effect` —— 服务出现即打开域、消失即关闭。**没挂 storage 的 profile 里，GIS 全部功能照常，只是 id 不跨进程。**
2. **域用 `per-record` + `backup-and-skip`。** 数据集是可重建的派生登记：一条记录坏掉不该让整个目录打不开；删一个数据集也不该重写整个单元。记录键会被当成路径片段，而 `ds_<hex>` 本来就安全。
3. **解析即校验（`resolveFresh`）。** id 是「路径 + size + mtime + 家族成员」的哈希，所以**只在源没变时才有资格被服务**。源变了就把记录（内存与介质）一起淘汰，回**与未知 id 相同的结构化 404**。不这样做的话，旧 id 会安静地读出**不同的字节**——正是本项目列为阻断级的静默错误。反过来，**读不到源（被占用、权限、网络）不算「变了」**：那只是无法证明，记录保留，让读取按自己的错误码大声失败。
4. **依赖声明与设计 §95 有一处偏差**：`@deepseek-ai/dsh-storage-domain` 放在 `dependencies`（该条原则是 peer + dev）。理由：它在这里的用法是**纯函数 `defineDomain` + 纯对象 spec**，不涉及服务单实例；而 peer 一旦在某个 profile 里解析不到，就是 `failed-to-import`，整个插件连内存回退都没有。跨实例风险已消除——错误判定按 `code` 而不是 `instanceof`（两份模块实例会让 `instanceof` 恒为 false）。

## 四、实测：单元测试（真实存储栈，无需凭据）

`pnpm test` → **60 通过 + 1 跳过**（T1a.2 之前是 47 + 1；本任务新增 12 + 1 条）。

`packages/gis-core/tests/registry.spec.ts` 的 12 条覆盖：

| 断言 | 结果 |
|---|---|
| 同一文件重复扫描 → 同一 id；内容变了 → 新 id | ✅ |
| 每个数据集写出 `<root>/gis/datasets/<id>.json`，内容是 `{version, record}` | ✅ |
| **重启**（新 `Context`、新服务实例、同一份介质）后按 id 解析出**同一个 dataset 对象** | ✅ |
| 源变更后旧 id → `GisError{code:'DATASET_NOT_FOUND'}`，并从内存与介质同时消失 | ✅ |
| 未知 id → 同一个结构化 404（`resolve` 与 `resolveFresh` 都是） | ✅ |
| 源被删除 → 判为过期 | ✅ |
| 源**只是读不到**（`EBUSY`）→ 保留，不误杀 | ✅ |
| 没有任何存储时插件照常激活（`persistence === 'memory'`），不落盘 | ✅ |
| **HMR**：dispose 后域名单释放（`facility.get('gis') === undefined`），重载后仍是 storage 支撑 | ✅ |
| 四种 dataset 形状的介质往返相等 + 畸形记录被 schema 拒绝 | ✅ |
| `sourcePathOf` 按 kind 取路径，连接类返回 undefined | ✅ |

## 五、过程中修掉的一个真缺陷（id 派生）

写「源变了吗」这条判定时发现：**shapefile 的 id 只把家族成员的「文件名」编进哈希**，成员自身的 size/mtime 没进去。后果是——改 `.dbf`（属性）、改 `.prj`（坐标系）、改 `.cpg`（编码）都**不换 id**，而 id 的整个承诺就是「内容变了就换 id」。换 CRS 却保持同一个 id，回放出来的卡片会拿旧 id 读新字节。

修法：家族成员的每个条目改为 `名字@size:mtime`（`deriveDatasetId` 的 `members` 本就是不透明字符串表，排序后参与哈希）。新增 `packages/gis-purejs/tests/family-id.spec.ts`：同一族重复扫描 id 不变；只给 `.dbf` 追加一个字节 → id 必须变。

> 这条测试当场又抓到我自己引入的一个回归：`siblings` 一度变成了成员对象数组而不是路径数组（类型约束在 vitest 里不生效）。**断言「兄弟文件名没变、只有统计量变了」才算把这条修对。**

## 六、实测：真实实例（不需要模型凭据）

`node scripts/t1a2-real-instance.mjs` —— 真 `dsh --profile gisweb` 启动 **3 次**，每次注入同一个探针插件；介质被 `--patch` 改到临时目录（**绝不碰 `~/.dsh/storages`**），`webserver` 行禁用（**绝不碰 3080**）：

```
[1/3] boot A -- open the fixture, derive the id
  probe: {"phase":"open","id":"ds_72a97746b02881a2","kind":"geojson","title":"points.geojson","persistence":"storage"}
  PASS  boot A opened the fixture through the real ctx.gis
  PASS  ids are durable in this profile (persistence=storage)
  PASS  the profile wrote a per-record document: .../storages/gis/datasets/ds_72a97746b02881a2.json
  document: { "version": 1, "record": { "id": "ds_72a97746b02881a2", "title": "points.geojson",
              "layers": [ { "name": "points" } ], "kind": "geojson", "path": "...\data\points.geojson" } }

[2/3] boot B -- a second process resolves that id from storage alone
  probe: {"phase":"resolve","resolved":"points.geojson","fresh":true,"persistence":"storage","listed":["ds_72a97746b02881a2"]}
  PASS  boot B resolved the id in a process that never opened the file
  PASS  the stored id still matches the bytes on disk
  PASS  boot B is storage-backed too

[3/3] boot C -- edit the source; the old id must 404
  probe: {"phase":"stale","code":"DATASET_NOT_FOUND","newId":"ds_940fd13b7fc1b0c7","changed":true,"listed":["ds_940fd13b7fc1b0c7"]}
  PASS  the edited source derives a NEW id for the same path
  PASS  the old id answers with DATASET_NOT_FOUND (got DATASET_NOT_FOUND)
  PASS  the dropped id left the catalog

ALL REAL-INSTANCE CHECKS PASSED
```

这段证明的是单测证不了的三件事：

1. **Cordis Loader 在真 profile 里把我们的行装起来了**——探针拿到的 `ctx.gis` 是真服务，不是测试里手搓的；
2. **可选注入绑上了 `dsh-base` 三层之前挂的 storage**（`persistence: 'storage'`），而不是悄悄退回内存；
3. **id 真的跨进程存活**：boot B 是另一个进程，它只是读了介质。

**启动审计的旁证**：三次启动的 `startup-*.log` 里，失败/挂起的 9 条 entry 全是 web 运行时与客户端行（因为我把 `webserver` 禁了），**`gis-core` / `gis-gdal` / `gis-purejs` / `tool-gis` / `prompt-gis` / `dsh-ui-gis` 一条都没出现**——即六行全部激活。

> 探针第一版是失败的：它在 `apply` 里直接 `ctx.gis.open()`，而 `ctx.gis` 在 `gis-core` 激活时就有了、那时 `gis-purejs` 还没注册 opener、域也还没打开。**这不是插件缺陷，是探针没有等待异步启动**——真实工具调用永远发生在启动之后。探针改成「等 `persistence === 'storage'`、等 opener 认领路径」后才稳定。这条已写进运行时契约第 19 条的注脚：可选依赖让服务**早于**提供者出现，谁在激活期就动手，谁就得自己等。

## 七、诚实边界

1. **`.gdb` 的 id 仍只由路径派生**（gis-gdal 的 opener：`deriveDatasetId({ path, kind: 'gdb' })`），所以目录内容变化不会换 id，`resolveFresh` 对它永远判「fresh」。**这是 M3/T3.5 的议题**：目录指纹要对全量成员做扫描，成本与语义都属于那一站。当前不假装它能变。
2. **连接类（PostGIS）不参与新鲜度判定**——按设计 6.6 第 4 条，它的 id 由「剖面名 + 图层」派生，没有本地源可比。
3. **`resolve()` 不校验**（同步、零 I/O），校验在 `resolveFresh()`（`inspect` / `query` 走它）。因此 `gis_catalog` 可能**短暂列出**一个已过期的 id，首次读取即淘汰。**没有做「按路径清扫」**：同一路径 + 同一 kind 可能被不同 provider 以不同身份基准登记，按路径删会误删合法记录；用真 opener 校验后再删才是安全的，而那条路已经由 `resolveFresh` 覆盖。
4. **T1a.10（派生缓存配额 + LRU）仍未做**——计划里与 T1a.2 相邻，但它是缓存不是登记，本任务不碰。
5. **探针的等待**意味着这次验证不能证明「零等待下也正确」——它证明的是「启动完成后正确」，而那正是模型/浏览器看到的状态。

## 八、下一步

1. **T1a.10（缓存配额 + LRU）**——M1a 的最后一块欠账，做完 M1a 才算真正清零；
2. 之后按计划进入 **M2**（浏览）；M2 开工前先读 `docs/运行时契约.md`（现在是 **20 条**，新增的 18–20 全是存储域与可选依赖，正是 M2 的 T2.3 `/api/gis/blob?id=` 直接要用的：**路由解析 id 必须走 `resolveFresh`**，否则回放会把「已变的文件」当旧 id 的字节发出去）。
