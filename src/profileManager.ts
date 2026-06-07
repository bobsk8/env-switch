import * as vscode from 'vscode'
import * as path from 'path'
import * as crypto from 'crypto'
import { promises as fs } from 'fs'
import { TextDecoder, TextEncoder } from 'util'
import {
  readProfiles, writeProfiles, storeContent, loadContent, deleteContent,
  readHistory, writeHistory, storeHistoryContent,
  loadHistoryContent as loadHistorySnap, deleteHistoryContent,
  validateTargetFile,
} from './storage'
import { parseEnvContent } from './envParser'
import type { EnvProfileMeta, EnvHistoryEntry, ValidationResult, VariableSearchResult } from './types'

export class ProfileManager {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /** Returns profile metadata only. Content is never included here. */
  async list(): Promise<EnvProfileMeta[]> {
    return readProfiles(this.ctx)
  }

  async create(name: string, targetFile: string, content: string): Promise<EnvProfileMeta> {
    const nameClean = name.trim()
    if (!nameClean) throw new Error('Profile name cannot be empty')
    if (nameClean.length > 100) throw new Error('Profile name must be 100 characters or less')

    const targetClean = targetFile.trim()
    const validationError = validateTargetFile(targetClean)
    if (validationError) throw new Error(validationError)

    const profiles = await readProfiles(this.ctx)
    if (profiles.some((p) => p.name.toLowerCase() === nameClean.toLowerCase())) {
      throw new Error(`A profile named "${nameClean}" already exists`)
    }

    const meta: EnvProfileMeta = {
      id: crypto.randomUUID(),
      name: nameClean,
      targetFile: path.normalize(targetClean),
      isActive: false,
      createdAt: new Date().toISOString(),
    }

    // Store content in OS keychain — never written to disk in plaintext
    await storeContent(this.ctx, meta.id, content)
    await writeProfiles(this.ctx, [...profiles, meta])
    return meta
  }

  async activate(id: string): Promise<void> {
    const profiles = await readProfiles(this.ctx)
    const profile = profiles.find((p) => p.id === id)
    if (!profile) throw new Error('Profile not found')

    const previousActive = profiles.find((p) => p.isActive && p.id !== id)
    if (previousActive) {
      await this.syncFromWorkspace(previousActive.id)
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri
    if (!workspaceRoot) throw new Error('No workspace folder is open')

    // Re-validate path at activation time (defence in depth)
    const validationError = validateTargetFile(profile.targetFile)
    if (validationError) throw new Error(`Invalid target file: ${validationError}`)

    await this.warnIfNotGitignored(workspaceRoot, profile.targetFile)

    // Load content from OS keychain only at the moment of writing
    const content = await loadContent(this.ctx, id)
    const targetUri = vscode.Uri.joinPath(workspaceRoot, profile.targetFile)
    await this.ensureSafeTargetPath(workspaceRoot, profile.targetFile)
    await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(content))

    const updated = profiles.map((p) => ({ ...p, isActive: p.id === id }))
    await writeProfiles(this.ctx, updated)
  }

