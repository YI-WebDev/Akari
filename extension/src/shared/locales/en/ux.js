// English for the ゴミ箱, the toast's 元に戻す, the theme setting, the lock screen's password
// toggle and Caps Lock warning, and the search operators. Keys are the Japanese source text (or a
// dotted key used with a Japanese fallback); values are the English. Japanese needs no entry.

export default {
  // ≡ menu and the ゴミ箱 sheet (popup/views/trash.js)
  'ゴミ箱': 'Trash',
  'ゴミ箱のアイテム': 'Items in the trash',
  'ゴミ箱を空にする': 'Empty trash',
  'menu.trash': 'Trash ({count})',
  'trash.sub': '{n} items · deleted for good after {days} days',
  'trash.noVault': 'deleted vault',
  'trash.left': '{n} d left',
  'trash.leftTitle': 'Deleted for good on {date}',
  'trash.restore': 'Restore',
  'trash.restoreOf': 'Restore {title}',
  'trash.purge': 'Delete for good',
  'trash.purgeOf': 'Delete {title} for good',
  'trash.askOne': 'Delete for good? This cannot be undone',
  'trash.askAll': 'Delete everything in the trash for good? This cannot be undone',
  'trash.emptyGo': 'Delete all ({n})',
  'trash.empty': 'The trash is empty',
  'trash.emptyNote': 'Deleted items stay here for {days} days, and you can restore them',
  'trash.purged': 'Deleted for good: {n}',
  'trash.restoreFailed': 'Could not restore',

  // deleting: the confirmations, the toast and 元に戻す (popup.js onTrashed / onRestored)
  'trash.ask': 'Move to the trash? You can restore it for 30 days',
  'trash.askN': 'Move the selected items ({n}) to the trash? You can restore them for 30 days',
  'trash.askPasskeys': 'Passkeys ({n}) go to the trash too. While they are there, you cannot sign in to their sites with them',
  'trash.movedOne': 'Moved {title} to the trash',
  'trash.moved': 'Moved to the trash: {n}',
  'trash.keep': 'Deleted for good after {days} days',
  'trash.undoKey': 'Restore (Ctrl+Z)',
  'trash.restoredOne': 'Restored {title}',
  'trash.restored': 'Restored: {n}',
  'trash.restoredIn': 'Back in the vault “{vault}”',
  'vaults.noteTrash': 'You can make up to {n} vaults. When you delete one, you choose whether its items move to another vault or go to the trash with it.',
  'vaults.trashedN': 'Moved to the trash: {n}',
  'vaults.toTrash': 'Move to trash',

  // search operators (popup/search.js)
  '絞り込み: type:login · has:totp · is:weak · vault:名前': 'Filter: type:login · has:totp · is:weak · vault:name',
  'list.loose': 'Close to “{q}”',

  // テーマ (popup/views/settings.js, shared/theme.js)
  'テーマ': 'Theme',
  'ダーク': 'Dark',
  'ライト': 'Light',
  'settings.themeDark': "Akari's dark screen",
  'settings.themeLight': 'The lamp on light paper. The menus on web pages follow too',
  'settings.themeAuto': 'Follows your OS (now {mode})',

  // the lock screen (popup/views/lock.js)
  'Caps Lock がオンです': 'Caps Lock is on',
};
