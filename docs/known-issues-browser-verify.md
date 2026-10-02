# browser-verify.mjs · 已知问题

**状态（2026-10-02）**：**挂起**。

`browser-verify.mjs` 首次运行于 2026-10-02（第 3 步 + C8 修复期间）。
当前 **8 红 / 不稳定 / 多触发源**。**不阻塞 P2**（皮肤包集合化）；
**开源前必修**。

---

## 稳定红 · 5 个（无波动）

### 4 × 例包未装 —— 环境
- `a role="dialog" surface from a third-party plugin is reached by the skin`
- `a role="custom-dialog" surface is NOT reached, and the difference is the role`
- `switching the skin off restores both surfaces, the body marker, and the frosted set`
- `a second project package takes over the skin role, one skin at a time`

**原因**：profile 里没装 `@xjl-resources/dsh-plugin-example`
与 `@xjl-resources/dsh-plugin-example-dialog`。

### 1 × first-frame —— 跨仓库
- `the first frame is already the skin, with the client bundle blocked`

**事实链**：
| 环节 | 位置 | 状态 |
|---|---|---|
| host 准备注入 `<script>` | `src/host/service.js:105-110` `markerRow()` | ✅ |
| 通过 `webserver/index-inject` 返回 | `src/host/service.js` | ✅ |
| dsh 框架把该脚本注入 HTML | **dsh 主框架** | ❓ 本仓库无法验证 |

**结论**：本仓库正确准备了注入内容；失败点在 dsh 框架层
（或该环境未启用 `webserver/index-inject` 服务）。

---

## 波动红 · 不稳定（多触发源）

**未定位的 flaky，待独立任务修。**

### 已修复（删除引入 · 1 个）
- `the modes that ask for less transparency get it`
- **根因**：被删的 `verification checklist` / `card reset` test 内部各有
  `await navigate(pageUrl)` + `await ensurePanel(session)`——作为隐式状态
  隔离点；删除后 modes 继承前一 test 的残留状态。
- **修法**：modes test 开头补回这两行（commit `c711690`）
- **验证**：连跑 5 次——5/5 ok

### 未定位（至少 3 个，多触发源）
- `the Settings › UI section opens from the sidebar`
- `the panel lists the registered project with a keyboard-accessible switch`
- `a mobile-sized viewport gets the reduced blur with no overflow`
- `turning the skin on really makes shipped surfaces glass`
  （连续多次运行未重启 dsh web 时偶发 `added 0`）

**观察到的触发模式**：
- **重启 dsh web 后** 仍可能红（推翻"未重启累积"假说）
- 连续跑多次后**新的 test 变红**——触发点不固定
- `N assertions` 在 99–121 之间波动

**待查明方向**（不预设）：
- UI 面板 slot 挂载的就绪延迟（test 跑得太早）
- viewports / theme / contrast emulation 的跨 test 残留
- dsh web 的浏览器 session / in-memory 状态

**修复路径（独立任务）**：
1. 逐 test 显式设置前置状态（不继承）
2. 或加 `--cold` 模式（每 test 前重启 dsh web——慢但稳）
3. 定位确切触发源后再决定

---

## 与本轮工作的关系

- **第 3 步（删 UI插件栏目）未引入任何稳定红点**
- **C8 菜单的 6 处 bug 是独立缺陷**——同一波工作（2026-09-30）遗留
- `modes` 的 flaky **是删除引入的**——已修
- 其余 flaky **未定位**——不属本次删除，但**开源前必修**