# 发布一个 UI 插件包

本文只讲**发布**：怎么出 stable、怎么出 beta / canary、怎么回退。
版本号**怎么定**、`pluginApiVersion` 什么意思、破坏性变更怎么排期，见
[`plugin-api.md`](./plugin-api.md) —— 本文不重复定义那些规则，只说明何时按它们行动。

## 0. 先说清楚：dsh 不会替你发布

**`dsh` 不自动 `npm publish`。** 安装、更新、回滚都由**开发者手动执行命令**；这个插件系统能做的
只有三件事：把命令**打印**出来（面板里的"命令文本"按钮会复制它，**绝不执行**）、把版本**记录下来**、
把差异**报出来**。

同时，`dsh` 也不会替你 `git commit`、不会替你打 tag、不会在后台碰 npm。**发布是人的动作**，
本仓库的测试与套件都不会调用 `npm publish`（第五步的写入模块只写它自己那两个文件，且源码级断言
禁止它出现 `npm publish` 字样）。

## 1. 发布 stable

```powershell
# 1) 先确认工作区干净、测试全绿
git status --short
node scripts/build.mjs
node scripts/verify.mjs
node scripts/check-installed.test.mjs
node scripts/load-check.mjs
node scripts/host-check.mjs

# 2) 定版本并打 tag
npm version minor            # 或 patch / major —— 按 plugin-api.md 的排期决定
git push --follow-tags

# 3) 发布
npm publish
```

**发布之前先看 `package.json` 的 `version`。** 它就是 `judge(declared, dshVersion)` 里的 `dshVersion`
（见 `plugin-api.md` 第 3 节），所以它必须与 `DEPRECATIONS` 里的日期**同一量纲**：都是**本包自己的版本**，
不是 dsh 运行时的版本。

## 2. 发布 beta

```powershell
npm version prerelease --preid=beta     # 例如 0.2.0 → 0.2.1-beta.0
npm publish --tag beta
```

- `--tag beta` **只影响 npm 的 dist-tag**，不改 `package.json` 的 `version`；
- 用户在面板里把某个包切到 `beta`（`settings['<pkg>'].channel = 'beta'`），更新检查就会拿
  **`beta` 这个 dist-tag** 去比，命令里也**看得见**这个 tag：
  `dsh plugin --profile web add <pkg>@beta`；
- `beta` 上的包**同样**受 `pluginApiVersion` 约束 —— 预发布不是绕过兼容检查的理由。

## 3. 发布 canary

```powershell
npm version prerelease --preid=canary   # 例如 0.2.1-beta.0 → 0.2.1-canary.0
npm publish --tag canary
```

与 beta 完全同构，只有 tag 名不同（`stable` / `beta` / `canary` 三个名字是**唯一**的三个，
写在 `src/client/channels.js` 的 `CHANNELS` 里；写了别的名字，面板会**按名字拒绝**，
不会静默存成 `stable`）。

## 4. 回退一个版本

**两种回退，别混用。**

**① 回退 npm 的 dist-tag**（让新装的人拿到旧版；已装的人不动）：

```powershell
npm dist-tag add <pkg>@<旧版本> latest
npm dist-tag add <pkg>@<旧版本> beta      # 如果之前推的是 beta
```

**② 回退一台已经装了的机器**（让这台机器回到旧版）：

```powershell
install.ps1 -List                       # 先看有哪些快照
install.ps1 -Rollback -To <快照名>       # 把 lib/** 与 cordis.patch.yml 恢复到那个快照
```

- **回退前先 `-Snapshot`**：`install.ps1 -Snapshot` 会把当前运行版本记下来；
  没有快照就没有可回退的目标；
- **`package.json` 与 `CHANGELOG.md` 在快照里，但恢复时故意不还原** —— 回退的是**运行的代码**，
  不是发布元数据；这两个文件属于"你正在发布的新版本"，不该被旧版覆盖；
- 回退后**重启 dsh**（面板里的 `restartReminder` 那句说的就是这件事）。

## 5. 发布检查清单

1. `pluginApiVersion` 是否**仍然**是你能兑现的那个整数？（`plugin-api.js` 的 `SUPPORTED_PLUGIN_API`）
2. 有破坏性变更吗？有 ⇒ 先在 `DEPRECATIONS` 里排期（**提前一个 minor 警告，major 才移除**），
   再发布 —— 顺序反了就等于静默破坏；
3. 版本号与 `CHANGELOG.md` 的版本制小节是否一致？（设置 ▸ 插件里"写入 CHANGELOG 并更新版本"
   只会写这两个文件，**不会** commit、**不会** publish；而且它要求**十项测试清单全部确认**之后才肯写。）
4. 有没有把这个包切到 `beta` / `canary` 的用户？切了的人拿到的是**那个 tag**，不是 `latest`。

## 6. 谁负责什么

| 动作 | 谁做 | 说明 |
|---|---|---|
| 改版本号、写 CHANGELOG | 面板的开发者工具按钮（可选）+ 你复核 | 只写 `package.json` 与 `CHANGELOG.md`，永不 commit / publish |
| `git commit` / `git tag` / `git push` | **你** | 面板只给一句提示（`devToolsTagHint`），不读 tag、不执行命令 |
| `npm publish` | **你** | dsh **不会**自动发布 |
| `dsh plugin add/remove/update` | **你**（或复制面板给的命令文本） | 面板**只打印**命令 |
| `install.ps1 -Snapshot/-Rollback` | **你** | 见第 4 节 |
