import * as vscode from 'vscode'
import type { EnvProfileMeta } from './types'
import type { ProfileManager } from './profileManager'

export class ProfileTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private readonly manager: ProfileManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const profiles = await this.manager.list()
    if (profiles.length === 0) {
      return [new EmptyItem()]
    }
    return profiles.map((p) => new ProfileItem(p))
  }
}

/** Escape Markdown special characters in user-controlled strings. */
function mdEscape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&')
}

class ProfileItem extends vscode.TreeItem {
  constructor(public readonly profile: EnvProfileMeta) {
    super(profile.name, vscode.TreeItemCollapsibleState.None)

    this.contextValue = 'profile'
    this.description = profile.isActive ? 'active' : profile.targetFile
    this.iconPath = new vscode.ThemeIcon(
      profile.isActive ? 'check' : 'circle-outline',
      profile.isActive ? new vscode.ThemeColor('charts.green') : undefined,
    )
    this.tooltip = new vscode.MarkdownString(
      `**${mdEscape(profile.name)}**\n\nTarget: \`${mdEscape(profile.targetFile)}\`\nCreated: ${new Date(profile.createdAt).toLocaleString()}`,
    )
    this.command = {
      command: 'envSwitch.activateProfile',
      title: 'Activate',
      arguments: [profile],
    }
  }
}

class EmptyItem extends vscode.TreeItem {
  constructor() {
    super('No profiles yet', vscode.TreeItemCollapsibleState.None)
    this.description = 'Click + to create one'
    this.iconPath = new vscode.ThemeIcon('info')
    this.contextValue = ''
  }
}
