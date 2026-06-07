import { TextEncoder, TextDecoder } from 'util'
import * as vscode from 'vscode'
import {
  validateTargetFile,
  isValidProfileMeta,
  isValidHistoryEntry,
  readProfiles,
  readHistory,
} from '../storage'

// ── validateTargetFile ──────────────────────────────────────────────────────

describe('validateTargetFile', () => {
  describe('valid paths', () => {
    it('accepts .env',                  () => expect(validateTargetFile('.env')).toBeNull())
    it('accepts .env.local',            () => expect(validateTargetFile('.env.local')).toBeNull())
    it('accepts .env.development',      () => expect(validateTargetFile('.env.development')).toBeNull())
    it('accepts .env.staging',          () => expect(validateTargetFile('.env.staging')).toBeNull())
    it('accepts nested path',           () => expect(validateTargetFile('apps/api/.env')).toBeNull())
    it('accepts deeply nested path',    () => expect(validateTargetFile('a/b/c/.env.local')).toBeNull())
    it('strips leading/trailing space', () => expect(validateTargetFile('  .env  ')).toBeNull())
  })

  describe('invalid paths', () => {
    it('rejects empty string',          () => expect(validateTargetFile('')).not.toBeNull())
    it('rejects whitespace only',       () => expect(validateTargetFile('   ')).not.toBeNull())
    it('rejects absolute path',         () => expect(validateTargetFile('/etc/.env')).not.toBeNull())
    it('rejects simple traversal',      () => expect(validateTargetFile('../.env')).not.toBeNull())
    it('rejects nested traversal',      () => expect(validateTargetFile('sub/../../.env')).not.toBeNull())
    it('rejects non-.env filename',     () => expect(validateTargetFile('config.txt')).not.toBeNull())
    it('rejects env without dot prefix',() => expect(validateTargetFile('envfile')).not.toBeNull())
    it('rejects .environment',          () => expect(validateTargetFile('.environment')).not.toBeNull())
  })

  describe('glob injection protection (security)', () => {
    it('rejects * wildcard',              () => expect(validateTargetFile('.env.*')).not.toBeNull())
    it('rejects ? wildcard',              () => expect(validateTargetFile('.env.?oc')).not.toBeNull())
    it('rejects [ character class',       () => expect(validateTargetFile('.env.[dev]')).not.toBeNull())
    it('rejects { brace expansion',       () => expect(validateTargetFile('.env.{dev,prod}')).not.toBeNull())
    it('rejects * in directory part',     () => expect(validateTargetFile('apps/*/.env')).not.toBeNull())
    it('rejects ** recursive glob',       () => expect(validateTargetFile('**/.env')).not.toBeNull())
    it('rejects ? in directory part',     () => expect(validateTargetFile('ap?s/.env')).not.toBeNull())
  })
})

// ── isValidProfileMeta ──────────────────────────────────────────────────────

describe('isValidProfileMeta', () => {
  const valid = {
    id: 'abc-123',
    name: 'dev',
    targetFile: '.env',
    isActive: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  }

  it('accepts a fully valid profile',              () => expect(isValidProfileMeta(valid)).toBe(true))
  it('accepts isActive = true',                    () => expect(isValidProfileMeta({ ...valid, isActive: true })).toBe(true))
  it('rejects null',                               () => expect(isValidProfileMeta(null)).toBe(false))
  it('rejects undefined',                          () => expect(isValidProfileMeta(undefined)).toBe(false))
  it('rejects plain string',                       () => expect(isValidProfileMeta('string')).toBe(false))
  it('rejects array',                              () => expect(isValidProfileMeta([])).toBe(false))
  it('rejects empty id',                           () => expect(isValidProfileMeta({ ...valid, id: '' })).toBe(false))
  it('rejects id over 128 chars',                  () => expect(isValidProfileMeta({ ...valid, id: 'x'.repeat(129) })).toBe(false))
  it('accepts id of exactly 128 chars',            () => expect(isValidProfileMeta({ ...valid, id: 'x'.repeat(128) })).toBe(true))
  it('rejects empty name',                         () => expect(isValidProfileMeta({ ...valid, name: '' })).toBe(false))
  it('rejects name over 100 chars',                () => expect(isValidProfileMeta({ ...valid, name: 'x'.repeat(101) })).toBe(false))
  it('accepts name of exactly 100 chars',          () => expect(isValidProfileMeta({ ...valid, name: 'x'.repeat(100) })).toBe(true))
  it('rejects empty targetFile',                   () => expect(isValidProfileMeta({ ...valid, targetFile: '' })).toBe(false))
  it('rejects isActive as string "true"',          () => expect(isValidProfileMeta({ ...valid, isActive: 'true' })).toBe(false))
  it('rejects isActive as number 1',               () => expect(isValidProfileMeta({ ...valid, isActive: 1 })).toBe(false))
  it('rejects missing createdAt',                  () => { const { createdAt, ...rest } = valid; expect(isValidProfileMeta(rest)).toBe(false) })
  it('rejects non-string createdAt',               () => expect(isValidProfileMeta({ ...valid, createdAt: 12345 })).toBe(false))
})

