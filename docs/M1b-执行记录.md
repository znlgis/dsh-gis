# M1b 执行记录（GDAL/QGIS 探测 + 设置）

> 只写实测。未做的明确列出。

## 一、环境实况

```
gdalinfo     -> C:\OSGeo4W\bin\gdalinfo.exe
ogrinfo      -> C:\OSGeo4W\bin\ogrinfo.exe
ogr2ogr      -> C:\OSGeo4W\bin\ogr2ogr.exe
qgis_process -> NOT FOUND
```

GDAL 已装在 OSGeo4W 下，QGIS 未装。**这恰好同时提供两条验证路径**：探测成功的路径，与「工具不存在时优雅降级」的路径——后者是设计明确要求的，不是意外。

## 二、交付物：`@znlgis/dsh-gis-gdal`

| 模块 | 内容 |
|---|---|
| `exec.ts` | 执行接缝：`ctx.sandbox.confine(argv, policy)` → `ctx.subprocess.spawn(...)`，argv 永不经过 shell |
| `detect.ts` | 探测与结果解释，区分「不存在」「存在但跑不起来」「超时」 |
| `index.ts` | `ctx.gisRuntime` 服务：Config（路径 + 环境变量）、`buildEnv`、`run`、`detect` |

设置项（`.volatile()` 可热改）：`gdalBinDir`、`qgisBinDir`、`extraEnv`（每行 `KEY=VALUE`）、`timeoutMs`。

## 三、需求 7 的机制：**已在测试中断言**

需求 7 是「不配系统环境变量也能调用 GDAL/QGIS」。这个承诺在 `buildEnv` 里兑现，因此直接对它断言：

| 断言 | 为什么重要 |
|---|---|
| 配置的 GDAL 目录排在 PATH **最前** | 否则会被已有的系统安装盖过，用户改了设置却不生效 |
| 环境 PATH 保留在**其后** | **前置是特性，替换就是回归**——替换会悄悄弄坏无关工具 |
| GDAL 排在 QGIS 之前 | 两者带同名可执行文件时行为可预测 |
| `extraEnv` 生效（`GDAL_DATA`/`PROJ_LIB`），注释与畸形行被忽略 | 这正是「不必系统级设置 GDAL_DATA/PROJ_LIB」的落点 |
| 无任何贡献时**不设** PATH | 不用空串污染子进程环境 |

另有 4 条针对探测解释：版本行 → 可用；`exitCode != 0` → 不可用并**带上工具原话**；超时 → 报「超时」而**不是**报「不存在」；探测 argv 恒为数组而非 shell 字符串。

## 四、运行时装配：**已在真实实例中验证**

装入 profile 后启动：**`did-not-activate: false`、`failed-to-import: false`、`waiting-for-services: false`、无任何错误行**。

这验证了三件编译期看似成立、只有运行时才作数的事：

1. **`static Config` + `constructor(ctx, config)` 的类形式可用**——schema 被 Loader 接受并注入；
2. **`sandbox` 与 `subprocess` 两个 inject 都得到满足**；
3. **`SubprocessSpawnSpec` 的严格契约被满足**——该接缝「不施加任何默认值」。

## 五、实测发现

**1. `ctx.subprocess` 的 stdio 必须逐流显式声明。** 规范注释原文：「this seam applies no defaults: every disposition, limit, and directory is explicit」。`stdio` 不是字符串而是对象 `{ stdin, stdout, stderr }`，且 `stdin` 无默认值——第一版写 `stdio: 'pipe'` 直接编译失败。

**2. 句柄的等待动词是 `done`，不是 `wait()`。** 提供 `done: Promise<SubprocessOutcome>` 与 `waitForExit`。用 `'pipe'` 时原始流归调用方，必须**在等待 `done` 的同时并发排空**，否则可能死锁。

**3. 服务类型需要 `import type {} from '<声明它的包>'`。** 与客户端插槽、`ctx.systemPrompt`、`ctx.skills` 完全同一模式。**这条规律已在四个不同服务上重复出现**，值得单独立为约束。

## 六、诚实边界（M1b 未完成的部分）

