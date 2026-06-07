/** Metadata stored in plaintext (storageUri). Contains no secrets. */
export interface EnvProfileMeta {
  id: string
  name: string
  /** Relative path within workspace, e.g. ".env" or "apps/api/.env" */
  targetFile: string
  isActive: boolean
  createdAt: string
}

/** Full profile with content loaded from OS keychain (context.secrets). */
export interface EnvProfile extends EnvProfileMeta {
  /** Raw env file content — never log this value */
  content: string
}

/** A single historical snapshot of a profile's env content. */
export interface EnvHistoryEntry {
  id: string
  profileId: string
  savedAt: string
  label: string
}

/** Result of validating a profile against its .env.example file. */
export interface ValidationResult {
  exampleFile: string
  exampleFound: boolean
  missing: string[]   // in .env.example but absent in the profile
  extra: string[]     // in the profile but absent in .env.example
  empty: string[]     // key present but value is an empty string
}

/** Per-profile result of searching for a specific variable name. */
export interface VariableSearchResult {
  profileId: string
  profileName: string
  targetFile: string
  isActive: boolean
  found: boolean
  value: string | undefined
}
