# 兼容性：`pluginApiVersion` 与三种情况

本文讲**兼容判定**：一个插件声明什么、dsh 怎么判、以及三种"版本不一致"的情况下各自发生什么。

**规则本身只有一个事实源：`src/host/plugin-api.js`。** 当前版本、支持集、弃用排期与判定函数都在那里；
[`plugin-api.md`](./plugin-api.md) 是它的说明书（服务形态、整数列表的含义、变更流程）。本文**不重复**那些定义，
只把它们对应到**你会在界面上看到什么、以及为什么**。

## 1. 插件怎么声明

在 `package.json` 的 `dsh.uiProject` 里写一个**整数**：

```json
{
  "dsh": {
    "uiProject": {
      "id": "my-skin",
      "pluginApiVersion": 1
    }
  }
}
```

- **整数，不是范围、不是 `^1.0.0`、不是字符串。** 一个整数**就是**一个大版本（`plugin-api.js` 的
  `SUPPORTED_PLUGIN_API` 是 `[1]`，也可以同时是 `[1, 2]`）；
- host 侧：该字段**必填**。缺了它，manifest 校验直接失败（`src/host/manifest-schema.js`）；
- 客户端侧：**缺省放行**，只拒绝**明确声明且不受支持**的值 —— 这样在字段出现之前写的包不会一夜之间不可用
  （`src/client/service.js` 的 `validate()`，理由写在该函数的注释里）；
- 两端用的是**同一判定**：客户端保留一份镜像常量，套件有一条断言钉住两份**逐项相等**。

## 2. 判定：`ok` / `deprecated` / `unsupported`

`judge(declared, dshVersion)` 只回答三个词（`src/host/plugin-api.js`）：

| 判定 | 含义 | 后果 |
|---|---|---|
| `ok` | 支持，且不在弃用窗口内 | 正常注册、正常运行 |
| `deprecated` | **支持**，但已排期移除，且警告窗口已打开 | **仍可注册、仍可运行**；只是**提前一个 minor** 被告知 |
| `unsupported` | 从未支持过，或移除版本已到 | **拒绝**注册 —— 面板上标记为不兼容，且**不可启用** |

`dshVersion` 指的是**框架包自己的版本**（`package.json` 的 `version`），不是 dsh 运行时的版本 ——
因为 `SUPPORTED_PLUGIN_API` 与 `DEPRECATIONS` 描述的都是**框架包的发布节奏**
（`src/host/own-version.js` 负责读它，读一次并缓存）。

## 3. 破坏性变更怎么排期

**提前一个 minor 警告，到 major 才移除。** 排期表是 `plugin-api.js` 的 `DEPRECATIONS`：

```js
[{ version: 1, deprecatedInDsh: '0.2.0', removedInDsh: '1.0.0' }]
```

- `dshVersion >= removedInDsh` ⇒ `unsupported`（支持已移除）；
- `deprecatedInDsh <= dshVersion < removedInDsh` ⇒ `deprecated`（**警告窗口**）；
- 其余 ⇒ `ok`。

**一个字段判定，`dshVersionHint` 不参与。** `dshVersionHint` 只是提示：schema 明确标注它由安装流程读取、
**校验器不比较它**（`src/host/manifest-schema.js:78`），更新检查也声明它不参与兼容判定
（`src/host/update-check.js:16`）。任何让它变成"第二个判定依据"的改动都是**回归**。

## 4. 兼容矩阵：三种情况

### 情况 ①：dsh 新版 + 插件旧版

**要标记，并且不可启用。**

- 扫描为每一行产出 **`uiProject.compat`**（`src/host/profile-scan.js` 的 `uiProjectSubset`），取值
  `ok` / `unsupported` / `unknown`；端点**原样透传**，不重新解释；
- 面板在行上给出**独立**的属性 `data-uip-api-version`（与 UI Contract 的 `data-uip-contract` 分开 ——
  两个问题，两个答案），并在不兼容时用 locale 表里的句子作 `title`；
- **不可启用**落在**注册**这一步：`uiProjects.register()` 的 `validate()` 会**抛错拒绝**一个明确声明且不受支持的
  版本，并把这次拒绝**记进 `refusals()`**（那是面板渲染的数据）。**拒绝是门控，不是变灰的按钮。**

### 情况 ②：dsh 旧版 + 插件新版

**安装前就拒绝，并说清怎么办。**

- 校验发生在 dsh 加载包的时候（`install.ps1` 本身不校验 `pluginApiVersion`，它走 `dsh plugin …`）；
- 拒绝文案（`src/host/manifest-schema.js`）：`pluginApiVersion N is not supported; upgrade dsh to a version
  that supports pluginApiVersion N, or install a build for <支持集>` —— **既说失败，也说两条出路**；
- 弃用窗口内的包**不**走这条：它拿到的是 `deprecated` 的文案（"仍然能跑，但 dsh 将在 X 移除它"）。

### 情况 ③：dsh 升级之后

**列出来，并且给出两条可执行的路 + 一句建议。**

在设置 ▸ 插件的行折叠区里，`UpgradeCheck` 会为**声明了本构建跑不了的 API 版本**的包列一份清单，每行给：

1. **更新**：一条**命令文本**（`dsh plugin --profile <p> add <pkg>@<tag>`）—— 打印、可复制、**绝不执行**；
2. **禁用**：① 界面页里把这个包的**项目**关掉（这是本插件**真能**做的事）② 给出
   `dsh plugin --profile <p> remove <pkg>` 的**命令文本** —— **不假装能禁用包**，卸包是加载器的职责；
3. **暂缓升级 dsh**：**只出文字**。没有任何按钮能回滚一个宿主，所以这里也不给按钮。

## 5. 你怎么知道自己踩了哪一条

| 你看到的 | 情况 | 该做什么 |
|---|---|---|
| 行上的标记说"本 dsh 跑不了" | ① | 按包声明的整数重建，或让用户升级 dsh |
| 安装时被拒，文案让你升级 dsh | ② | 升级 dsh，或把包降到受支持的整数 |
| 升级后出现一份清单 | ③ | 更新那个包，或先把它关掉；暂缓升级 dsh 也可以 |
| 控制台/面板说某版本"将被移除" | 弃用窗口 | **仍有时间**：在 `removedInDsh` 之前重建 |

## 6. 相关文件

- `src/host/plugin-api.js` —— **唯一事实源**（版本、支持集、排期、`judge`）
- `src/host/own-version.js` —— 读框架包自己的版本（host-only）
- `src/host/manifest-schema.js` / `src/host/conformance.js` —— 安装期校验与 `unsupported-plugin-api` 问题码
- `src/client/service.js` —— 客户端注册期的拒绝（`validate()`）与 `refusals()`
- `src/host/profile-scan.js` / `src/host/installed-endpoint.js` / `src/client/panel-plugins.js` —— 从扫描到行上的标记
- `docs/plugin-api.md` —— 规则本身与变更流程；`docs/plugin-publishing.md` —— 怎么发布与回滚