1. **设置卡片 UI 尚未建立**——schema、持久化机制（M0 已验证：写进 profile 的 `cordis.patch.yml` 且重启保留）、`ctx.gisRuntime` 都已就绪，缺的是那张表单；
2. **GDAL Provider 未实现**：尚未把 `ogrinfo` 的 JSON 映射为 `InspectResult`，也没有 `ogr2ogr` 转换；
3. **GDB 只读支持未做**；
4. **探测从未在真实会话里跑过**——`detect()` 需要一次工具调用，而本机无模型凭据。**因此「GDAL 3.x 被成功探测到」这句话我还没有实测过**，只能说机制已被单元测试覆盖、服务已在实例中激活。

## 七、整体状态

**8 个包全部构建通过，测试 41/41 通过，6 个 Loader 行在真实实例中全部运行中。**

| 里程碑 | 状态 |
|---|---|
| M0 | ✅ 条件放行（T0.3 因无凭据未调用） |
| M1a | ✅ 退出判据全部达成 |
| M1b | 🔶 执行接缝 / 探测 / 设置 schema / 运行时装配完成并验证；设置卡片 UI 与 GDAL Provider 未做 |

## 八、下一步

1. **设置卡片**（`plugins.bundle.config`，key = `@znlgis/dsh-gis-gdal`；取数方式 M0 已踩通：`ctx.configForms.get('dsh-gis-gdal')`）；
2. **GDAL Provider**：`ogrinfo -al -so -json` → `InspectResult`，`ogr2ogr` → 转换；
3. 两者完成后，需求 7 才真正端到端可用。
---

## 九、设置卡片：已实现，**UI 验证未完成**

`GisGdalCard` 已写入 `ui-gis` 客户端半：`gdalBinDir` / `qgisBinDir` / `extraEnv`（多行）/ `timeoutMs` 四个字段，只提交用户真正改过的项，`timeoutMs` 做数字转换，状态区分「已保存 / 宿主拒绝 / 未接受写入 / 有未保存改动」。构建通过，客户端仍只有**一个**懒 chunk（未引入同步 require 的共享 chunk）。

### 🔴 座位判断：`plugins.row.config`，不是 `plugins.bundle.config`

第一版我把卡片注册进 `plugins.bundle.config`（key = `@znlgis/dsh-gis-gdal`）。实测发现 **Plugins 页根本没有这个包**——因为它没有 `dsh.bundle` 声明，**它不是 bundle，而是 `@znlgis/dsh-gis` bundle 里的一个 row**。

`plugins.bundle.config` 按 **bundle 的包名**做 key，永远不会为 row 查询；row 的配置属于 **`plugins.row.config`**，按 **row id** 做 key（`PluginManagerPage.tsx:500` 也正是**只有这个槽**由页面注入 `form`，`:584` 的 bundle 槽从不注入）。已改为 `plugins.row.config` key = `gis-gdal`（与 patch 里的 `- id: gis-gdal` 一致）并构建通过。

**但这条修正只有源码依据，没有 UI 实测依据。** 我用 Playwright 打开 `@znlgis/dsh-gis` 的详情页后：`CARD_ON_BUNDLE_PAGE false`、能找到 `gis-gdal` 文本（`ROW_MATCHES 1`）但**定位不到该行的 configure 按钮**（`ROW_BUTTONS 0`，选择器取错了层级），profile patch 里也没有任何 gdal 条目。**因此「设置卡片可用」这句话我还没有实测过。**

### 仍未做

- **GDAL Provider**（`ogrinfo -j` → `InspectResult`，`ogr2ogr` 转换）；
- **GDB 只读**；
- `detect()` 的真实调用（需要模型凭据）。
### 🔴 真正的座位 id：`include:<rowId>`

第二轮定位到根因，**不是宿主的问题，是我的**。用 `li[data-plugin-row]` 精确枚举后：

```
ROWS [{"id":"include:gis-core","hasButton":true}, {"id":"include:gis-gdal","hasButton":true},
      {"id":"include:gis-purejs",...}, {"id":"include:tool-gis",...},
      {"id":"include:prompt-gis",...}, {"id":"include:dsh-ui-gis",...}]
```

