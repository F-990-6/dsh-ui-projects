# 已知限制：桌面应用里 host 半读不到本插件写入的设置文档

**状态**：客户端侧已兜底 —— 用户的选择**不再因重启而丢失**；仅"首帧标记"这一半仍需 shell 侧修复。
**适用**：DeepSeek Harness **桌面应用** `0.2.0-rc.2`（Electron 44，origin `dsh-app://app`）。
**不适用**：`dsh web`（浏览器）下的任何配置 —— 那里 host 与 client 读的是同一份设置文档，无此限制。

---

## 现象（2026-09-30 于桌面端实测）

1. 在「设置 → 界面」打开某个 UI 项目（实测用 `@fn-x/dsh-plugin-liquid-glass`）后，
   **同一次会话内立即生效**。
2. 客户端提交设置走 `ctx.remote.settings.update('ui-projects', patch, revision)`：
   **不抛错、不返回错误**，renderer 与 main 两侧日志都没有相关错误行。
3. `describe()` 正常返回（无超时、无错误），但返回的描述符列表里**没有**本命名空间的条目。
4. host 半在**首帧**读取设置（`ctx.get('settings').get('ui-projects')`）始终为空，于是：
   - `<body>` 上没有 `data-ui-project-<id>` 标记，`<html>` 上没有 `data-ui-skin`；
   - 本插件**无条件注入**的第一帧样式表（boot fragment）因此整体惰性 ——
     它的每一条选择器都带 `body[data-ui-project-<id>="on"]`，没有标记就一条都不生效；
   - 该标记由 host 半在 emit 时写入（`src/host/service.js` 的 marker 行）。
5. 重启应用后，设置页显示"已开启 0 项"。
6. 那次写入**没有**创建 `<harness home>/settings.yaml`；写后 15 分钟内该 home 下没有任何文件变化。
7. 该应用的 `localStorage` **可写且可持久**：同时存在 12 个第三方键，shell 自身也在写。

症状与"**renderer 的 `ctx.remote.settings` 与 main 的 `ctx.get('settings')` 不共享同一实例 /
provider / 文档**"一致。已按此上报 shell（见文末"上报要点"）。

**注意（诊断上的陷阱）**：会话内"立即生效"**不能**作为"写入成功"的证据 —— 适配器的
`write()` 先更新内存记录再提交，提交是否落盘不影响本次会话的表现。

---

## 客户端侧的兜底（已实现）

实现位于 `src/client/persist.js`：

- **写**：每一次写入（无论文档接受还是抛错）都镜像一份到浏览器自己的存储
  （键 `dsh.ui-projects.v1`）—— `withLocalCopy` / `mirrorToLocal`。
  文档写失败仍会照旧抛出，因此既有的可见错误横幅不受影响。
- **读**：`chooseRecord` 决定来源 ——
  - 文档**带了**我们的段 ⇒ **以文档为准**，**包括 `enabled: []`**（那是用户"明确关掉"，
    旧副本不得推翻）；
  - 文档**对我们沉默** ⇒ 用浏览器副本；
  - 两者都没有 ⇒ 空记录。
   "沉默"与"为空"必须分开：`coerce(undefined)` 会得到空记录，正是这两者被混淆的地方，
  因此远程适配器对"文档未提及本命名空间"如实上报 `undefined`（`src/client/settings-controller.js`）。
- **一次性回写**：仅当"文档沉默且有副本"时，尝试把副本写回文档**一次**（失败只记日志）。
- 结果：**用户的选择不再因重启而丢失**；重启后设置页显示"已开启 1 项"。

---

## 仍然存在的限制：首帧标记

host 半的标记只可能由它在 emit 时写出；host 读不到文档 ⇒ 首帧没有标记 ⇒
boot fragment 在首帧是惰性的，由 runtime 在启动后应用并自行打上标记（`runtime.js` 会写 body
标记）。

**实测（2026-09-30，桌面 0.2.0-rc.2）**：
- runtime 写 `liquid-glass` 标记于 `performance.now()` ≈ **6283.9 ms**，写 root 标记于 ≈ **6670.9 ms**；
  同一时刻（`t` ≈ **49750 ms**）读到的 `marker = "on"`、`skin = "liquid-glass"`。
- **项目标记早于 root 标记**：记录在 local 副本上**同步可用**，而文档读取仍在往返中
  （`withLocalCopy.read()` 先用副本作答 ⇒ 注册期的应用先发生）。
- 这两个数都**远晚于通常的首帧**（< 1 秒）。用户**未观察到可见的闪**。
- **机制解释（推断，非直接读数）**：页面加载本身慢（60+ bundle 加载），且 shell 的 boot page
  覆盖着主界面直到应用就绪 —— 本插件负责在 boot page 变陈旧时移除它，见 `src/client/index.js`
  的 `dismiss the boot page` effect 与 `src/client/runtime.js` 的 `dismissBootPage`（判据是
  `#root` 高出一屏，见同文件 `:36-37`）。即"无标记的那段时间"**可能**未暴露给用户。
