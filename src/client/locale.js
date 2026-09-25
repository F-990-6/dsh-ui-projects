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