**六个 row 全部 `hasButton: true`**——配置入口对每一行都渲染了，宿主的 config ledger **确实**收录了我们的行。我上一轮报的 `ROW_BUTTONS 0` 是我的选择器用了 `gis-gdal`，而真实 entry id 是 **`include:gis-gdal`**（bundle patch 插入的行带 `include:` 前缀）。

`PluginManagerPage.tsx:1162` 的判据也印证了这一点：`has: row => ledger.rows.has(rowConfigKey(pkg.name, row.rowId))`——按钮渲染即代表 ledger 有条目。

**已修**：`ENTRY_ID` 改为 `include:gis-gdal`，并保留 `gis-gdal` 作为回退。构建通过。

**但最终 UI 闭环仍未完成**：修正选择器后重跑时，我的脚本改写没生效（正则转义写错），实例 token 也已丢失，因此**「卡片能渲染、能保存、能落进 profile patch」这条链仍然没有端到端实测**。已修的是代码与 id 判断，未证的是运行结果。

**这条发现的普适性**：M0 时 bundle 级配置用的 id 是 `dsh-gis`（无前缀），而 bundle patch 插入的行是 `include:<rowId>`。**同一个 `plugins.bundle.config` / `plugins.row.config` 契约下，entry id 的拼写取决于行是怎么来的**——文档里没有写，只能从运行时或 DOM 反查。
### ❌ 卡片无法到达：`configure.has(row)` 为 false（宿主侧缺口）

把脚本修正到能精确枚举后，拿到了决定性证据：

```
BUTTON_COUNT 1
BTN0 aria="启用组件 @znlgis/dsh-gis-gdal"      <- 这是启用开关，不是配置按钮
MARKED ["SECTION|config", "LI|include:gis-core", "LI|include:gis-gdal", ...]
HEAD  ... "@znlgis/dsh-gis / dsh-gis / probeLabel / Save / unavailable"
      ... "共 6 个 · 5 运行中 · 1 已停用"
```

`gis-gdal` 那一行**只有一个按钮，是启用开关**。按 `PluginManagerPage.tsx:245`，配置按钮仅在 `configure?.has(row) === true` 时渲染，而 `has` 是 `ledger.rows.has(rowConfigKey(pkg.name, row.rowId))`（`:1162`）。**没有配置按钮 ⇒ 宿主的 config ledger 里没有这一行。**

**我上一轮把 `hasButton: true` 读成了「配置入口存在」——错了。** 每一行至少有启用开关，所以那个布尔值几乎恒为真，不构成证据。这是本轮我自己的一个误读，已在上一节记下并在此更正。

另外两条同批观测：

- **`dsh-gis` bundle 卡片的状态从 M0 的 `ready` 变成了 `unavailable`**——即宿主现在不接受写入。这与「1 已停用」可能同源，需要单独查。
- 六个 row 里 **有 1 个处于停用状态**。

### 因此卡片的真实状态

**代码在位、座位判断已修正到有源码依据（slot key = `row.rowId`，configForms 命名空间 = `entryId`），但宿主根本不提供进入这一行的配置入口，所以卡片无法被渲染、也从未被渲染过。**

要打通它，下一步不是改客户端，而是**查清 bundle patch 插入的 row 为何没有进入 config ledger**——即宿主侧「一个 row 的配置如何被发现」这条链。我上一轮的座位推理（`plugins.row.config` 而非 `plugins.bundle.config`）仍然可能正确，但**在 affordance 出现之前无法证实**。
---

## 十、闭环结果：卡片**已能渲染**，写入被宿主拒绝

读到宿主的 ledger 源码后，根因彻底清楚：

```ts
export function rowConfigKey(bundle: string, rowId: string): string {
  return `${bundle}#${rowId}`
}
// ledger.rows 就是「插件注册进 plugins.row.config 的 key 集合」
const keysOf = name => new Set(ctx.slots.entries(name).flatMap(e => e.options.key ?? []))
```

**ledger 完全由客户端槽注册驱动，与宿主的 settings 服务无关。** key 错 ⇒ 页面连「配置」按钮都不渲染——这正是我前两轮看到的 `hasButton` 只有启用开关的原因。

### 一个 row 牵涉**三个不同的 id**，混淆任意两个都静默失败

| 用途 | 值 |
|---|---|
| `plugins.row.config` 槽 key | `@znlgis/dsh-gis#gis-gdal` ← `` `${bundle}#${rowId}` `` |
| `ctx.configForms.get()` 命名空间 | `include:gis-gdal` ← Loader entry id |
| `li[data-plugin-row]` | `include:gis-gdal` ← 同一个 entry id |

