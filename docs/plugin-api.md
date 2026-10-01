# 插件 API 版本化（第三步）

本文件把《UI第三阶段》第五节的 1–5 条落地成文。**唯一事实源是代码**：`src/host/plugin-api.js`。
本文件解释它，不重复它 —— 若两者冲突，以代码为准，并应改本文件。

## 1. dsh 暴露 `dshPluginApiVersion`

host 半与 client 半**各自注册一个 Cordis 服务**，服务名就是 `dshPluginApiVersion`，值对象：

```js
{ current: 1, supported: [1], judge(declared) /* → 'ok' | 'deprecated' | 'unsupported' */ }
```

- `current` 是**本构建所说**的插件 API 版本（`PLUGIN_API_VERSION`）；
- `supported` 是本构建**能运行**的插件 API 版本集合（`SUPPORTED_PLUGIN_API`）；
- `judge(declared)` 给出判定，见第 3 节。

## 2. 同一大版本内向后兼容 —— 用**整数列表**，不用 semver

`SUPPORTED_PLUGIN_API = [1]`。**一个整数就是一个大版本**；这里没有 minor、没有 patch、没有范围语法。
一个 dsh 可以**同时支持多个大版本**（例如 `[1, 2]`），这正是"向后兼容"在插件侧的含义：
声明了 1 的包，在支持 `[1, 2]` 的 dsh 上照常运行。

- 判定**只看这个整数**：`SUPPORTED_PLUGIN_API.includes(declared)`；
- 不引入 semver 解析器，也不对 `pluginApiVersion` 使用范围语法；
- 客户端半保留一份**镜像常量**（两个 bundle 无法互相 import），并由套件的一致性断言钉住两份相等。

## 3. 破坏性变更：提前一个 minor 警告，到 major 才移除

`DEPRECATIONS` 是**硬编码**的排期表：

```js
[{ version: 1, deprecatedInDsh: '1.3.0', removedInDsh: '2.0.0' }]
```

`judge(declared, dshVersion)` 的规则（`dshVersion` 是**运行中**的 dsh 版本，由调用方注入）：

| 条件 | 结果 |
|---|---|
| `declared` 不在 `SUPPORTED_PLUGIN_API` | `unsupported` |
| `dshVersion >= removedInDsh` | `unsupported`（支持已移除）|
| `deprecatedInDsh <= dshVersion < removedInDsh` | `deprecated`（**警告窗口**：控制台警告 + 面板可标记）|
| 其余 | `ok` |

- 版本比较是**点分数字**比较（缺省段按 0），不引入外部库；
- `deprecated` **不是拒绝**：包仍可注册、仍可运行，只是**提前一个 minor** 被告知；
- `unsupported` **是拒绝**：客户端 `uiProjects.register()` 会拒绝一个**明确声明且不受支持**的版本。

## 4. 插件 manifest 声明 `pluginApiVersion`

```json
{ "dsh": { "uiProject": { "id": "…", "pluginApiVersion": 1 } } }
```

- host 侧：`pluginApiVersion` 是**必填**字段，缺失即校验失败；
- 客户端侧：**缺省放行**，只拒绝**明确声明且不受支持**的值 —— 这样在字段出现之前写的包不会一夜之间不可用；
- 两端共用同一判定（`judge` 与它的镜像/一致性断言）。

## 5. 兼容判断**只用一个字段**

`pluginApiVersion` **是唯一**参与判定的字段。

`dshVersionHint` **只是提示**：schema 明确标注它由安装流程读取、**校验器不比较它**
（`src/host/manifest-schema.js:78`），更新检查同样声明它不参与兼容判定
（`src/host/update-check.js:16`）。任何把 `dshVersionHint` 变成"第二个判定依据"的改动都是**回归**。

## 变更流程（作者视角）

1. **新增** API：在 `plugin-api.js` 里提升 `PLUGIN_API_VERSION`，并把新版本加入 `SUPPORTED_PLUGIN_API`
   （旧的保留，这就是向后兼容）；
2. **弃用** API：在 `DEPRECATIONS` 里加一行，`deprecatedInDsh` 设为**下一个 minor**，
   `removedInDsh` 设为**下一个 major**；
3. **移除** API：从 `SUPPORTED_PLUGIN_API` 移除该整数（`removedInDsh` 到期时），并保留 `DEPRECATIONS`
   条目作为历史记录；
4. 每一条都要有套件断言 —— 机制必须在破坏性变更**发生之前**就被测过。
