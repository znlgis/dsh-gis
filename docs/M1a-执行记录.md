# M1a 执行记录（懂 + 用，无客户端代码）

> 本记录只写**实测**。未做的任务明确列出，不含糊。

## 一、交付物

| 包 | 内容 | 构建 |
|---|---|---|
| `@znlgis/dsh-gis-core` | 附录 C 数据模型、错误分类学、`ctx.gis` 服务、内容派生 id、Opener 接缝 | ✅ |
| `@znlgis/dsh-gis-formats` | 手写 WKT/EWKT、GeoJSON/NDJSON、DBF（编码可控）、SHP、`.prj` 解析 | ✅ |
| `@znlgis/dsh-gis-purejs` | Provider：文件 I/O + 缓存 + `where` 求值 + 分页 | ✅ |
| `@znlgis/dsh-tool-gis` | `gis_inspect` / `gis_query` / `gis_crs` / `gis_catalog` | ✅ |

任务对照：T1a.1 ✅、T1a.3 ✅、T1a.4 ✅、T1a.5 ✅、T1a.6 ✅、T1a.7 ✅、T1a.8 ✅、T1a.9 ✅（describe/transform）、T1a.11 ✅（系统提示词分节 + 2 个技能）、T1a.13 ✅（格式层 + Provider 层）。

任务对照补充：**T1a.12 ✅**（`gis_render` 服务端出图，见第七节）。

**未做**：T1a.2（`storageDomain` 持久化——目前是内存注册表）、T1a.10（派生缓存配额/LRU）。

## 二、M1a 退出判据：**全部达成**

测试 **27/27 通过**（`pnpm exec vitest run`）。三条「静默出错」的判据逐条实测：

| 判据 | 断言 | 结果 |
|---|---|---|
| 缺 `.prj` 的 SHP | `crs.source === 'unknown'`、`epsg` 为 undefined、issue 含 `CRS_UNKNOWN` 且文案声明拒绝测量 | ✅ |
| GBK 编码的 SHP | `.cpg` 生效，属性中文解出 **北京 / 上海 / 广州** | ✅ |
| 投影坐标的 GeoJSON | 报 `CRS_AMBIGUOUS` 且**带上原始范围** `[500000, 3400000]` | ✅ |

外加：无任何编码声明时报 `ENCODING_UNDECIDED`（不默认 UTF-8）、显式 `encoding` 可覆盖 `.cpg`、`.prj` 中的 `AUTHORITY["EPSG","3857"]` 被正确取出。

## 三、两个技术决策（与原设计的偏离，已论证）

### 1. SHP / DBF / WKT 三个读取器改为**手写**，不用 shpjs 与 @terraformer/wkt

原设计把 `shpjs` 列为纯 JS 的 SHP 读取器。实测后放弃，理由是**它能不满足退出判据**：

- `shpjs@6.2.0` **不带类型**（`types: null`），且不导出 `parseShp`/`parseDbf`；
- 其 DBF 解码**不接受编码参数**，而「GBK 属性正确」是硬判据——用一个不能控制编码的库去满足编码要求，是自相矛盾；
- `@terraformer/wkt` 的导出面无法确认。

手写的收益：`.cpg`/LDID/显式三段式编码解析完全可控、WKT 语义（**裸 WKT 不含 CRS**）不会被库的默认值污染、零不可控依赖。代价是代码量与 polygon ring 分组逻辑自担——已由测试覆盖。

**这是设计需要回写的一处**：附录里 shpjs / @terraformer/wkt 的选型应改为「自研，理由见 M1a」。

### 2. `where` 只实现诚实的子集，越界即拒

纯 JS Provider 无法诚实实现 SQL。实现了 `field OP value`（= != <> > >= < <=）用 AND/OR 平铺，以及 `field LIKE 'pat%'`；**遇到括号或任何其他语法直接抛错**，并在错误信息里说明支持什么。宁可拒绝，也不返回错的子集结果。

## 四、实测发现

**1. 多几何体的序列化必须给整个成员表再包一层括号。** 我第一版把 `MULTIPOINT`、`MULTILINESTRING`、`MULTIPOLYGON` 三个都写成了缺外层括号的形式（`MULTILINESTRING (0 0, 1 1), (2 2, 3 3)`），**那是无效 WKT**。往返测试逐个抓出来。这是同一个系统性错误的三处实例——只有往返断言能发现，单元断言「解析成功」是发现不了的。

**2. `issues` 数组不标注类型就会被收窄。** `const issues = [{code, message}]` 推导出 `{code: string; message: string}[]`，后续 push 带 `count` 的项直接编译失败。标注 `GisIssue[]` 即可。

**3. 内容型工具输出需要 `schema.type` 保持字面量。** `output.schema = { type: 'array', items: { type: 'json' } }` 不加 `as const` 会把 `type` 拓宽成 `string`，契约就认不出这是内容数组，`execute` 的返回类型退化为 `never`。另：`ContentBlock` 来自 **`@deepseek-ai/dsh-llm`**，不是 `dsh-tools`。

**4. 手写 fixture 生成器要自检。** GBK 字节是硬编码的，生成器**把解码结果打印出来**（北京/上海/广州），所以字节写错会当场暴露，而不是悄悄变成测试的期望值。