改成 `@znlgis/dsh-gis#gis-gdal` 后实测：

```
ROW_BUTTONS 2
  btn0 "配置 @znlgis/dsh-gis-gdal"        <- 配置入口出现了
  btn1 "启用组件 @znlgis/dsh-gis-gdal"
CONFIGURE_BTN 1
CARD {"found":true,"status":"in sync"}    <- 卡片渲染了，且表单可取（editable=true）
STATUS "the host refused the change"
PATCH_HAS_OSGEO false
```

**已证实**：配置入口渲染、卡片渲染、`ctx.configForms.get('include:gis-gdal')` 取到可写表单（`status` 显示 `in sync` 而非 `unavailable`，说明 `writable === true`）。

**未打通**：`form.mutate()` 返回 false，宿主拒绝了写入，profile patch 里没有值。

**最可疑的一条**：我把 `snapshot?.revision` 作为 `expectedRevision` 传入。若该字段为 `undefined`（首次读取尚未拿到宿主视图），写入会被版本栅栏拒绝。下一轮应先打印 `snapshot.revision` 与 `snapshot.status` 再决定修法。

另一条待查：`dsh-gis` bundle 卡片的 `unavailable` 是否与本次拒绝同源。

### 三轮的总教训

同一个槽契约下有三套 id，且**没有一处文档写明**。三轮里我依次猜了 `gis-gdal`（两次）和 `include:gis-gdal`，都是**静默失败**——没有异常、没有日志，只是入口不出现。**只有读渲染该槽的那几行源码 + 在运行时反查 DOM，才能定下来。** 这与 M0 的「bundle config 不传 form」、M1a 的「Proxy 吞掉 `#private`」是同一类：**类型正确 ≠ 运行时寻址正确**。
---

## 十一、定论：**不是 id 拼写问题，是宿主不提供该命名空间**

把 snapshot 的真实内容渲染进 DOM 后读到：

```
DIAG {found:true, rev:"undefined", writable:"true", mode:"host",
      status:"unavailable", user:"none", ns:"none", gdal:""}
```

随后让卡片**依次探测三个候选命名空间**（`include:gis-gdal` / `gis-gdal` / `@znlgis/dsh-gis#gis-gdal`），以 `getSnapshot().status === 'ready'` 为唯一判据：

```
ns: "none"      <- 三个全都不被宿主提供
```

**所以问题从来不是 id 拼写。宿主根本没有为这一行提供设置命名空间**，表单因此是 `unavailable`（按 `ConfigFormSnapshot` 的文档：命名空间未暴露给该客户端），`revision` 为 undefined、`user` 为 none，一切写入必然被拒。

### 一条必须追查的回归

**`dsh-gis` bundle 卡片在 M0 实测中是 `ready`（并正确显示 schema 默认值 `dsh-gis probe`），现在也变成了 `unavailable`。** 同一个 profile、同一个机制，从可用变成了不可用。这不是我的卡片造成的——是两个 bundle 的命名空间**同时**消失。

### 三轮追溯的收获与代价

| 已证实 | 未解决 |
|---|---|
| 配置入口的 slot key 是 `` `${bundle}#${rowId}` ``，改对后**配置按钮出现**、**卡片成功渲染** | 宿主不为该行提供设置命名空间，写入无法进行 |
| `ctx.configForms.get()` 对错误命名空间**返回一个看起来正常的表单**，只有 `status` 能分辨 | `dsh-gis` 命名空间从 `ready` 退化为 `unavailable` 的原因 |

**最重要的方法论收获**：`ctx.configForms.get()` 对不存在的命名空间**不报错、不返回 undefined**，而是返回一个 status 为 `unavailable` 的表单。**任何「取到表单就算成功」的判断都是错的**——必须检查 `getSnapshot().status`。我的卡片现在就是这么做的，并把这个探测固化在代码里。

