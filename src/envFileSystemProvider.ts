import * as vscode from 'vscode'
import { TextDecoder, TextEncoder } from 'util'

export const ENV_SCHEME = 'envswitch'

/**
 * In-memory virtual filesystem for editing env profiles.
 * Files live in memory only — never written to disk.
 * Cmd+S triggers writeFile, which persists to the OS keychain via the registered callback.
 */
export class EnvFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  readonly onDidChangeFile = this._onDidChangeFile.event

  /** In-memory file store: uri string → bytes */
  private readonly files = new Map<string, Uint8Array>()

  /** Save callbacks: uri string → async handler that persists to keychain */
  private readonly saveCallbacks = new Map<string, (content: string) => Promise<void>>()

  initFile(uri: vscode.Uri, content: string): void {
    this.files.set(uri.toString(), new TextEncoder().encode(content))
  }

  registerSaveCallback(uri: vscode.Uri, callback: (content: string) => Promise<void>): void {
    this.saveCallbacks.set(uri.toString(), callback)
  }

  cleanUp(uri: vscode.Uri): void {
    this.files.delete(uri.toString())
    this.saveCallbacks.delete(uri.toString())
  }

  // ── FileSystemProvider implementation ──────────────────────────────────────

  stat(uri: vscode.Uri): vscode.FileStat {
    const content = this.files.get(uri.toString())
    if (!content) throw vscode.FileSystemError.FileNotFound(uri)
    return {
      type: vscode.FileType.File,
      ctime: Date.now(),
      mtime: Date.now(),
      size: content.byteLength,
    }
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const content = this.files.get(uri.toString())
    if (!content) throw vscode.FileSystemError.FileNotFound(uri)
    return content
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const key = uri.toString()
    // Reject writes to diff/history URIs — they are read-only virtual views
    const path = uri.path
    if (path.startsWith('/diff/') || path.startsWith('/history/')) {
      throw vscode.FileSystemError.NoPermissions(uri)
    }
    const previous = this.files.get(key)
    this.files.set(key, content)

    const callback = this.saveCallbacks.get(key)
    if (callback) {
      try {
        await callback(new TextDecoder().decode(content))
      } catch (err) {
        // Revert in-memory state so it stays consistent with the keychain
        if (previous !== undefined) {
          this.files.set(key, previous)
        } else {
          this.files.delete(key)
        }
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }])
        throw err
      }
    }

    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }])
  }

  watch(_uri: vscode.Uri): vscode.Disposable {
    return new vscode.Disposable(() => {})
  }

  // Unsupported operations
  readDirectory(): [string, vscode.FileType][] { return [] }
  createDirectory(): void {}
  delete(uri: vscode.Uri): void { this.cleanUp(uri) }
  rename(): void { throw vscode.FileSystemError.NoPermissions('Rename not supported') }
}
