/**
 * Copy for the Settings › UI section, in the two locales the shipped Web client
 * speaks. The plugin does not register a locale namespace: it reads the active
 * locale id and picks a dictionary, so it works in any composition and in any
 * third language (falling back to English).
 */

export const STRINGS = {
  en: {
    sectionLabel: 'UI',
    title: 'UI',
    intro: 'Manage interface appearance projects for dsh. Turn them on or off at any time.',
    skinHint: 'A skin replaces the whole look of dsh. Turning one on turns the others off.',
    activeCount: (n) => `${n} active`,
    storage: { settings: 'Saved with your dsh settings', local: 'Saved in this browser' },
    accessibility: 'Accessibility',
    badges: { skin: 'Skin', enhancement: 'Enhancement' },
    scopes: { global: 'Global', layout: 'Layout', component: 'Component' },
    supports: { light: 'Light', dark: 'Dark', mobile: 'Mobile' },
    /*
     * The card badge names the tier in force FOR THE PAGE, not the project's own declaration: when
     * a weak device has demoted the skin, showing "high" beside a visibly cheaper material would
     * read as a bug. `perfLevel` on the project is what the panel compares against, so the badge
     * can say which of the two it is showing.
     */
    perf: { low: 'Performance: reduced', medium: 'Performance: balanced', high: 'Performance: full' },
    perfDemoted: (names, tier) => `${names} is running at "${tier}" because this device reported less capacity.`,
    persistError: (message) => `Your last change could not be saved: ${message}`,
    /*
     * The maintenance block on a project's card. It names the PACKAGE for the same reason the column
     * does: the command maintains the package that owns the project, and today the framework and the
     * built-in skin are one package.
     */
    maintenanceTitle: (name) => `Maintaining the ${name} package (printed, not run)`,
    maintenanceHint: 'These act on the package that owns this project, not on the project itself.',
    maintenanceBadge: 'maintenance commands (printed) · a recorded version differs',
    maintenanceSnapshot: 'install.ps1 -Snapshot',
    maintenanceUpdate: 'install.ps1 -Update',
    maintenanceRollback: 'install.ps1 -Rollback -To <name>',
    snapshotNewer: (name, version, when) => `The newest snapshot is ${name} (package v${version}, ${when}); it matches what is installed.`,
    snapshotDifferent: (name, version, current) => `The newest snapshot is ${name} (package v${version}); ${current} is installed. The two differ, so the recorded version is not the running one.`,
    snapshotNone: 'No version snapshot has been recorded yet; -Snapshot is what makes a rollback possible.',
    snapshotHostStale: 'Snapshot information needs a dsh web restart before this page can show it (the host code is newer than the running process).',
    pluginsLabel: 'UI plugins',
    plugins: {
      title: 'UI plugins',
      intro: 'What is installed in this profile, and the commands that would change it. Nothing here writes: dsh profiles are changed by install.ps1, run by you.',
      loading: 'Reading the profile…',
      failed: (reason) => `Cannot read the installed-package listing: ${reason}`,
      failedHint: 'The host may be older than this client, or the connection service may be absent in this composition. The UI projects above are unaffected.',
      refresh: 'Read again',
      empty: 'No packages are installed in this profile.',
      composed: 'composed',
      notComposed: 'not composed',
      framework: 'framework',
      project: (id) => `project id: ${id}`,
      orphaned: (names) => `${names} declares a bundle but is missing from dsh.profile.bundles: installed, not composed, so nothing it injects ever runs.`,
      commandsHint: 'To remove it, run this in PowerShell:',
      restartHint: 'The command alone does not take effect: the running dsh still holds the old composition. After it finishes, stop dsh web (Ctrl+C) and start it again.',
      restartBlock: '# 1. in PowerShell\ndsh plugin --profile web remove dsh-ui-projects\n\n# 2. stop dsh web (Ctrl+C), then start it again',
      /*
       * The three answers a person needs before pasting a removal command: what goes on its own, what
       * the command does, and what is deliberately left alone. The third list is the one nothing else
       * in the interface can supply — it is where the two decisions about user data are stated (the
       * switch survives, and so does the settings entry) — and somebody about to delete a package is
       * exactly who needs to read them.
       */
      uninstall: {
        title: 'What removing it changes, and what it does not',
        automaticTitle: 'Removed for you, on the next load',
        automatic: [
          'its entry in the UI project registry: the card above goes with it',
          'the stylesheets it injected, and its own <style> element',
          'the data attributes it set on <body>, plus data-ui-projects when nothing is left',
          'the CSS variables it declared inside its own scope',
          'its own storage keys — no package has one today, and the suite keeps it that way',
          'every listener, timer and observer it registered',
        ],
        commandTitle: 'Done by the command above',
        command: [
          'the package directory in the profile, and the symlink that points at the source',
          'its row in dsh.profile.bundles',
        ],
        keptTitle: 'Not touched, on purpose',
        kept: [
          'your switch for it: reinstall while it was on, and it comes back on',
          "its settings, including a recorded verification — your data, not the package's cache",
          "every other package's settings: this removes one package, not the profile",
          'the source tree at E:\\dsh\\plugins\\<package>\\, which the command never deletes',
          'the version snapshots under .dsh-ui-projects-versions\\, which are what make a rollback possible',
        ],
      },
      maintenanceTitle: (name) => `Maintaining the ${name} package (printed, not run)`,
      maintenanceHint: 'These commands act on the PACKAGE, not on a project or a page: they rebuild, record or restore the package that owns this row.',
      cmdSnapshotWhy: 'Make the version that is running now restorable:',
      cmdUpdateWhy: 'After you bring a new version (git pull && npm run build), record what is there:',
      cmdRollbackWhy: 'Restore a recorded version (a name comes from the snapshot list):',
      cmdRollbackList: 'To see every restorable name: install.ps1 -Rollback -List',
      noSnapshots: 'No version snapshots recorded yet; -Snapshot is what makes a rollback possible.',
      snapshotNames: (count) => `${count} recorded version(s)`,
      restartReminder: 'All of these need dsh web stopped first (Ctrl+C), and started again afterwards.',
      kinds: { 'ui-project': 'UI project', bundle: 'bundle', library: 'library', 'plugin-with-client': 'plugin', unresolved: 'not installed' },
    },
    priority: (value) => `Priority ${value}`,
    orderHint: (name) => `${name} is running ahead of a higher-priority project; the order is restored on the next load.`,
    regions: {
      sidebar: 'sidebar',
      center: 'center column',
      rightbar: 'right panel',
      overlay: 'overlay layer',
      composer: 'composer',
      dialogs: 'dialogs',
      tokens: 'design tokens',
      background: 'background',
    },
    regionShared: (names, regions) => `${names.join(' and ')} both declare the ${regions.join(', ')}; they may conflict.`,
    regionNested: (names, regions) =>
      `${names.join(' and ')} both apply blur to the ${regions.join(', ')}, so one layer may end up inside the other.`,
    regionSharedHere: (other, regions) => `Shares the ${regions} with ${other}.`,
    regionNestedHere: (other, regions) => `Both blur the ${regions} with ${other}; one layer may nest inside the other.`,
    tests: {
      summary: (count) => `Verification checklist (${count})`,
      markPassed: 'Mark as passed',
      withdraw: 'Withdraw confirmation',
      passed: (version) => `Confirmed for v${version}.`,
      stale: (version) => `Confirmed for v${version}; this version needs confirming again.`,
      incomplete: (version) => `Confirmed for v${version}, but the checklist changed since; confirm it again.`,
    },
    status: { active: 'On', inactive: 'Off', error: 'Failed', unavailable: 'Unavailable' },
    toggleOn: (name) => `Turn on ${name}`,
    toggleOff: (name) => `Turn off ${name}`,
    resetOne: (name) => `Reset ${name} to its default`,
    resetAll: 'Restore default UI',
    resetAllHint: 'Turns off every UI project and returns dsh to its shipped interface.',
    replacedBy: (names) => `Replaces ${names}`,
    errorLabel: 'Last error',
    versionLabel: 'Version',
    previewAlt: (name) => `${name} preview`,
    /** Control copy, keyed by a project's `labelKey`. The page renders whatever keys a
     * project declares, so a new control is a key here plus a declaration there. */
    controls: {
      opacity: 'Transparency',
      unit: '%',
      opacityMore: 'Transparent',
      opacityLess: 'Tinted',
    },
    empty: 'No UI projects are registered.',
    emptyHint: 'Install a UI project plugin to see it here.',
  },
  zh: {
    sectionLabel: '界面',
    title: '界面',
    intro: '管理 dsh 的界面外观项目，可随时开启或关闭。',
    skinHint: '皮肤会整体替换 dsh 的外观；开启一个皮肤会自动关闭其他皮肤。',
    activeCount: (n) => `已开启 ${n} 项`,
    storage: { settings: '随 dsh 设置一起保存', local: '保存在此浏览器中' },
    accessibility: '无障碍',
    badges: { skin: '皮肤', enhancement: '增强' },
    scopes: { global: '全局', layout: '布局', component: '组件' },
    supports: { light: '浅色', dark: '深色', mobile: '移动端' },
    perf: { low: '性能：已降低', medium: '性能：均衡', high: '性能：完整' },
    perfDemoted: (names, tier) => `${names} 正以“${tier}”运行——此设备报告的能力较低。`,
    persistError: (message) => `最后一次修改没能保存：${message}`,
    /*
     * 项目卡片上的维护块。与列表一样把**包**写出来：命令维护的是拥有这个项目的包，
     * 而今天框架包与内建皮肤包是同一个包。
     */
    maintenanceTitle: (name) => `维护 ${name} 包（只打印，不执行）`,
    maintenanceHint: '这些命令作用于拥有本项目的包，而不是项目本身。',
    maintenanceBadge: '维护命令（只打印）· 有未记录的快照',
    maintenanceSnapshot: 'install.ps1 -Snapshot',
    maintenanceUpdate: 'install.ps1 -Update',
    maintenanceRollback: 'install.ps1 -Rollback -To <name>',
    snapshotNewer: (name, version, when) => `最新快照是 ${name}（包 v${version}，${when}）；与当前安装的一致。`,
    snapshotDifferent: (name, version, current) => `最新快照是 ${name}（包 v${version}）；当前安装的是 ${current}。两者不同，说明记录下来的版本并不是正在运行的那个。`,
    snapshotNone: '还没有记录任何快照；跑一次 -Snapshot 才能回滚。',
    snapshotHostStale: '快照信息需要重启 dsh web 之后才能在这个页面显示（host 代码比运行中的进程新）。',
    pluginsLabel: 'UI 插件',
    plugins: {
      title: 'UI 插件',
      intro: '本 profile 里装了什么，以及要改它需要跑什么命令。这里不会写入任何东西：dsh profile 由 install.ps1 修改，由你手动执行。',
      loading: '正在读取 profile…',
      failed: (reason) => `无法读取已安装插件清单：${reason}`,
      failedHint: '可能是宿主版本比客户端旧，或本组合里没有 connection 服务。上方的 UI 项目不受影响。',
      refresh: '重新读取',
      empty: '这个 profile 里没有装任何包。',
      composed: '已合成',
      notComposed: '未合成',
      framework: '框架',
      project: (id) => `项目 id：${id}`,
      orphaned: (names) => `${names} 声明了 bundle 却不在 dsh.profile.bundles 里：装了但没合成，它注入的东西永远不会运行。`,
      commandsHint: '要卸载它，在 PowerShell 里执行：',
      restartHint: '只跑命令不会生效：运行中的 dsh 仍持有旧组合。命令跑完后，停掉 dsh web（Ctrl+C），再启动一次。',
      restartBlock: '# 1. 在 PowerShell 里\ndsh plugin --profile web remove dsh-ui-projects\n\n# 2. 停掉 dsh web（Ctrl+C），再启动一次',
      /*
       * 粘贴卸载命令之前需要知道的三件事：什么会自己消失、什么由命令完成、什么是有意不碰的。
       * 第三组是界面里别处都得不出答案的那一组 —— 两条关于用户数据的决定就写在这里（开关保留、
       * settings 条目也保留），而正准备删掉一个包的人，正是最需要读到它们的人。
       */
      uninstall: {
        title: '卸载会改变什么，以及不会碰什么',
        automaticTitle: '下次加载时自动移除',
        automatic: [
          '它在 UI 项目注册表里的条目：上面那张卡片随之消失',
          '它注入的样式表，以及它自己的 <style> 元素',
          '它写在 <body> 上的 data 属性；没有项目剩下时，data-ui-projects 也一并清掉',
          '它在自己作用域内声明的 CSS 变量',
          '它自己的存储键 —— 目前没有任何包持有这样的键，套件会保证一直如此',
          '它注册的监听器、定时器与 observer',
        ],
        commandTitle: '由上面的命令完成',
        command: [
          'profile 里的包目录，以及指向源码的符号链接',
          '它在 dsh.profile.bundles 里的那一行',
        ],
        keptTitle: '有意不碰',
        kept: [
          '你的开关记录：原本开着，重装后仍然是开的',
          '它的设置，包括已记录的验收确认 —— 这是你的数据，不是包的缓存',
          '其他包的设置：卸载只针对这一个包，不是整个 profile',
          'E:\\dsh\\plugins\\<package>\\ 下的源码目录，命令从不删除它',
          '版本快照目录 .dsh-ui-projects-versions\\，它正是回滚得以存在的原因',
        ],
      },
      kinds: { 'ui-project': 'UI 项目', bundle: 'bundle', library: '库', 'plugin-with-client': '插件', unresolved: '未安装' },
      maintenanceTitle: (name) => `维护 ${name} 包（只打印，不执行）`,
      maintenanceHint: '这些命令作用于**包**，不是某个项目或页面：它们重建、记录或恢复拥有这一行的包。',
      cmdSnapshotWhy: '先让当前运行的版本变成可回滚的：',
      cmdUpdateWhy: '在你带来新版本（git pull && npm run build）之后，记录当前状态：',
      cmdRollbackWhy: '恢复到某个已记录的版本（名字来自快照列表）：',
      cmdRollbackList: '查看所有可回滚的名字：install.ps1 -Rollback -List',
      noSnapshots: '还没有记录任何快照；跑一次 -Snapshot 才能回滚。',
      snapshotNames: (count) => `已记录 ${count} 个版本`,
      restartReminder: '以上命令都需要先停掉 dsh web（Ctrl+C），跑完再启动。',
    },
    priority: (value) => `优先级 ${value}`,
    orderHint: (name) => `${name} 目前运行在更高优先级的项目之前；下次加载时顺序会恢复。`,
    regions: {
      sidebar: '侧边栏',
      center: '中区',
      rightbar: '右栏',
      overlay: '浮层',
      composer: '输入区',
      dialogs: '对话框',
      tokens: '设计令牌',
      background: '背景',
    },
    regionShared: (names, regions) => `${names.join('、')}都声明修改${regions.join('、')}，可能互相影响。`,
    regionNested: (names, regions) => `${names.join('、')}都对${regions.join('、')}应用了模糊，图层可能发生嵌套。`,
    regionSharedHere: (other, regions) => `与${other}共享${regions}。`,
    regionNestedHere: (other, regions) => `与${other}都对${regions}应用了模糊，图层可能嵌套。`,
    tests: {
      summary: (count) => `验收清单（${count} 项）`,
      markPassed: '标记为已通过',
      withdraw: '撤回确认',
      passed: (version) => `已针对 v${version} 确认。`,
      stale: (version) => `此前针对 v${version} 确认过；当前版本需要重新确认。`,
      incomplete: (version) => `已针对 v${version} 确认过，但清单此后有变动；请重新确认。`,
    },
    status: { active: '已开启', inactive: '已关闭', error: '失败', unavailable: '不可用' },
    toggleOn: (name) => `开启 ${name}`,
    toggleOff: (name) => `关闭 ${name}`,
    resetOne: (name) => `将 ${name} 恢复为默认`,
    resetAll: '恢复默认界面',
    resetAllHint: '关闭所有界面项目，回到 dsh 出厂界面。',
    replacedBy: (names) => `将替换 ${names}`,
    errorLabel: '最近错误',
    versionLabel: '版本',
    previewAlt: (name) => `${name} 预览`,
    controls: {
      opacity: '透明度',
      unit: '%',
      opacityMore: '透明',
      opacityLess: '色调',
    },
    empty: '当前没有已注册的界面项目。',
    emptyHint: '安装界面项目插件后会自动出现在这里。',
  },
}

/**
 * @param {string} locale
 * @returns {typeof STRINGS.en}
 */
export function strings(locale) {
  return locale.toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en
}
