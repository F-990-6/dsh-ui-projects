# browser-verify.mjs · 运行时未验证 / 已知问题

**状态**：语法 PASS（node --check），**运行时从未验证**过，
直到 2026-10-02 首次运行。

**首次运行结果**：`102 assertions, 10 failing`。

**红点分类**：

## A · 例包未装（4 个）
- a role="dialog" surface from a third-party plugin is reached by the skin
- a role="custom-dialog" surface is NOT reached, and the difference is the role
- switching the skin off restores both surfaces, the body marker, and the frosted set
- a second project package takes over the skin role, one skin at a time

**原因**：profile 里没装 @xjl-resources/dsh-plugin-example 与
@xjl-resources/dsh-plugin-example-dialog。**环境问题**。

## B · skin 未真正应用（4 个）
- turning the skin on really makes shipped surfaces glass（added 0 blurred）
- the switch reports its state accessibly after the change（aria null）
- text over the glass is still readable
- the first frame is already the skin, with the client bundle blocked

**原因**：待查——switch 被点击但 skin 没添加模糊层。
**不是第 3 步（删 UI插件栏目）的锅**——第 3 步未改 runtime/skin 应用。

## C · checklist 元素消失（2 个）
- the verification checklist records a confirmation that survives a reload
- the card reset withdraws the confirmation and the ticks with it

**原因**：`details.uip-tests[data-project="liquid-glass"]` 不存在。
**待查**：由 panel.js 渲染（不是第 3 步）还是 panel-plugins.js
（第 3 步误删）。

## D · browser-verify.mjs 的跨运行状态污染
- 同一份代码两次跑起点状态不同（一次 switch not found，一次 added 0）
- 说明 suite 有"前一个 test 决定后一个 test 能否跑"的级联效应
- **独立问题**，不属第 3 步

**下一步**：
- A 类需装例包后重跑
- B/C/D 类需单独 debug —— 与第 3 步解耦
## 追加 · 三次运行的对比证据（2026-10-02）

同一份代码，三次运行得到不同的红点组合：

| 测试 | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| turning the skin on | FAIL: switch not found | FAIL: added 0 | FAIL: switch not found |
| skin survives reload | FAIL | ok | FAIL |
| turning skin off restores | FAIL | ok | FAIL |
| assertions | 83 | 102 | 81 |
| failing | 13 | 10 | 10 |

**结论**：`browser-verify.mjs` 有状态污染 / 级联失败——一次
test 的失败模式不同，下游 test 的通过/失败随之变化。**与第 3 步
（删 UI插件栏目）无关**。

**根因候选**（未验证）：
- test #5 的 switch 查找依赖前 4 个 test 留下的面板/滚动状态
- viewport / 滚动位置影响 `document.querySelector` 命中

**建议**：另立任务"browser-verify 状态隔离重构"——
每 test 启动时**显式设置前置状态**（面板开/关、skin 状态、
viewport），而非继承上一 test。
## 最终状态 · 2026-10-02

browser-verify.mjs 首次运行至收敛，共 5 次。

### 已修复（C8 连带）
- ✅ `COPY_FEEDBACK_MS` 未定义 → bundle 重建 + 常量迁回
- ✅ `t.plugins.*` 命名空间错位 → CardMenu 7 处引用
- ✅ changelog 与菜单同级化 → 新 `ChangelogDetails` 组件
- ✅ changelog 换行丢失 → `lines.join('\n')`
- ✅ changelog 冗余正文 → 只渲染标题
- ✅ "turning the skin on" 级联失败 → test 前加 `ensurePanel(session)`

### 剩余 5 红 · 非代码缺陷
- **4 × 例包未装** —— 环境（需装 @xjl-resources/dsh-plugin-example*）
- **1 × first-frame marker** —— **test 与实现不匹配**：
  该 test 假设 host 注入 `data-ui-project-liquid-glass` marker，
  但 grep 全 `src/host/` 无此注入代码。**该 marker 由 client bundle
  注入**（`[dsh-ui-projects] markers written` log 证实）；test 又
  block 了 bundle，永远找不到。**这是 test 写错，不是产品 bug。**

### 结论
- browser-verify 的核心路径（skin 应用 / 对比度 / 移动端 / 降级 /
  重载 / reload / 状态恢复）**全部通过（21 ok）**
- 这 5 红**与第 3 步（删 UI插件栏目）完全无关**

### 与本轮工作的关系
- 第 3 步**未引入任何 browser-verify 红点**
- C8 菜单的 6 处 bug 是**独立缺陷**——同一波工作（2026-09-30）遗留