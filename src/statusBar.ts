import * as vscode from 'vscode'
import type { EnvProfileMeta } from './types'

export function createStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  item.command = 'envSwitch.switchProfile'
  item.tooltip = 'Switch Env Profile'
  setInactive(item)
  item.show()
  return item
}

export function updateStatusBar(item: vscode.StatusBarItem, profiles: EnvProfileMeta[]): void {
  const active = profiles.find((p) => p.isActive)
  if (active) {
    item.text = `$(check) ENV: ${active.name}`
    item.tooltip = `Active env profile: ${active.name} → ${active.targetFile}\nClick to switch`
    item.backgroundColor = undefined
  } else {
    setInactive(item)
  }
}

function setInactive(item: vscode.StatusBarItem): void {
  item.text = '$(file) ENV: —'
  item.tooltip = 'No env profile active. Click to switch.'
}
