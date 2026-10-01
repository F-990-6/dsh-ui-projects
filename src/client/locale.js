/**
 * Copy for the Settings › UI section, in the two locales the shipped Web client
 * speaks. The plugin does not register a locale namespace: it reads the active
 * locale id and picks a dictionary, so it works in any composition and in any
 * third language (falling back to English).
 */

/**
 * A timestamp from the host, as a person should read it.
 *
 * The host records `createdAt` in .NET's round-trip format — `2026-09-27T04:47:12.2663764Z`, seven
 * fractional digits and all — which is the right thing to RECORD and the wrong thing to SHOW: the
 * precision is noise to a reader, and `T` is not how a date is said out loud. The sentence therefore
 * carries `2026-09-27 04:47 UTC`.
 *
 * The zone is kept, and that is not decoration: the value IS UTC (the host formats
 * `(Get-Date).ToUniversalTime()`), so printing it bare would present a UTC instant as though it were
 * local time — silently wrong by hours for every reader who is not in UTC.
 *
 * `Z` is REQUIRED before this function will call a value UTC, and anything it does not recognize comes
 * back UNCHANGED. A stamp it cannot parse is not one it may re-label, and the raw string is at least
 * true; the alternative — printing "UTC" over a value that never said so — is a nicer-looking lie.
 *
 * It is string surgery rather than `new Date(...)` on purpose: no timezone of the reader's machine can
 * move the number, and a value from a future host format survives as itself rather than as `Invalid
 * Date`.
 * @param {string} value
 * @returns {string}
 */
export function formatStamp(value) {
  const text = typeof value === 'string' ? value : ''
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?Z$/.exec(text)
  return match === null ? text : `${match[1]} ${match[2]} UTC`
}

/**
 * The four vocabularies BOTH settings pages read: the effect tiers, the priority sentence, the eight
 * region names, and a preview's alt text.
 *
 * ONE OBJECT, REACHED TWO WAYS. The projects page reads them at the dictionary's top level. The
 * installed-package column may only read through `plugins` — a source guard in `scripts/verify.mjs`
 * enforces that, because a read one level too high was a shipped bug — so each vocabulary is
 * published under both paths. Publishing a COPY under `plugins` would be two sources for one
 * vocabulary, which is the defect this project keeps paying for, so `plugins.perf` and `perf` are the
 * SAME object and the suite asserts that identity rather than mere equality.
 */
