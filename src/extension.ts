import * as vscode from 'vscode'
import { TextDecoder } from 'util'
import { ProfileManager } from './profileManager'
import { ProfileTreeProvider } from './treeProvider'
import { createStatusBarItem, updateStatusBar } from './statusBar'
import { validateTargetFile } from './storage'
import { EnvFileSystemProvider, ENV_SCHEME } from './envFileSystemProvider'
import type { EnvProfileMeta } from './types'

/** Mask a secret value, revealing only the first 4 characters. */
function maskValue(value: string): string {
  if (!value) return '(empty)'
  if (value.length <= 4) return '****'
  return `${value.slice(0, 4)}****`
}

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  if (!ctx.storageUri) {
    vscode.window.showErrorMessage('Env Manager requires an open workspace folder.')
    return
  }

  const manager = new ProfileManager(ctx)
  const treeProvider = new ProfileTreeProvider(manager)
  const statusBar = createStatusBarItem()
  const fsProvider = new EnvFileSystemProvider()
  let activeTargetWatcher: vscode.FileSystemWatcher | undefined

  ctx.subscriptions.push(statusBar)
  ctx.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(ENV_SCHEME, fsProvider, { isCaseSensitive: true }),
  )
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('envSwitch.profiles', treeProvider),
  )

  const refresh = async (): Promise<void> => {
    treeProvider.refresh()
    const profiles = await manager.list()
    updateStatusBar(statusBar, profiles)
    await updateActiveTargetWatcher()
  }

  const showSyncNotice = (profileName: string): void => {
    void vscode.window.setStatusBarMessage(
      `EnvSwitch synced changes from .env into "${profileName}"`,
      2000,
    )
  }

  const updateActiveTargetWatcher = async (): Promise<void> => {
    activeTargetWatcher?.dispose()
    activeTargetWatcher = undefined

    const active = await manager.getActive()
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri
    if (!active || !workspaceRoot) return

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, active.targetFile),
    )

    const syncActiveProfile = async (): Promise<void> => {
      try {
        const changed = await manager.syncFromWorkspace(active.id)
        if (changed) {
          showSyncNotice(active.name)
          await refresh()
        }
      } catch {
        // Ignore sync failures here; activation and manual edits already surface errors.
      }
    }

    watcher.onDidChange(syncActiveProfile)
    watcher.onDidCreate(syncActiveProfile)
    activeTargetWatcher = watcher
    ctx.subscriptions.push(watcher)
  }

  await refresh()

  /**
   * When a command is invoked from the tree view context menu, VS Code passes
   * the TreeItem instance (ProfileItem) as the argument.
   * When invoked via this.command on the item, it passes EnvProfileMeta directly.
   * This helper normalises both cases.
   */
  function resolveProfile(arg: unknown): EnvProfileMeta | undefined {
    if (!arg || typeof arg !== 'object') return undefined
    if ('profile' in arg) return (arg as { profile: EnvProfileMeta }).profile
    if ('id' in arg) return arg as EnvProfileMeta
    return undefined
  }

  // ── Create Profile ──────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand('envSwitch.createProfile', async () => {
      const name = await vscode.window.showInputBox({
        title: 'New Env Profile — Step 1 of 3',
        prompt: 'Profile name (e.g. dev, prod, staging)',
        placeHolder: 'dev',
        validateInput: (v) => (v?.trim() ? null : 'Name is required'),
      })
      if (name === undefined) return

      const targetFile = await vscode.window.showInputBox({
        title: 'New Env Profile — Step 2 of 3',
        prompt: 'Relative path to .env file within workspace',
        value: '.env',
        validateInput: (v) => validateTargetFile(v ?? ''),
      })
      if (targetFile === undefined) return

      const source = await vscode.window.showQuickPick(
        [
          { label: '$(file-symlink-file) Import from existing file', id: 'import' },
          { label: '$(new-file) Start with empty content', id: 'empty' },
        ],
        { title: 'New Env Profile — Step 3 of 3', placeHolder: 'How to populate this profile?' },
      )
      if (!source) return

      let content = ''
      if (source.id === 'import') {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri
        if (workspaceRoot) {
          try {
            const uri = vscode.Uri.joinPath(workspaceRoot, targetFile)
            const bytes = await vscode.workspace.fs.readFile(uri)
            content = new TextDecoder().decode(bytes)
          } catch {
            vscode.window.showWarningMessage(
              `Could not read "${targetFile}". Creating profile with empty content.`,
            )
          }
        }
      }

      try {
        await manager.create(name, targetFile, content)
        await refresh()
        vscode.window.showInformationMessage(`Profile "${name.trim()}" created.`)
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to create profile: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }),
  )

  // ── Activate Profile (from tree item click or command) ─────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'envSwitch.activateProfile',
      async (arg?: unknown) => {
        const resolved = resolveProfile(arg)
        let id = resolved?.id

        if (!id) {
          const profiles = await manager.list()
          if (profiles.length === 0) {
            const action = await vscode.window.showInformationMessage(
              'No env profiles yet.',
              'Create Profile',
            )
            if (action === 'Create Profile') {
              await vscode.commands.executeCommand('envSwitch.createProfile')
            }
            return
          }

          const pick = await vscode.window.showQuickPick(
            profiles.map((p) => ({
              label: p.isActive ? `$(check) ${p.name}` : p.name,
              description: p.targetFile,
              detail: p.isActive ? 'Currently active' : undefined,
              id: p.id,
              name: p.name,
            })),
            { title: 'Switch Env Profile', placeHolder: 'Select a profile to activate' },
          )
          if (!pick) return
          id = pick.id
        }

        try {
          await manager.activate(id)
          await refresh()
          const activated = (await manager.list()).find((p) => p.id === id)
          if (activated) {
            vscode.window.showInformationMessage(
              `Env profile "${activated.name}" is now active → ${activated.targetFile}`,
            )
          }
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to activate profile: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      },
    ),
  )

  // ── Switch Profile (status bar shortcut → same as activate) ───────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand('envSwitch.switchProfile', async () => {
      await vscode.commands.executeCommand('envSwitch.activateProfile')
    }),
  )

  // ── Edit Profile ────────────────────────────────────────────────────────────
  // Uses a virtual filesystem (envswitch:// scheme) so Cmd+S saves directly
  // to the OS keychain without any "Save As" dialog. Content never hits disk.
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'envSwitch.editProfile',
      async (arg?: unknown) => {
        const profileArg = resolveProfile(arg)
        if (!profileArg?.id) return

        const content = await manager.loadContent(profileArg.id)
        const uri = vscode.Uri.parse(`${ENV_SCHEME}:/profiles/${profileArg.id}.env`)

        fsProvider.initFile(uri, content)
        fsProvider.registerSaveCallback(uri, async (updated) => {
          await manager.updateContent(profileArg.id, updated)
          vscode.window.showInformationMessage(`Profile "${profileArg.name}" saved.`)
        })

        const doc = await vscode.workspace.openTextDocument(uri)
        await vscode.window.showTextDocument(doc)

        // Clean up when the editor is closed
        const closeListener = vscode.workspace.onDidCloseTextDocument((closed) => {
          if (closed.uri.toString() === uri.toString()) {
            fsProvider.cleanUp(uri)
            closeListener.dispose()
          }
        })
        ctx.subscriptions.push(closeListener)
      },
    ),
  )

  // ── Delete Profile ──────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'envSwitch.deleteProfile',
      async (arg?: unknown) => {
        const profileArg = resolveProfile(arg)
        if (!profileArg?.id) return

        const confirm = await vscode.window.showWarningMessage(
          `Delete profile "${profileArg.name}"? This cannot be undone.`,
          { modal: true },
          'Delete',
        )
        if (confirm !== 'Delete') return

        try {
          await manager.delete(profileArg.id)
          await refresh()
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to delete: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      },
    ),
  )

  // ── Diff Profiles ───────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand('envSwitch.diffProfiles', async () => {
      const profiles = await manager.list()
      if (profiles.length < 2) {
        vscode.window.showInformationMessage('You need at least 2 profiles to compare.')
        return
      }

      const pick1 = await vscode.window.showQuickPick(
        profiles.map((p) => ({ label: p.name, description: p.targetFile, id: p.id })),
        { title: 'Compare Profiles — Step 1 of 2', placeHolder: 'Select first profile' },
      )
      if (!pick1) return

      const pick2 = await vscode.window.showQuickPick(
        profiles
          .filter((p) => p.id !== pick1.id)
          .map((p) => ({ label: p.name, description: p.targetFile, id: p.id })),
        { title: 'Compare Profiles — Step 2 of 2', placeHolder: 'Select second profile to compare' },
      )
      if (!pick2) return

      const [content1, content2] = await Promise.all([
        manager.loadContent(pick1.id),
        manager.loadContent(pick2.id),
      ])

      const uri1 = vscode.Uri.parse(`${ENV_SCHEME}:/diff/${pick1.id}.env`)
      const uri2 = vscode.Uri.parse(`${ENV_SCHEME}:/diff/${pick2.id}.env`)
      fsProvider.initFile(uri1, content1)
      fsProvider.initFile(uri2, content2)

      await vscode.commands.executeCommand(
        'vscode.diff',
        uri1,
        uri2,
        `Diff: ${pick1.label} ↔ ${pick2.label}`,
        { preview: true },
      )

      // Clean up virtual files when either diff document is closed
      const diffCloseListener = vscode.workspace.onDidCloseTextDocument((closed) => {
        const str = closed.uri.toString()
        if (str === uri1.toString() || str === uri2.toString()) {
          fsProvider.cleanUp(uri1)
          fsProvider.cleanUp(uri2)
          diffCloseListener.dispose()
        }
      })
      ctx.subscriptions.push(diffCloseListener)
    }),
  )

  // ── Show History ────────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'envSwitch.showHistory',
      async (arg?: unknown) => {
        const profileArg = resolveProfile(arg)
        if (!profileArg?.id) return

        const history = await manager.getHistory(profileArg.id)
        if (history.length === 0) {
          vscode.window.showInformationMessage(
            `No history for "${profileArg.name}" yet. Edit and save the profile to generate snapshots.`,
          )
          return
        }

        const pick = await vscode.window.showQuickPick(
          history.map((h, i) => ({
            label: `$(history) ${new Date(h.savedAt).toLocaleString()}`,
            description: h.label,
            detail: i === 0 ? 'Most recent snapshot' : undefined,
            id: h.id,
          })),
          { title: `History — ${profileArg.name}`, placeHolder: 'Select a snapshot' },
        )
        if (!pick) return

        const action = await vscode.window.showQuickPick(
          [
            { label: '$(eye) Preview', id: 'preview' },
            { label: '$(history) Restore', id: 'restore', description: 'Current content is saved first' },
          ],
          { title: 'What do you want to do with this snapshot?' },
        )
        if (!action) return

        if (action.id === 'preview') {
          const content = await manager.loadHistoryContent(pick.id)
          const uri = vscode.Uri.parse(`${ENV_SCHEME}:/history/${pick.id}.env`)
          fsProvider.initFile(uri, content)
          const doc = await vscode.workspace.openTextDocument(uri)
          await vscode.window.showTextDocument(doc, { preview: true })
          const histCloseListener = vscode.workspace.onDidCloseTextDocument((closed) => {
            if (closed.uri.toString() === uri.toString()) {
              fsProvider.cleanUp(uri)
              histCloseListener.dispose()
            }
          })
          ctx.subscriptions.push(histCloseListener)
        } else {
          const confirm = await vscode.window.showWarningMessage(
            `Restore "${profileArg.name}" to this snapshot? Current content will be saved to history first.`,
            { modal: true },
            'Restore',
          )
          if (confirm !== 'Restore') return
          try {
            await manager.restoreFromHistory(pick.id)
            vscode.window.showInformationMessage(
              `Profile "${profileArg.name}" restored. Previous content was saved to history.`,
            )
          } catch (err) {
            vscode.window.showErrorMessage(
              `Failed to restore: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
      },
    ),
  )
  // ── Validate Profile ─────────────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'envSwitch.validateProfile',
      async (arg?: unknown) => {
        const profileArg = resolveProfile(arg)
        let profileId = profileArg?.id
        let profileName = profileArg?.name ?? ''

        if (!profileId) {
          const profiles = await manager.list()
          if (profiles.length === 0) {
            vscode.window.showInformationMessage('No profiles to validate.')
            return
          }
          const pick = await vscode.window.showQuickPick(
            profiles.map((p) => ({ label: p.name, description: p.targetFile, id: p.id })),
            { title: 'Validate Profile', placeHolder: 'Select a profile to validate against .env.example' },
          )
          if (!pick) return
          profileId = pick.id
          profileName = pick.label
        }

        try {
          const result = await manager.validateAgainstExample(profileId)

          if (!result.exampleFound) {
            vscode.window.showWarningMessage(
              `No .env.example found at "${result.exampleFile}". Create one to enable validation.`,
            )
            return
          }

          if (result.missing.length === 0 && result.empty.length === 0 && result.extra.length === 0) {
            vscode.window.showInformationMessage(
              `Profile "${profileName}" is valid — all variables from .env.example are present and non-empty.`,
            )
            return
          }

          const items: vscode.QuickPickItem[] = []
          if (result.missing.length > 0) {
            items.push({ label: `Missing (${result.missing.length})`, kind: vscode.QuickPickItemKind.Separator })
            items.push(...result.missing.map((k) => ({
              label: `$(error) ${k}`,
              description: 'required by .env.example — not in profile',
            })))
          }
          if (result.empty.length > 0) {
            items.push({ label: `Empty values (${result.empty.length})`, kind: vscode.QuickPickItemKind.Separator })
            items.push(...result.empty.map((k) => ({
              label: `$(warning) ${k}`,
              description: 'defined but has no value',
            })))
          }
          if (result.extra.length > 0) {
            items.push({ label: `Extra (${result.extra.length})`, kind: vscode.QuickPickItemKind.Separator })
            items.push(...result.extra.map((k) => ({
              label: `$(info) ${k}`,
              description: 'not in .env.example — possibly outdated',
            })))
          }

          const editLabel = '$(edit) Open Profile Editor'
          items.push({ label: '', kind: vscode.QuickPickItemKind.Separator })
          items.push({ label: editLabel, description: 'Fix missing variables now' })

          const parts: string[] = []
          if (result.missing.length > 0) parts.push(`${result.missing.length} missing`)
          if (result.empty.length > 0) parts.push(`${result.empty.length} empty`)
          if (result.extra.length > 0) parts.push(`${result.extra.length} extra`)

          const selected = await vscode.window.showQuickPick(items, {
            title: `Validation — ${profileName}`,
            placeHolder: parts.join(', '),
          })
          if (selected?.label === editLabel) {
            await vscode.commands.executeCommand('envSwitch.editProfile', { id: profileId, name: profileName })
          }
        } catch (err) {
          vscode.window.showErrorMessage(
            `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      },
    ),
  )

  // ── Search Variable ──────────────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand('envSwitch.searchVariable', async () => {
      const allKeys = await manager.getAllVariableNames()
      if (allKeys.length === 0) {
        vscode.window.showInformationMessage('No variables found in any profile.')
        return
      }

      const varPick = await vscode.window.showQuickPick(
        allKeys.map((k) => ({ label: k })),
        { title: 'Search Variable Across Profiles', placeHolder: 'Type a variable name to search' },
      )
      if (!varPick) return

      const results = await manager.searchVariable(varPick.label)
      const resultItems = results.map((r) => ({
        label: `${r.found ? '$(check)' : '$(x)'} ${r.profileName}`,
        description: r.found ? maskValue(r.value!) : 'not defined',
        detail: r.isActive ? '● active profile' : r.targetFile,
        result: r,
      }))

      const picked = await vscode.window.showQuickPick(resultItems, {
        title: `"${varPick.label}" across ${results.length} profile(s)`,
        placeHolder: `${results.filter((r) => r.found).length} of ${results.length} profiles have this variable`,
      })
      if (!picked) return

      if (!picked.result.found) {
        vscode.window.showInformationMessage(
          `"${varPick.label}" is not defined in profile "${picked.result.profileName}".`,
        )
        return
      }

      const action = await vscode.window.showQuickPick(
        [
          { label: '$(copy) Copy value to clipboard', id: 'copy' },
          { label: '$(eye) Reveal full value', id: 'reveal' },
        ],
        { title: `"${varPick.label}" in "${picked.result.profileName}"` },
      )
      if (!action) return

      const value = picked.result.value!
      if (action.id === 'copy') {
        await vscode.env.clipboard.writeText(value)
        vscode.window.showInformationMessage(`"${varPick.label}" copied to clipboard.`)
      } else {
        vscode.window.showInformationMessage(`${varPick.label} = ${value}`, 'OK')
      }
    }),
  )
  // ── Refresh ─────────────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand('envSwitch.refresh', refresh),
  )
}

export function deactivate(): void {}