### 下一步（唯一一条）

在宿主侧查 `config-editor` / `settings` 为何不再为我们的行发布命名空间：

1. 起实例后在宿主日志或调试接口取 `ctx.configForms.describe()` 的 namespace 列表，确认我们的行是否在其中；
2. 对比 M0 时的状态——**M0 明明可以**，说明是某个变更导致的，而不是机制不成立；
3. 顺带确认「1 已停用」的是哪一行、是否相关。

**在命名空间被提供之前，设置卡片无法写入，需求 7 的 UI 链路仍然不闭环。** 这一点不再有模糊空间。
---

## 十二、宿主侧的发布规则（已从源码定位）

`packages/settings/settings/src/index.ts:302-340` 的 `describe()` 决定了「谁有设置命名空间」：

```ts
const descriptors = configEditor.configuration().flatMap(({ entry, inherited, override }) => {
  const schema = this.schema(entry)                       // entry.fiber?.runtime?.Config
  if (schema === undefined || entry.fiber === undefined
    || entry.fiber.runtime === null
    || entry.fiber.state !== FiberState.ACTIVE) return []
  const form = volatileForm(schema)
  if (form === undefined) return []                       // 无 volatile 字段 ⇒ 不发布
  return [{ ns: entry.options.id, ... }]                  // 命名空间 = entry id
})
```

**一个条目要拿到设置命名空间，必须同时满足四条**：

1. `configEditor.configuration()` 收录了它；
2. `entry.fiber.runtime.Config` 存在且带 `toJSON`（即导出了 Schemastery schema）；
3. `volatileForm(schema)` 有值——**至少一个 `.volatile()` 字段**；
4. `entry.fiber.state === ACTIVE` 且 `runtime !== null`。

命名空间就是 **`entry.options.id`**，没有别的前缀规则。

### 对本项目的推断

`gis-gdal` 的第 2、3 条**看起来是满足的**（模块同时导出了命名 `Config` 与 `class ... { static Config }`，且四个字段都带 `.volatile()`）。因此失败**最可能在条件 1 或 4**。

而条件 4 有一条直接相关的现场观测：先前 dump 出的 **「共 6 个 · 5 运行中 · 1 已停用」——六个行里有一个不是 ACTIVE**。若被停用的正是 `gis-gdal`，则它必然拿不到命名空间，与 `status: unavailable` 完全吻合。

### 下一步（具体到可执行）

1. 在实例里确认**被停用的是哪一行**（`li[data-plugin-row]` 上的 `data-state="off"`），以及它为何被停用；
2. 若 `gis-gdal` 处于停用状态，**启用它**再看命名空间是否出现；
3. 若它本来就是 ACTIVE，则查 `configEditor.configuration()` 是否收录了 bundle patch 插入的条目。

### 本轮的净结果

**从「不知道为什么不工作」推进到「四条充分必要条件中的哪一条不满足」**——这是可判定的，不再是猜测。同时排除了一整类错误方向：**问题与三个 id 的拼写无关**（三个候选全部 `unavailable`，且源码证明命名空间就是 `entry.options.id`，没有 `#` 或 `include:` 的换算规则）。

我前四轮在 id 拼写上反复试错，方向从一开始就是错的；真正该先读的是 `describe()` 这 40 行。
---

## 十三、✅ 闭环完成：设置卡片端到端可用

### 根因：**那一行被停用了**

```
ROW_STATES [{"id":"include:gis-core",  "state":"on",  "hasConfig":false},
            {"id":"include:gis-gdal",  "state":"off", "hasConfig":true},   <- 唯一停用、也是唯一有配置按钮
            {"id":"include:gis-purejs","state":"on",  "hasConfig":false},
            {"id":"include:tool-gis",  "state":"on",  "hasConfig":false},
            {"id":"include:prompt-gis","state":"on",  "hasConfig":false},
            {"id":"include:dsh-ui-gis","state":"on",  "hasConfig":false}]
```

`gis-gdal` 是**唯一处于停用状态**的行，恰好命中 `describe()` 的**条件 4**（`entry.fiber.state !== ACTIVE`）——**停用的行没有设置命名空间**。启用后立刻：

