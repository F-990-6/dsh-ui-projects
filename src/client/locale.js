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
      kinds: { 'ui-project': 'UI 项目', bundle: 'bundle', library: '库', 'plugin-with-client': '插件', unresolved: '未安装' },
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