const SHARED = {
  en: {
    perf: { low: 'Performance: reduced', medium: 'Performance: balanced', high: 'Performance: full' },
    priority: (value) => `Priority ${value}`,
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
    previewAlt: (name) => `${name} preview`,
  },
  zh: {
    perf: { low: '性能：已降低', medium: '性能：均衡', high: '性能：完整' },
    priority: (value) => `优先级 ${value}`,
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
    previewAlt: (name) => `${name} 预览`,
  },
}

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
    perf: SHARED.en.perf,
    perfDemoted: (names, tier) => `${names} is running at "${tier}" because this device reported less capacity.`,
    persistError: (message) => `Your last change could not be saved: ${message}`,
    /*
     * The maintenance block on a project's card. It names the PACKAGE because the commands maintain the
     * package that owns the project, not the project — and it has a second heading for a project that
     * never said which package that is (`maintenanceTitleUnknown` below).
     */
    maintenanceTitle: (name) => `Maintaining the ${name} package (printed, not run)`,
    /*
     * The heading for a project with no package identity — a definition registered through the
     * one-argument `registry.register`, which carries no manifest and therefore no identity. It is a
     * sentence about the PROJECT rather than a name, because there is no name to print, and the commands
     * below it address a package the page cannot identify.
     */
    maintenanceTitleUnknown: 'Maintenance commands (this project did not name the package it belongs to)',
    maintenanceHint:
      'These act on the package that owns this project, not on the project itself. Run them in that package’s own directory if it ships an install.ps1; if it does not, run them from dsh-ui-projects with -Package <name>.',
    maintenanceBadge: 'maintenance commands (printed) · a recorded version differs',
    maintenanceSnapshot: 'install.ps1 -Snapshot',
    maintenanceUpdate: 'install.ps1 -Update',
    maintenanceRollback: 'install.ps1 -Rollback -To <name>',
    snapshotNewer: (name, version, when) => `The newest snapshot is ${name} (package v${version}, ${formatStamp(when)}); it matches what is installed.`,
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
      /*
       * THE UI CONTRACT BADGE (step 9b). Four states, four sentences, and the difference between them is
       * the point: a green badge means "the scanner read the bundle and found nothing", never "this plugin
       * is fine" — which is why the panel under it always prints the instrument's own limits, including
       * the rule it cannot decide at all (rule 3, the runtime overlay).
       *
       * `contractNotScannedWhy` covers two rows with one key: the host's REASON when it declined to scan
       * (not installed, no client half, no bundle, over the cap), and — when a host predates the scan
       * entirely and sent no contract at all — the sentence about the host. Both render in the same place
       * on the same row, and both must avoid the one thing that would be a lie: claiming a scan happened.
       */
      contractOk: 'follows the UI Contract (static scan clean)',
      contractWarn: (count) => `UI Contract: ${count} finding${count === 1 ? '' : 's'}`,
      contractNotScanned: 'UI Contract: not scanned',
      contractNotApplicable: 'n/a',
      /*
       * THE API-VERSION MARK (E1b, `UI第三阶段.txt:29-31`), a DIFFERENT question from the contract scan:
       * "can this dsh run the plugin API the package declares" versus "did the static contract scan pass".
       * The row carries two attributes for the two answers, and this is the sentence a reader gets when the
       * first one is `unsupported`.
       */
      apiUnsupported: 'plugin API not supported',
      /*
       * THE UPGRADE CHECK (E3, `UI第三阶段.txt:37-40`). After a dsh upgrade a reader gets a list of the
       * packages this build cannot run, and TWO things they can really do about it: update the package, or
       * turn its project off. Removing a package is the loader's job, so that is offered as a COMMAND —
       * and postponing the dsh upgrade is a sentence rather than a control, because nothing here can roll
       * back a host.
       */
      upgradeCheckTitle: 'After the upgrade',
      upgradeCheckHint: 'These packages declare a plugin API this dsh cannot run.',
      upgradeCheckIncompatible: 'declares a plugin API this dsh cannot run',
      upgradeCheckCurrent: 'this package is fine',
      disableProjectHint: 'You can turn the project off in the UI page; the package stays installed.',
      removePackageHint: 'To remove the package itself, run this command and restart dsh:',
      upgradeDeferredNote: 'Not ready? Keep using this dsh: nothing here breaks, and the packages above stay off until you upgrade them.',
      contractCoverage: (judged, total) =>
        `${judged} of the contract’s ${total} rules are judged by reading the built bundle; the rest are listed below`,
      contractFindingsTitle: 'What the scan found',
      contractLimitsTitle: 'What this scan cannot see',
      contractNotScannedWhy: (reason) =>
        typeof reason === 'string' && reason.length > 0
          ? `Not scanned: ${reason}`
          : 'The host did not report a contract scan for this row; dsh web may need a restart.',
      /*
       * THE FRAMEWORK'S OWN ROW (9b review). Its badge says the contract does not apply, and its panel
       * still shows what the host read — because two findings behind a badge that says "not applicable"
       * is a contradiction a reader has to be given the answer to, not shielded from.
       */
      contractFramework: (count) => `The framework itself: the contract does not apply (${count} accepted)`,
      contractFrameworkNote: (count) =>
        `The framework is not bound by the contract; these ${count} are recorded rather than fixed in this round, and the snapshot in check-installed.test.mjs pins them.`,
      commandsHint: 'To remove it, run this in PowerShell:',
      restartHint: 'The command alone does not take effect: the running dsh still holds the old composition. After it finishes, stop dsh web (Ctrl+C) and start it again.',
      /*
       * THE BLOCK READS THE COMMAND, it does not restate it.
       *
       * It used to be a literal with `dsh-ui-projects` typed into it — correct by luck while the page had
       * one removable row, and wrong on every other row the moment a profile held two packages: the row
       * printed `remove @scope/name` on one line and `remove dsh-ui-projects` four lines later. Two
       * sources for one command is the whole bug, so there is now one source: `CommandBlock` builds the
       * command once and passes it here.
       */
      restartBlock: (command) => `# 1. in PowerShell\n${command}\n\n# 2. stop dsh web (Ctrl+C), then start it again`,
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
      maintenanceHint:
        'These commands act on the PACKAGE, not on a project or a page: they rebuild, record or restore the package that owns this row. Run them in this package’s own directory if it ships an install.ps1; if it does not, run them from dsh-ui-projects with -Package <name>.',
      cmdSnapshotWhy: 'Make the version that is running now restorable:',
      cmdUpdateWhy: 'After you bring a new version (git pull && npm run build), record what is there:',
      cmdRollbackWhy: 'Restore a recorded version (a name comes from the snapshot list):',
      cmdRollbackList: 'To see every restorable name: install.ps1 -Rollback -List',
      noSnapshots: 'No version snapshots recorded yet; -Snapshot is what makes a rollback possible.',
      snapshotNames: (count) => `${count} recorded version(s)`,
      restartReminder: 'All of these need dsh web stopped first (Ctrl+C), and started again afterwards.',
      kinds: { 'ui-project': 'UI project', bundle: 'bundle', library: 'library', 'plugin-with-client': 'plugin', unresolved: 'not installed' },
      /*
       * ── step 56a: the row's own facts ────────────────────────────────────────
       *
       * The four names at the bottom are published as the SAME objects the projects page reads (see
       * `SHARED`), not as copies. The rest is this column's own copy, and each field has ONE sentence
       * for "the package declares nothing" — the "this dsh is older than this page" case is a single
       * shared sentence (`hostFieldMissing`), because it is a fact about the host, not about a field.
       */
      descriptionNotDeclared: 'no description in package.json',
      authorNotDeclared:
        'no author in package.json — this workspace installs from local link: paths, so no package here has ever needed publishing metadata',
      author: (value) => `by ${value}`,
      hostFieldMissing: (field) => `the running dsh is older than this page: it does not report ${field}`,
      previewNotDeclared: 'this package declares no preview',
      perfNotDeclared: 'effects: not declared',
      priorityNotDeclared: 'priority: not declared',
      priorityNotApplicable: 'priority: enhancements only',
      modifies: (regions) => `changes: ${regions.join(', ')}`,
      modifiesNotDeclared: 'changes: not declared',
      requires: (ids) => `requires: ${ids.join(' → ')}`,
      requiresNotDeclared: 'requires: not declared',
      projectOn: (name) => `${name} is on`,
      projectOff: (name) => `${name} is off`,
      projectNotRegistered: (id) => `project ${id} is not registered in this session`,
      changeInUiPage: 'change it in Settings › UI',
      regions: SHARED.en.regions,
      perf: SHARED.en.perf,
      priority: SHARED.en.priority,
      previewAlt: SHARED.en.previewAlt,
      /*
       * ── step 56b: the folded CHANGELOG ───────────────────────────────────────
       *
       * The reason CODES are the host's (`CHANGELOG_REASONS`); these are the sentences. Four of them
       * are facts about a package — no file, no sections, too large to read, unreadable — and one is a
       * fact about the request: the name is not in this profile, which is also the answer a
       * path-traversal attempt gets.
       */
      changelogTitle: 'CHANGELOG',
      changelogLoading: 'reading the changelog…',
      changelogFailed: (message) => `the changelog could not be read: ${message}`,
      changelogNoFile: 'this package ships no CHANGELOG.md',
      changelogNoSections: 'the changelog has no "## " sections',
      changelogUnreadable: (detail) => `the changelog could not be read: ${detail}`,
      changelogNotInstalled: (name) => `${name} is not in this profile's dependency list`,
      changelogTruncated: (count) => `… ${count} more line(s); see CHANGELOG.md`,
      /*
       * ── step 56c: the default view, the folds, and the copy buttons ──────────
       *
       * Every §五 field is still here, one fold down; what changed is what a reader meets FIRST. The
       * "not declared" sentences are no longer read by anything — a field with no value renders nothing
       * — and they are kept in the dictionary because the column may want them again, and because the
       * suite's unread-key note is a better place to see them than a deleted key would be.
       */
      rowDetails: 'Package details',
      updateAvailable: (tag) => `Update available on ${tag}`,
      channelLabel: (channel) => `${channel} channel`,
      updateHint: (installed, latest) => `Installed ${installed}; ${latest} is available.`,
      maintenanceBrief: 'These act on the PACKAGE: run them in its own directory, or from here with -Package <name>.',
      uninstallTitle: (name) => `Remove ${name}`,
      uninstallBrief: 'Removing it takes the package only — your switch and its settings stay.',
      copyCommand: 'Copy',
      copyDone: 'Copied',
      copyFailed: 'Copy failed — select it manually',
      /* ── step 56d: short fold titles, because a fold's title is a label rather than a sentence ── */
      foldContractPassed: 'Contract: passed',
      foldContractFindings: (count) => `Contract: ${count} finding(s)`,
      foldMaintenance: 'Maintenance commands',
      foldHint: 'Notes',
    },
    priority: SHARED.en.priority,
    orderHint: (name) => `${name} is running ahead of a higher-priority project; the order is restored on the next load.`,
    regions: SHARED.en.regions,
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
    previewAlt: SHARED.en.previewAlt,
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
    perf: SHARED.zh.perf,
    perfDemoted: (names, tier) => `${names} 正以“${tier}”运行——此设备报告的能力较低。`,
    persistError: (message) => `最后一次修改没能保存：${message}`,
    /*
     * 项目卡片上的维护块。写出**包**名，是因为命令维护的是拥有这个项目的包，而不是项目本身；
     * 对于从未说明自己属于哪个包的项目，另有 maintenanceTitleUnknown 这一句。
     */
    maintenanceTitle: (name) => `维护 ${name} 包（只打印，不执行）`,
    /* 没有包身份的项目（经单参数 registry.register 注册的 definition）：没有名字可写，所以说事实。 */
    maintenanceTitleUnknown: '维护命令（这个项目没有说明它属于哪个包）',
    maintenanceHint:
      '这些命令作用于拥有本项目的包，而不是项目本身。若该包自带 install.ps1，就在该包目录里运行；若没有，则在 dsh-ui-projects 目录用 -Package <name> 运行。',
    maintenanceBadge: '维护命令（只打印）· 有未记录的快照',
    maintenanceSnapshot: 'install.ps1 -Snapshot',
    maintenanceUpdate: 'install.ps1 -Update',
    maintenanceRollback: 'install.ps1 -Rollback -To <name>',
    snapshotNewer: (name, version, when) => `最新快照是 ${name}（包 v${version}，${formatStamp(when)}）；与当前安装的一致。`,
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
      /*
       * UI Contract 徽章（第 9b 步）。四个状态四句话，区别正是重点：绿色只表示“扫描器读了构建产物、没发现
       * 问题”，绝不表示“这个插件没问题” —— 所以下方面板始终打印工具自己的局限，包括它根本判不了的那条
       * （规则 3，运行时浮层）。
       *
       * contractNotScannedWhy 一个键覆盖两种行：宿主拒绝扫描时给出它的**原因**（未安装、没有客户端半边、
       * 没有构建产物、超过上限），以及宿主比这次扫描更早、压根没送 contract 时那句关于宿主的话。两者都
       * 渲染在同一行的同一位置，且都必须避开唯一会造成谎言的说法：声称扫描发生过。
       */
      contractOk: '遵守 UI Contract（静态扫描通过）',
      contractWarn: (count) => `UI Contract：${count} 处发现`,
      contractNotScanned: 'UI Contract：未扫描',
      contractNotApplicable: '不适用',
      /*
       * API 版本标记（E1b，《UI第三阶段》29–31 行）：与契约扫描是**两个问题** ——
       * “这个 dsh 能不能运行该包声明的 plugin API” 对 “静态契约扫描是否通过”。
       * 行上用两个属性分别承载，这一句是第一个答案为 `unsupported` 时读者看到的话。
       */
      apiUnsupported: '插件 API 不受支持',
      /*
       * 升级检查（E3，《UI第三阶段》37–40 行）。dsh 升级之后，读者拿到一份"本构建跑不了"的包清单，
       * 以及两件**真能做**的事：更新该包，或把它的项目关掉。卸包是加载器的职责，所以只给**命令文本**；
       * 而"暂缓升级 dsh"是一句话而不是控件 —— 这里没有任何东西能把宿主回滚。
       */
      upgradeCheckTitle: '升级之后',
      upgradeCheckHint: '这些包声明的 plugin API 本 dsh 跑不了。',
      upgradeCheckIncompatible: '声明的 plugin API 本 dsh 跑不了',
      upgradeCheckCurrent: '这个包没问题',
      disableProjectHint: '你可以在界面页把它的项目关掉；包本身仍然装着。',
      removePackageHint: '要卸载包本身，执行这条命令并重启 dsh：',
      upgradeDeferredNote: '还没准备好？继续用这版 dsh：这里不会坏，上面的包在你更新它们之前保持关闭。',
      contractCoverage: (judged, total) => `契约的 ${total} 条规则中有 ${judged} 条通过读构建产物判定；其余见下方`,
      contractFindingsTitle: '扫描发现',
      contractLimitsTitle: '这次扫描看不到的东西',
      contractNotScannedWhy: (reason) =>
        typeof reason === 'string' && reason.length > 0
          ? `未扫描：${reason}`
          : '宿主没有报告这一行的契约扫描结果；可能需要重启 dsh web。',
      /*
       * 框架自己那一行（9b 复审）。徽章说契约不适用，面板照样显示宿主读到的东西 ——
       * “不适用”的徽章旁边挂着两条 finding，这个矛盾必须给读者答案，而不是替他挡掉。
       */
      contractFramework: (count) => `契约：框架自身 —— 不适用（${count} 条已接受）`,
      contractFrameworkNote: (count) =>
        `框架自身不受契约约束；这 ${count} 条已记档，不在本轮修，check-installed.test.mjs 的快照钉着它们。`,
      commandsHint: '要卸载它，在 PowerShell 里执行：',
      restartHint: '只跑命令不会生效：运行中的 dsh 仍持有旧组合。命令跑完后，停掉 dsh web（Ctrl+C），再启动一次。',
      restartBlock: (command) => `# 1. 在 PowerShell 里\n${command}\n\n# 2. 停掉 dsh web（Ctrl+C），再启动一次`,
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
      maintenanceHint:
        '这些命令作用于**包**，不是某个项目或页面：它们重建、记录或恢复拥有这一行的包。若该包自带 install.ps1，就在该包目录里运行；若没有，则在 dsh-ui-projects 目录用 -Package <name> 运行。',
      cmdSnapshotWhy: '先让当前运行的版本变成可回滚的：',
      cmdUpdateWhy: '在你带来新版本（git pull && npm run build）之后，记录当前状态：',
      cmdRollbackWhy: '恢复到某个已记录的版本（名字来自快照列表）：',
      cmdRollbackList: '查看所有可回滚的名字：install.ps1 -Rollback -List',
      noSnapshots: '还没有记录任何快照；跑一次 -Snapshot 才能回滚。',
      snapshotNames: (count) => `已记录 ${count} 个版本`,
      restartReminder: '以上命令都需要先停掉 dsh web（Ctrl+C），跑完再启动。',
      /* ── step 56a：行自己的事实（与 en 同构） ─────────────────────────────── */
      descriptionNotDeclared: 'package.json 里没有 description',
      authorNotDeclared: 'package.json 里没有 author——本工作区用本地 link: 安装，从未需要发布元数据',
      author: (value) => `作者：${value}`,
      hostFieldMissing: (field) => `运行中的 dsh 比本页旧：它不上报 ${field}`,
      previewNotDeclared: '这个包没有声明预览',
      perfNotDeclared: '效果档：未声明',
      priorityNotDeclared: '优先级：未声明',
      priorityNotApplicable: '优先级：仅增强项适用',
      modifies: (regions) => `修改：${regions.join('、')}`,
      modifiesNotDeclared: '修改：未声明',
      requires: (ids) => `依赖：${ids.join(' → ')}`,
      requiresNotDeclared: '依赖：未声明',
      projectOn: (name) => `${name}：已开启`,
      projectOff: (name) => `${name}：已关闭`,
      projectNotRegistered: (id) => `项目 ${id} 在本会话中未注册`,
      changeInUiPage: '在 设置 › 界面 里修改',
      regions: SHARED.zh.regions,
      perf: SHARED.zh.perf,
      priority: SHARED.zh.priority,
      previewAlt: SHARED.zh.previewAlt,
      /* ── step 56b：折叠的更新日志（与 en 同构） ───────────────────────────── */
      changelogTitle: '更新日志',
      changelogLoading: '正在读取更新日志…',
      changelogFailed: (message) => `更新日志读取失败：${message}`,
      changelogNoFile: '这个包没有 CHANGELOG.md',
      changelogNoSections: '更新日志里没有 "## " 章节',
      changelogUnreadable: (detail) => `更新日志无法读取：${detail}`,
      changelogNotInstalled: (name) => `${name} 不在本 profile 的依赖列表里`,
      changelogTruncated: (count) => `……还有 ${count} 行，见 CHANGELOG.md`,
      /* ── step 56c：默认视图、折叠块、复制按钮（与 en 同构） ───────────────── */
      rowDetails: '包详情',
      updateAvailable: (tag) => `${tag} 通道有更新`,
      channelLabel: (channel) => `${channel} 通道`,
      updateHint: (installed, latest) => `已装 ${installed}，可用 ${latest}。`,
      maintenanceBrief: '这些命令作用于**包**：在本包目录里运行，或在此处加 -Package <name> 运行。',
      uninstallTitle: (name) => `卸载 ${name}`,
      uninstallBrief: '只移除此包——你的开关与它的设置都会保留。',
      copyCommand: '复制',
      copyDone: '已复制',
      copyFailed: '复制失败，请手动复制',
      /* ── step 56d：折叠标题是标签而不是句子 ─────────────────────────────── */
      foldContractPassed: '契约：通过',
      foldContractFindings: (count) => `契约：${count} 处发现`,
      foldMaintenance: '维护命令',
      foldHint: '说明',
    },
    priority: SHARED.zh.priority,
    orderHint: (name) => `${name} 目前运行在更高优先级的项目之前；下次加载时顺序会恢复。`,
    regions: SHARED.zh.regions,
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
    previewAlt: SHARED.zh.previewAlt,
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