```
DIAG {"ns":"gis-gdal","status":"ready","rev":"0"}
```

**命名空间就是 `gis-gdal`**，即 `entry.options.id`，与源码读出的规则完全一致。

### 端到端实测结果

填三个字段并保存：

```
STATUS     "...saved; restart to apply to new runs"
PATCH_LINES ["- id: gis-gdal",
             "    gdalBinDir: C:\\OSGeo4W\\bin",
             "    qgisBinDir: C:\\Program Files\\QGIS 3.40.0\\bin",
             "    extraEnv: GDAL_DATA=C:\\OSGeo4W\\share\\gdal"]
```

**写入成功，三个值全部落进 profile 的 `cordis.patch.yml`。** 需求 7 的 UI 链路至此闭环。

### 四个 id / 状态的最终对照（全部实测确定）

| 用途 | 值 |
|---|---|
| `plugins.row.config` 槽 key | `@znlgis/dsh-gis#gis-gdal` = `` `${bundle}#${rowId}` `` |
| `ctx.configForms.get()` 命名空间 | `gis-gdal` = **`entry.options.id`** |
| `li[data-plugin-row]` | `include:gis-gdal`（DOM 属性，非命名空间） |
| 前提 | 该行必须**处于启用状态**，否则命名空间不存在 |

### 本轮最贵的一课

**「行被停用」这个状态完全没有报错、没有日志，症状是「表单存在但 status 为 unavailable」。** 我在客户端上为此改了三轮 id 拼写，而真正的原因是一个 checkbox。

判定顺序本该是：**先看行的启用状态 → 再看命名空间列表 → 最后才是 id 拼写。** 我把顺序做反了。

另一条已固化的防御：`ctx.configForms.get()` 对不存在的命名空间**返回一个看似正常的对象**，只有 `getSnapshot().status` 能分辨。卡片现在会依次探测候选命名空间并以 `ready` 为准，避免同类静默失败。
---

## 十四、GDAL Provider（本轮新增）

| 件 | 内容 |
|---|---|
| `handler.ts` | `ogrinfo -json -so -al` → `InspectResult`；要素读取走 `ogr2ogr -f GeoJSON /vsistdout/`，再交给**已测试的** GeoJSON 读取器 |
| `.gdb` opener | 目录形式的文件地理数据库（纯 JS 层完全不能读） |
| `gis_doctor` 工具 | 终于让探测结果可被模型使用：GDAL/QGIS 版本或不可用原因 + 子进程实际拿到的 PATH |

**GDAL 补上的正是手写层的短板**：实测 `ogrinfo -j` 在 `coordinateSystem.projjson.id.code` 里**直接给出 EPSG 码 4326**，而我的手写 `.prj` 解析器只能靠名字猜、猜不到就承认解析不了。同时 `metadata.SHAPEFILE` 给出 `LDID_VALUE` / `CPG_VALUE` / `SOURCE_ENCODING`，与自研的三段式编码解析互为印证。

### 🔴 实测发现：类形式插件必须用 `static inject`

把 `ctx.gis` 的使用放进构造函数后立刻报：

```
gis-gdal: Error: cannot get property "gis" without inject
    at new GisRuntimeService (gis-gdal/lib/index.js:294:7)
```

**根因：类形式的插件，Cordis 从类本身读取注入列表；模块级的 `export const inject` 被静默忽略。** 而之前没暴露，是因为 `ctx.sandbox` / `ctx.subprocess` 只在方法里访问——**方法调用发生在激活之后，那时注入已经就绪，于是错误被掩盖了**。只有构造期访问才触发。

改法：`static readonly inject = [...]`。

**这条的普适性**：同一份代码里，函数形式用 `export const inject`（正确），类形式必须用 `static inject`。**两种形式不能互换，且失败是静默的**——直到你在错误的时机访问服务。

### 验证状态