## 五、Cordis 装配：**已在真实实例中验证**

`dsh plugin --profile gisweb add` 装入全部 7 个包后起实例：

```
did-not-activate: false    failed-to-import: false    waiting-for-services: false
```

Plugins 页显示 **「共 5 个 · 5 运行中」**，五个行全部 `运行中`：

| 行 | 状态 |
|---|---|
| `gis-core` | 运行中 |
| `gis-purejs` | 运行中 |
| `tool-gis` | 运行中 |
| `prompt-gis` | 运行中 |
| `dsh-ui-gis` | 运行中 |

因为 `apply()` 里就是 `ctx.tools.register` / `ctx.skills.register` / `ctx.systemPrompt.section`，且这些调用若抛错会导致该行激活失败——**五个行全绿等价于「工具、技能、提示词分节都注册成功」**。

### 🔴 这一步抓到一个只有真实实例才会暴露的 bug

首轮启动直接报：

```
gis-purejs (@znlgis/dsh-gis-purejs): TypeError: Cannot read private member
  #handlers from an object whose class did not declare it
    at Proxy.registerHandler (gis-core/lib/index.js:116:13)
```

**根因：Cordis 通过 `Proxy` 分发服务，而 ECMAScript 私有字段（`#x`）不会穿过 Proxy。** 方法被代理调用时 `this` 是 Proxy，而 `#handlers` 声明在目标对象上，于是直接抛错。修法是把服务里的 `#private` 全部改成 TypeScript 的 `private`——后者编译期即擦除，运行时就是普通属性，能穿过 Proxy。

**这条没有任何单元测试能发现**：直接调用处理器时根本没有 Proxy。它只能在「装进 profile 起一次实例」时出现——正是设计里坚持要留 M0 门与真实实例验证的理由。已写进代码注释与设计约束。

同时确认了两个 API 细节：技能包名是 **`@deepseek-ai/dsh-skill`（单数）**，`dsh-skills` 不存在；`invocation` 不是字符串而是 `SkillInvocationPolicy` 对象 `{ modelInvocable, userInvocable }`。

## 六、诚实边界

- **工具未被真正调用过**：注册已证，但调用需要模型回合，而本机凭据库 `refs: {}`，无 `DEEPSEEK_API_KEY`（与 M0 的 T0.3 同一个环境边界）。
- 已注册数据集仅存于内存，进程重启即失效（T1a.2 未做）。
- T1a.10（缓存配额/LRU）未做：当前缓存无上界，靠 id 内含 mtime 保证不脏读。


---

## 七、T1a.12 服务端出图：**已完成并肉眼验证**

`gis_render` 已实现：解析数据集 → 取要素（GeoJSON 几何）→ 软件光栅化 → PNG → 落盘 → 返回路径。

**零新依赖**：PNG 编码器用手写实现（签名 + IHDR + IDAT + IEND，CRC-32 自建表，`node:zlib` 做 deflate）。光栅化器同样是手写：等距圆柱投影、**奇偶扫描线填充**、Bresenham 画线。

### 出图实测（`tests/fixtures/out/render-check.png`，800×520，5404 字节）

测试夹具包含：一个**带孔洞的多边形**、一个普通多边形、一条折线、两个点。渲染结果肉眼确认：

- 两个多边形各自填充（调色板循环取色），轮廓线清晰；
- **孔洞真的是空的**——蓝色多边形中央留白。这一条证明奇偶扫描线填充是对的：若用简单的「点在多边形内」或只填外环，孔洞会被涂满；
- 折线的每个折点都在位；两个点画成了圆点。

测试断言的是**结构**而不只是「文件生成了」：PNG 魔数、IHDR 中的宽高与请求一致、**颜色数多于 3 种**（背景 + 填充 + 轮廓 + 点，一张纯色图会被判失败）、以及孔洞中心像素**必须**等于背景色。

### 一处必须说明的设计限制

图像**不能**作为工具结果返回给模型。DSH 的 `ImageBlock` 要求一个 `attachment: ImageAttachmentRef`（由附件服务持有的持久引用），且其注释明确写着「current production adapters declare text-only output, so only user messages may carry images」。

所以 `gis_render` 的交付方式是**把 PNG 写到磁盘并返回路径**，由用户打开。这与设计里「PNG 出图 → `present`」的意图一致，但**不是**「把图直接给模型看」——那在当前的 provider 适配器下做不到，不应假装可行。

## 八、M1a 结论

**退出判据全部达成**：三条静默出错判据（缺 `.prj`、GBK 编码、投影坐标）+ 一次真实出图。

**测试 32/32 通过**（格式 16 + Provider 11 + 渲染 5），7 个包全部构建通过，Cordis 装配在真实实例中 5/5 行运行中。

**仍未做**（不阻塞 M1b）：T1a.2 数据集持久化、T1a.10 缓存配额。两者的影响都是「进程重启后已注册的数据集失效」与「缓存无上界」，属于工程质量而非能力缺失。

## 九、下一步

1. 在 `gisweb` profile 中确认 `gis_render` 可被调用（需模型凭据，本机没有）；
2. 进 **M1b**：GDAL / QGIS 探测 + `plugins.bundle.config` 设置卡片（需求 7 的正式载体）；
3. 视需要补 T1a.2 / T1a.10。