  async updateContent(id: string, content: string): Promise<void> {
    const profiles = await readProfiles(this.ctx)
    const profile = profiles.find((p) => p.id === id)
    if (!profile) throw new Error('Profile not found')
    const previous = await loadContent(this.ctx, id)
    await this.saveToHistory(id, previous, 'saved')
    await storeContent(this.ctx, id, content)

    // Keep workspace file in sync when editing the currently active profile.
    if (profile.isActive) {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri
      if (!workspaceRoot) throw new Error('No workspace folder is open')

      const validationError = validateTargetFile(profile.targetFile)
      if (validationError) throw new Error(`Invalid target file: ${validationError}`)

      const targetUri = vscode.Uri.joinPath(workspaceRoot, profile.targetFile)
      await this.ensureSafeTargetPath(workspaceRoot, profile.targetFile)
      await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(content))
    }
  }

  async syncFromWorkspace(id: string): Promise<boolean> {
    const profiles = await readProfiles(this.ctx)
    const profile = profiles.find((p) => p.id === id)
    if (!profile) throw new Error('Profile not found')

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri
    if (!workspaceRoot) throw new Error('No workspace folder is open')

    const validationError = validateTargetFile(profile.targetFile)
    if (validationError) throw new Error(`Invalid target file: ${validationError}`)

    await this.ensureSafeTargetPath(workspaceRoot, profile.targetFile)

    const targetUri = vscode.Uri.joinPath(workspaceRoot, profile.targetFile)
    let content = ''
    try {
      const bytes = await vscode.workspace.fs.readFile(targetUri)
      content = new TextDecoder().decode(bytes)
    } catch {
      return false
    }

    const previous = await loadContent(this.ctx, id)
    if (previous === content) return false

    await this.saveToHistory(id, previous, 'workspace edit')
    await storeContent(this.ctx, id, content)
    return true
  }

  async loadContent(id: string): Promise<string> {
    return loadContent(this.ctx, id)
  }

  async delete(id: string): Promise<void> {
    const profiles = await readProfiles(this.ctx)
    const filtered = profiles.filter((p) => p.id !== id)
    if (filtered.length === profiles.length) throw new Error('Profile not found')
    await writeProfiles(this.ctx, filtered)
    await deleteContent(this.ctx, id)
    // Clean up all history snapshots for this profile
    const allHistory = await readHistory(this.ctx)
    const profileHistory = allHistory.filter((h) => h.profileId === id)
    await Promise.all(profileHistory.map((h) => deleteHistoryContent(this.ctx, h.id)))
    await writeHistory(this.ctx, allHistory.filter((h) => h.profileId !== id))
  }

  async getActive(): Promise<EnvProfileMeta | undefined> {
    const profiles = await readProfiles(this.ctx)
    return profiles.find((p) => p.isActive)
  }

  async getHistory(profileId: string): Promise<EnvHistoryEntry[]> {
    const allHistory = await readHistory(this.ctx)
    return allHistory
      .filter((h) => h.profileId === profileId)
      .sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime())
  }

  async loadHistoryContent(historyId: string): Promise<string> {
    return loadHistorySnap(this.ctx, historyId)
  }

  async restoreFromHistory(historyId: string): Promise<void> {
    const allHistory = await readHistory(this.ctx)
    const entry = allHistory.find((h) => h.id === historyId)
    if (!entry) throw new Error('History entry not found')
    // Load historical content FIRST before any potential trim in saveToHistory
    const historical = await loadHistorySnap(this.ctx, historyId)
    const current = await loadContent(this.ctx, entry.profileId)
    await this.saveToHistory(entry.profileId, current, 'before restore')
    await storeContent(this.ctx, entry.profileId, historical)

    // If the restored profile is active, reflect the restore in the target file now.
    const profiles = await readProfiles(this.ctx)
    const profile = profiles.find((p) => p.id === entry.profileId)
    if (profile?.isActive) {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri
      if (!workspaceRoot) throw new Error('No workspace folder is open')

      const validationError = validateTargetFile(profile.targetFile)
      if (validationError) throw new Error(`Invalid target file: ${validationError}`)

      const targetUri = vscode.Uri.joinPath(workspaceRoot, profile.targetFile)
      await this.ensureSafeTargetPath(workspaceRoot, profile.targetFile)
      await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(historical))
    }
  }

  async validateAgainstExample(profileId: string): Promise<ValidationResult> {
    const profiles = await readProfiles(this.ctx)
    const profile = profiles.find((p) => p.id === profileId)
    if (!profile) throw new Error('Profile not found')

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri
    if (!workspaceRoot) throw new Error('No workspace folder is open')

    const exampleFile = path.normalize(
      path.join(path.dirname(profile.targetFile), '.env.example'),
    )
    let exampleContent = ''
    let exampleFound = true
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(workspaceRoot, exampleFile),
      )
      exampleContent = new TextDecoder().decode(bytes)
    } catch {
      exampleFound = false
    }

    const profileContent = await loadContent(this.ctx, profileId)
    const profileVars = parseEnvContent(profileContent)
    const exampleVars = parseEnvContent(exampleContent)

    return {
      exampleFile,
      exampleFound,
      missing: [...exampleVars.keys()].filter((k) => !profileVars.has(k)),
      extra: [...profileVars.keys()].filter((k) => !exampleVars.has(k)),
      empty: [...profileVars.entries()].filter(([, v]) => v === '').map(([k]) => k),
    }
  }

  async searchVariable(varName: string): Promise<VariableSearchResult[]> {
    const profiles = await readProfiles(this.ctx)
    const results: VariableSearchResult[] = []
    for (const profile of profiles) {
      const content = await loadContent(this.ctx, profile.id)
      const vars = parseEnvContent(content)
      const value = vars.get(varName)
      results.push({
        profileId: profile.id,
        profileName: profile.name,
        targetFile: profile.targetFile,
        isActive: profile.isActive,
        found: value !== undefined,
        value,
      })
    }
    return results
  }

  async getAllVariableNames(): Promise<string[]> {
    const profiles = await readProfiles(this.ctx)
    const allKeys = new Set<string>()
    for (const profile of profiles) {
      const content = await loadContent(this.ctx, profile.id)
      for (const key of parseEnvContent(content).keys()) allKeys.add(key)
    }
    return [...allKeys].sort()
  }

  private async saveToHistory(profileId: string, content: string, label: string): Promise<void> {
    const MAX_HISTORY = 5
    const allHistory = await readHistory(this.ctx)
    const profileHistory = allHistory
      .filter((h) => h.profileId === profileId)
      .sort((a, b) => new Date(a.savedAt).getTime() - new Date(b.savedAt).getTime())
    const excess = profileHistory.length - MAX_HISTORY + 1
    const toRemove = excess > 0 ? profileHistory.slice(0, excess) : []
    await Promise.all(toRemove.map((h) => deleteHistoryContent(this.ctx, h.id)))
    const removeIds = new Set(toRemove.map((h) => h.id))
    const newEntry: EnvHistoryEntry = {
      id: crypto.randomUUID(),
      profileId,
      savedAt: new Date().toISOString(),
      label,
    }
    await storeHistoryContent(this.ctx, newEntry.id, content)
    await writeHistory(this.ctx, [
      ...allHistory.filter((h) => !removeIds.has(h.id)),
      newEntry,
    ])
  }

  /**
   * Prevent writes outside workspace via symbolic links or path tricks.
   * This check is only applicable to local file-system workspaces.
   */
  private async ensureSafeTargetPath(workspaceRoot: vscode.Uri, targetFile: string): Promise<void> {
    if (workspaceRoot.scheme !== 'file') return

    const workspacePath = workspaceRoot.fsPath
    const targetPath = path.resolve(workspacePath, targetFile)
    const relative = path.relative(workspacePath, targetPath)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Target path must remain inside the workspace root')
    }

    const workspaceReal = await fs.realpath(workspacePath)
    const targetParentPath = path.dirname(targetPath)

    let targetStat: Awaited<ReturnType<typeof fs.lstat>> | undefined
    try {
      targetStat = await fs.lstat(targetPath)
    } catch {
      targetStat = undefined
    }

    if (targetStat?.isSymbolicLink()) {
      throw new Error('Refusing to write to a symbolic link target')
    }

    const pathToResolve = targetStat ? targetPath : targetParentPath
    const resolved = await fs.realpath(pathToResolve)
    const inside = resolved === workspaceReal || resolved.startsWith(`${workspaceReal}${path.sep}`)
    if (!inside) {
      throw new Error('Refusing to write outside workspace (possible symbolic link path)')
    }
  }

  private async warnIfNotGitignored(workspaceRoot: vscode.Uri, targetFile: string): Promise<void> {
    try {
      const gitignoreUri = vscode.Uri.joinPath(workspaceRoot, '.gitignore')
      const bytes = await vscode.workspace.fs.readFile(gitignoreUri)
      const gitignoreText = new TextDecoder().decode(bytes)
      // Line-level matching — avoids false negatives from substring matches
      // e.g. ".env.local" must not suppress the warning for ".env"
      const lines = gitignoreText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'))
      const basename = path.basename(targetFile)
      const isIgnored = lines.some(
        (l) => l === basename || l === targetFile || l === `/${targetFile}`,
      )
      if (!isIgnored) {
        vscode.window.showWarningMessage(
          `"${targetFile}" may not be in .gitignore. Avoid committing env secrets.`,
        )
      }
    } catch {
      vscode.window.showWarningMessage(
        `No .gitignore found. Ensure "${targetFile}" is never committed to version control.`,
      )
    }
  }
}
