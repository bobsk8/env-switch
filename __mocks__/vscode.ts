/**
 * Minimal manual mock for the VS Code extension API.
 * Used by Jest tests via moduleNameMapper.
 * Only the APIs exercised by the tested units need to be present.
 */

export const workspace = {
  fs: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    createDirectory: jest.fn(),
  },
}

export const window = {
  showWarningMessage: jest.fn(),
  showErrorMessage: jest.fn(),
  showInformationMessage: jest.fn(),
  setStatusBarMessage: jest.fn(),
}

export const Uri = {
  joinPath: jest.fn((_base: unknown, ...parts: string[]) => ({
    toString: () => parts.join('/'),
    path: parts.join('/'),
    fsPath: parts.join('/'),
  })),
  parse: jest.fn((str: string) => ({
    toString: () => str,
    path: str,
    fsPath: str,
  })),
}

export class FileSystemError extends Error {
  code: string = 'Unknown'
  constructor(msg?: string) {
    super(msg)
  }
  static FileNotFound = jest.fn((uri?: unknown): FileSystemError => {
    const e = new FileSystemError(`FileNotFound: ${String(uri)}`)
    e.code = 'FileNotFound'
    return e
  })
  static NoPermissions = jest.fn((uri?: unknown): FileSystemError => {
    const e = new FileSystemError(`NoPermissions: ${String(uri)}`)
    e.code = 'NoPermissions'
    return e
  })
}

export const FileChangeType = { Changed: 1, Created: 2, Deleted: 3 }
export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }
export const QuickPickItemKind = { Default: 0, Separator: -1 }

export class EventEmitter<T = void> {
  event = jest.fn()
  fire = jest.fn((_data?: T) => {})
  dispose = jest.fn()
}

export class Disposable {
  constructor(private _callOnDispose: () => void) {}
  dispose(): void { this._callOnDispose() }
  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => disposables.forEach(d => d.dispose()))
  }
}