// ── isValidHistoryEntry ─────────────────────────────────────────────────────

describe('isValidHistoryEntry', () => {
  const valid = {
    id: 'hist-abc',
    profileId: 'prof-xyz',
    savedAt: '2026-01-01T00:00:00.000Z',
    label: 'saved',
  }

  it('accepts a fully valid entry',             () => expect(isValidHistoryEntry(valid)).toBe(true))
  it('accepts empty label',                     () => expect(isValidHistoryEntry({ ...valid, label: '' })).toBe(true))
  it('rejects null',                            () => expect(isValidHistoryEntry(null)).toBe(false))
  it('rejects undefined',                       () => expect(isValidHistoryEntry(undefined)).toBe(false))
  it('rejects empty id',                        () => expect(isValidHistoryEntry({ ...valid, id: '' })).toBe(false))
  it('rejects id over 128 chars',               () => expect(isValidHistoryEntry({ ...valid, id: 'x'.repeat(129) })).toBe(false))
  it('accepts id of exactly 128 chars',         () => expect(isValidHistoryEntry({ ...valid, id: 'x'.repeat(128) })).toBe(true))
  it('rejects empty profileId',                 () => expect(isValidHistoryEntry({ ...valid, profileId: '' })).toBe(false))
  it('rejects profileId over 128 chars',        () => expect(isValidHistoryEntry({ ...valid, profileId: 'x'.repeat(129) })).toBe(false))
  it('rejects empty savedAt',                   () => expect(isValidHistoryEntry({ ...valid, savedAt: '' })).toBe(false))
  it('rejects savedAt over 64 chars',           () => expect(isValidHistoryEntry({ ...valid, savedAt: 'x'.repeat(65) })).toBe(false))
  it('accepts savedAt of exactly 64 chars',     () => expect(isValidHistoryEntry({ ...valid, savedAt: 'x'.repeat(64) })).toBe(true))
  it('rejects label over 128 chars',            () => expect(isValidHistoryEntry({ ...valid, label: 'x'.repeat(129) })).toBe(false))
  it('rejects non-string label',                () => expect(isValidHistoryEntry({ ...valid, label: 42 })).toBe(false))
})

// ── readProfiles (integrity / error handling) ───────────────────────────────

const makeCtx = () => ({
  storageUri: vscode.Uri.parse('mock://storage'),
  secrets: { store: jest.fn(), get: jest.fn(), delete: jest.fn() },
} as unknown as vscode.ExtensionContext)

const enc = new TextEncoder()
const mockReadFile = () => vscode.workspace.fs.readFile as jest.Mock

describe('readProfiles', () => {
  it('returns [] when file does not exist', async () => {
    mockReadFile().mockRejectedValueOnce(new Error('FileNotFound'))
    expect(await readProfiles(makeCtx())).toEqual([])
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
  })

  it('returns [] and warns when JSON is malformed', async () => {
    mockReadFile().mockResolvedValueOnce(enc.encode('not-json{{{'))
    expect(await readProfiles(makeCtx())).toEqual([])
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('malformed'),
    )
  })

  it('returns [] and warns when JSON is valid but not an array', async () => {
    mockReadFile().mockResolvedValueOnce(enc.encode(JSON.stringify({ id: 'x' })))
    expect(await readProfiles(makeCtx())).toEqual([])
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('unexpected format'),
    )
  })

  it('silently filters out invalid entries without a warning', async () => {
    const bad = [{ id: '', name: 'dev', targetFile: '.env', isActive: false, createdAt: 'x' }]
    mockReadFile().mockResolvedValueOnce(enc.encode(JSON.stringify(bad)))
    expect(await readProfiles(makeCtx())).toEqual([])
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
  })

  it('returns valid profiles', async () => {
    const profile = { id: 'abc', name: 'dev', targetFile: '.env', isActive: false, createdAt: '2026-01-01' }
    mockReadFile().mockResolvedValueOnce(enc.encode(JSON.stringify([profile])))
    const result = await readProfiles(makeCtx())
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('dev')
  })
})

describe('readHistory', () => {
  it('returns [] when file does not exist', async () => {
    mockReadFile().mockRejectedValueOnce(new Error('FileNotFound'))
    expect(await readHistory(makeCtx())).toEqual([])
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
  })

  it('returns [] and warns when JSON is malformed', async () => {
    mockReadFile().mockResolvedValueOnce(enc.encode('{{invalid'))
    expect(await readHistory(makeCtx())).toEqual([])
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('malformed'),
    )
  })

  it('returns valid entries', async () => {
    const entry = { id: 'h1', profileId: 'p1', savedAt: '2026-01-01', label: 'saved' }
    mockReadFile().mockResolvedValueOnce(enc.encode(JSON.stringify([entry])))
    const result = await readHistory(makeCtx())
    expect(result).toHaveLength(1)
    expect(result[0].label).toBe('saved')
  })
})