- **局限**：`t` = 12.3 秒时读到的 `bootPageCount = 0`，但这**不能**证明 6.7 秒时 boot page 是否
  在场（DevTools 打开本身耗时 3–5 秒，已错过首帧窗口）。要直接读数需在页面启动前注入探针，不在
  本次范围。
- **不要**据此说成"runtime 在首帧附近应用" ✗。
- **host 首帧读不到**的硬证据不变：**修复前**多次读数（`t` ≈ 14 s）`marker` 都是 `null` ⇒ host
  **从未写过**标记（不是"写晚了"）。

**"两个写标记的人"（判断的关键）**：
- **host** 在 emit 时写（`src/host/service.js` 的 marker 行）⇒ 文档带着记录时，标记**首帧就在**；
- **runtime** 在应用项目时写（`src/client/runtime.js` 的 `#markProject` / `#markRoot`）⇒ 它在
  `start()` 的**异步链**上：`await persist.ready()`（`:262`）→ `#markRoot()`（`:265`）→
  `#applyWanted()`（`:267`、`:296`）→ `#enable()`（`:581`）。注意：**记录经 local 副本可同步答出**，
  所以项目标记完全可能早于 root 标记（实测即如此）。

**注**：若将来观察到闪，那就是本限制的表现 —— host 首帧读不到设置文档。

**如何判定（重启后各跑一次）**：

```js
// 重启后立刻
document.body.getAttribute('data-ui-project-<id>')
// 5 秒后再跑一次
document.body.getAttribute('data-ui-project-<id>')
```

| 读数时刻 `t` | 立刻 | 5 秒后 | 含义 |
|---|---|---|---|
| **t ≈ 0（真首帧，< 1 秒）** | `"on"` | `"on"` | host 首帧就读到了 ⇒ **本限制不存在**（shell 侧已修好或配置已变）|
| **t ≈ 0** | `null` | `"on"` | 限制存在，但 runtime 补得快 ⇒ 用户通常看不到闪 |
| **t ≈ 0** | `null` | `null` | 另有问题（runtime 未应用）⇒ 需要重新诊断 |
| **t ≫ 1 秒（如十几秒）** | 任意 | 任意 | **无法判定** —— runtime 可能早已应用；读数**必须**连 `performance.now()` 一起记录才有意义（实测两次即属此类：14262 / 39878 ms，两者都在 runtime 应用之后）|

host 首帧读不到**这件事**只能由 shell 修好 renderer 与 main 的设置指向来消除；而用户**是否看到
闪**还取决于页面加载速度与 boot page 覆盖（见上）。测量手段**已就位**：runtime 在写标记时记录
`performance.now()`（`markTiming`，每次页面加载经 `console.info` 打印一行 `markers written`），
事后用 DevTools 查询是测不出来的。

---

## 上报要点（已提交给 shell）

请确认 0.2.0 桌面端：

1. renderer 的 `ctx.remote.settings` 与 main 的 `ctx.get('settings')` 是否指向**同一**
   `settingsController` 实例、同一 provider、同一文档；
2. 活动文档的确切路径与存储后端是什么（yaml？`userData` 下的 json？LevelDB？）；
3. 是否存在"`update` 被接受但未落盘"的代码路径（例如以只读/内存 provider 挂载 settings，
   或 renderer 与 main 各自构造了一份 settings 服务）；
4. 若确为两处不共享：第三方插件应通过哪个入口读写设置，才能被 host 首帧读到。

只读扫描（app.asar 字符串）得到的旁证：`dsh-settings-file` 0 命中 ⇒ 桌面端未打包 yaml provider；
`settings.yaml` 的 16 处命中全在注释/文档文本中；`settings.json` 的 3 处命中均为 smithy 内部名；
`settingsController` / `remote.settings` / `settings/update` / `settings/describe` 均在且方法形状与
0.1.5 一致；`ipcMain` 42 处命中中无 settings 相关通道；`contextBridge` 暴露的全局中没有 settings；
文档明确 Desktop 用 `userData/keybindings.json` 存键位，与 harness home 相互独立。

---

## 复现与验证

1. 设置 → 界面 → 打开/关闭任一 UI 项目；
2. Console：`localStorage.getItem('dsh.ui-projects.v1')` ⇒ 能看到记录（兜底生效）；
3. 重启 ⇒ 设置页显示"已开启 1 项"，皮肤随 runtime 应用而恢复；
4. 想直接观察本限制：重启后**立刻**查 `document.body.getAttribute('data-ui-project-<id>')`
   ⇒ 在 runtime 应用之前它是 `null`（判据见上表）。

本策略与"沉默/为空"的判定规则由框架仓的测试覆盖：`scripts/verify.mjs`
（`chooseRecord` / `mirrorToLocal` / `shouldOfferBack` 三组断言）。
