import * as vscode from 'vscode'
import * as path from 'path'
import { TextDecoder, TextEncoder } from 'util'
import type { EnvProfileMeta, EnvHistoryEntry } from './types'

const PROFILES_FILE = 'profiles.json'
const secretKey = (id: string): string => `profile-content:${id}`

function storageFileUri(ctx: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(ctx.storageUri!, PROFILES_FILE)
}

// ── Metadata (storageUri — plaintext, no secrets) ───────────────────────────

/** @internal exported for unit tests */
export function isValidProfileMeta(obj: unknown): obj is EnvProfileMeta {
  if (!obj || typeof obj !== 'object') return false
  const p = obj as Record<string, unknown>
  return (
    typeof p.id === 'string' && p.id.length > 0 && p.id.length <= 128 &&
    typeof p.name === 'string' && p.name.length > 0 && p.name.length <= 100 &&
    typeof p.targetFile === 'string' && p.targetFile.length > 0 &&
    typeof p.isActive === 'boolean' &&
    typeof p.createdAt === 'string'
  )
}

export async function readProfiles(ctx: vscode.ExtensionContext): Promise<EnvProfileMeta[]> {
  let bytes: Uint8Array = new Uint8Array()
  try {
    bytes = await vscode.workspace.fs.readFile(storageFileUri(ctx))
  } catch {
    return [] // File absent on first run — expected
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!Array.isArray(parsed)) {
      void vscode.window.showWarningMessage(
        'EnvSwitch: profiles.json has unexpected format. Your profiles may be missing.',
      )
      return []
    }
    return parsed.filter(isValidProfileMeta)
  } catch {
    void vscode.window.showWarningMessage(
      'EnvSwitch: profiles.json is malformed and could not be read.',
    )
    return []
  }
}

export async function writeProfiles(
  ctx: vscode.ExtensionContext,
  profiles: EnvProfileMeta[],
): Promise<void> {
  await vscode.workspace.fs.createDirectory(ctx.storageUri!)
  const bytes = new TextEncoder().encode(JSON.stringify(profiles, null, 2))
  await vscode.workspace.fs.writeFile(storageFileUri(ctx), bytes)
}

// ── Content (context.secrets — OS keychain encrypted) ───────────────────────

export async function storeContent(
  ctx: vscode.ExtensionContext,
  id: string,
  content: string,
): Promise<void> {
  await ctx.secrets.store(secretKey(id), content)
}

export async function loadContent(
  ctx: vscode.ExtensionContext,
  id: string,
): Promise<string> {
  return (await ctx.secrets.get(secretKey(id))) ?? ''
}

export async function deleteContent(
  ctx: vscode.ExtensionContext,
  id: string,
): Promise<void> {
  await ctx.secrets.delete(secretKey(id))
}

// ── History (storageUri metadata + context.secrets content) ─────────────────

const HISTORY_FILE = 'history.json'
const historyContentKey = (id: string): string => `history-content:${id}`

function historyFileUri(ctx: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(ctx.storageUri!, HISTORY_FILE)
}

/** @internal exported for unit tests */
export function isValidHistoryEntry(obj: unknown): obj is EnvHistoryEntry {
  if (!obj || typeof obj !== 'object') return false
  const h = obj as Record<string, unknown>
  return (
    typeof h.id === 'string' && h.id.length > 0 && h.id.length <= 128 &&
    typeof h.profileId === 'string' && h.profileId.length > 0 && h.profileId.length <= 128 &&
    typeof h.savedAt === 'string' && h.savedAt.length > 0 && h.savedAt.length <= 64 &&
    typeof h.label === 'string' && h.label.length <= 128
  )
}

export async function readHistory(ctx: vscode.ExtensionContext): Promise<EnvHistoryEntry[]> {
  let bytes: Uint8Array = new Uint8Array()
  try {
    bytes = await vscode.workspace.fs.readFile(historyFileUri(ctx))
  } catch {
    return [] // File absent on first run — expected
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!Array.isArray(parsed)) {
      void vscode.window.showWarningMessage(
        'EnvSwitch: history.json has unexpected format. Profile history may be missing.',
      )
      return []
    }
    return parsed.filter(isValidHistoryEntry)
  } catch {
    void vscode.window.showWarningMessage(
      'EnvSwitch: history.json is malformed and could not be read.',
    )
    return []
  }
}

export async function writeHistory(
  ctx: vscode.ExtensionContext,
  entries: EnvHistoryEntry[],
): Promise<void> {
  await vscode.workspace.fs.createDirectory(ctx.storageUri!)
  const bytes = new TextEncoder().encode(JSON.stringify(entries, null, 2))
  await vscode.workspace.fs.writeFile(historyFileUri(ctx), bytes)
}

export async function storeHistoryContent(
  ctx: vscode.ExtensionContext,
  id: string,
  content: string,
): Promise<void> {
  await ctx.secrets.store(historyContentKey(id), content)
}

export async function loadHistoryContent(
  ctx: vscode.ExtensionContext,
  id: string,
): Promise<string> {
  return (await ctx.secrets.get(historyContentKey(id))) ?? ''
}

export async function deleteHistoryContent(
  ctx: vscode.ExtensionContext,
  id: string,
): Promise<void> {
  await ctx.secrets.delete(historyContentKey(id))
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Returns an error message string if invalid, or null if valid.
 * Rules: relative path, within workspace, basename must match .env or .env.*
 */
export function validateTargetFile(filePath: string): string | null {
  const trimmed = filePath.trim()
  if (!trimmed) return 'Path cannot be empty'

  const normalized = path.normalize(trimmed)
  if (path.isAbsolute(normalized)) return 'Path must be relative to the workspace root'
  if (normalized.startsWith('..')) return 'Path must be within the workspace'

  // Block glob metacharacters — targetFile is used as a FileSystemWatcher glob pattern
  // and must always be a literal path to avoid watching unintended files.
  if (/[*?[\]{}]/.test(normalized)) {
    return 'Path must not contain glob characters (*, ?, [, ], {, })'
  }

  const basename = path.basename(normalized)
  if (!/^\.env(\..+)?$/.test(basename)) {
    return 'File must be named .env or .env.<suffix> (e.g. .env, .env.local)'
  }

  return null
}