- ✅ 构建通过；`gis-gdal` 带着 handler / opener / doctor 工具**激活无错**（`did-not-activate: false`，注入全部满足）
- ❌ **`ogrinfo` 从未通过工具真实执行过**——`gis_doctor` 与 `gdb` 的 inspect 都需要一次工具调用，而本机无模型凭据（与 M0/T0.3 同一环境边界）
- ❌ **`.gdb` handler 未经真实文件地理数据库测试**——本机没有该格式的样本；`ogrinfo` 的输出映射是按真实 JSON 结构写的，但只对 shapefile 验证过结构

### M1b 收尾

| 件 | 状态 |
|---|---|
| 执行接缝 / 探测 / 设置 schema / 运行时装配 | ✅ 已验证 |
| 设置卡片端到端（含落盘） | ✅ 已验证 |
| GDAL handler + `.gdb` opener + `gis_doctor` | 🔶 构建与激活已验证；**执行未验证** |
| GDB 真实样本测试 | ❌ 无样本 |
---

## 十五、✅ 真实 GDAL 验证（不需要模型凭据）

我原本以为这一块必须等凭据。**漏想了一层**：handler 的唯一运行时依赖是 `runtime.run`，把它做成结构化类型后，用一个直接 spawn 真实二进制的 runner 就能驱动**整条映射链**——argv、JSON 结构、CRS 解析、编码元数据、要素路径——不需要 Cordis，也不需要模型。

先把 handler 的依赖从服务类改为结构化接口 `GdalRuntime`（这本身也是更好的设计：**映射逻辑不该被 Cordis 上下文挡在测试之外**）。

### 样本是**生成**的，不是手写的

本机没有 `.gdb`。用 `ogr2ogr -f OpenFileGDB` 从 `cities-gbk.shp` 生成了一个**真正的 Esri 文件地理数据库**（本机 GDAL 3.13.3），而不是伪造一个长得像的结构。

### 实测结果（`packages/gis-gdal/tests/gdal.spec.ts`）

| 断言 | 结果 |
|---|---|
| 文件地理数据库的 CRS 解析出**真实 EPSG 码** | ✅ `epsg: 4326`，`source: 'native'` |
| 报告 GDAL 实际使用的**改名后图层名** | ✅ `cities_gbk`（ogr2ogr 曾警告把 `cities-gbk` 归一化） |
| 经 `ogr2ogr` 读要素并解出 GBK 中文 | ✅ 北京 / 上海 / 广州 |
| 几何经**共享的** GeoJSON 读取器转 WKT | ✅ `POINT (...)` |
| 不存在的图层要报错而非静默返回空 | ✅ |

**「CRS 解析出真实 EPSG 码」这条正是 GDAL Provider 存在的理由**——手写 `.prj` 解析器只能靠名字猜，而 GDAL 直接从 `projjson.id` 给出答案。

### 🔴 测试抓到一个真实缺陷

shapefile 那条一开始失败：

```
ogrinfo failed: ERROR 4: cities-gbk.shp: No such file or directory
```

**根因：我把 `dataset.title` 当路径传给了 GDAL。** 而 `title` 是**显示名**——对 shapefile 就是裸文件名，GDAL 于是拿它去工作目录里找。修法是新增 `targetOf(dataset)`，按 kind 取 `dir` / `main` / `path`，并对无法寻址的 kind 抛错。

**这个 bug 在生产路径上不会触发**（handler 只声明 `kinds: ['gdb']`），但它是真实缺陷：`title` 是给人看的，永远不该进 argv。**只有拿真实文件跑才会暴露**——mock 会把 `title` 原样返回，测试照样通过。

### 验证边界的更新

| 项 | 之前 | 现在 |
|---|---|---|
| `ogrinfo` / `ogr2ogr` 真实执行 | ❌ 未执行 | ✅ **真实执行并断言** |
| `.gdb` 样本 | ❌ 无样本 | ✅ 生成并测试 |
| GDAL → InspectResult 映射 | ❌ 未验证 | ✅ 5 条断言 |
| 工具调用路径（模型 → 工具 → handler） | ❌ | ❌ **仍需凭据**（但激活已验、env 构造已单测） |
| `gis_doctor` 的工具调用 | ❌ | ❌ **仍需凭据**（其 `buildEnv` / `interpretProbe` 已单测） |

**测试 47 通过 + 1 跳过**（跳过的是「本机无 GDAL」分支，因本机有 GDAL 而正确跳过）。
