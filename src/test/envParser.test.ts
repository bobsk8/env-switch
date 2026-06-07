import { parseEnvContent } from '../envParser'

describe('parseEnvContent', () => {
  describe('basic parsing', () => {
    it('parses a simple key=value pair', () => {
      const r = parseEnvContent('FOO=bar')
      expect(r.get('FOO')).toBe('bar')
    })

    it('parses multiple entries', () => {
      const r = parseEnvContent('FOO=bar\nBAZ=qux')
      expect(r.get('FOO')).toBe('bar')
      expect(r.get('BAZ')).toBe('qux')
    })

    it('ignores blank lines', () => {
      expect(parseEnvContent('\n\nFOO=bar\n\n').size).toBe(1)
    })

    it('ignores comment lines starting with #', () => {
      const r = parseEnvContent('# comment\nFOO=bar')
      expect(r.size).toBe(1)
      expect(r.get('FOO')).toBe('bar')
    })

    it('strips the `export` prefix', () => {
      expect(parseEnvContent('export FOO=bar').get('FOO')).toBe('bar')
    })

    it('handles empty value', () => {
      expect(parseEnvContent('FOO=').get('FOO')).toBe('')
    })

    it('preserves = signs inside the value', () => {
      expect(parseEnvContent('FOO=bar=baz').get('FOO')).toBe('bar=baz')
    })

    it('trims whitespace around key', () => {
      expect(parseEnvContent('  FOO  =bar').get('FOO')).toBe('bar')
    })

    it('handles CRLF line endings', () => {
      const r = parseEnvContent('FOO=bar\r\nBAZ=qux')
      expect(r.get('FOO')).toBe('bar')
      expect(r.get('BAZ')).toBe('qux')
    })

    it('preserves spaces inside an unquoted value', () => {
      expect(parseEnvContent('FOO=hello world').get('FOO')).toBe('hello world')
    })
  })

  describe('quoted values', () => {
    it('strips surrounding double quotes', () => {
      expect(parseEnvContent('FOO="bar baz"').get('FOO')).toBe('bar baz')
    })

    it('strips surrounding single quotes', () => {
      expect(parseEnvContent("FOO='bar baz'").get('FOO')).toBe('bar baz')
    })

    it('strips surrounding backtick quotes', () => {
      expect(parseEnvContent('FOO=`bar baz`').get('FOO')).toBe('bar baz')
    })

    it('does not strip mismatched quotes', () => {
      expect(parseEnvContent('FOO="bar\'').get('FOO')).toBe('"bar\'')
    })

    it('handles single-character quoted string', () => {
      expect(parseEnvContent('FOO="a"').get('FOO')).toBe('a')
    })
  })

  describe('key validation', () => {
    it('accepts keys with uppercase letters', () => {
      expect(parseEnvContent('FOO_BAR=1').has('FOO_BAR')).toBe(true)
    })

    it('accepts keys starting with underscore', () => {
      expect(parseEnvContent('_SECRET=x').has('_SECRET')).toBe(true)
    })

    it('accepts keys with dots', () => {
      expect(parseEnvContent('FOO.BAR=x').has('FOO.BAR')).toBe(true)
    })

    it('accepts keys with digits after first char', () => {
      expect(parseEnvContent('VAR123=x').has('VAR123')).toBe(true)
    })

    it('rejects keys starting with a digit', () => {
      expect(parseEnvContent('1FOO=bar').has('1FOO')).toBe(false)
    })

    it('rejects keys with hyphens', () => {
      expect(parseEnvContent('FOO-BAR=baz').has('FOO-BAR')).toBe(false)
    })

    it('rejects keys with spaces', () => {
      expect(parseEnvContent('FOO BAR=baz').has('FOO BAR')).toBe(false)
    })

    it('ignores lines without = sign', () => {
      expect(parseEnvContent('FOOBAR').has('FOOBAR')).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('returns empty map for empty string', () => {
      expect(parseEnvContent('').size).toBe(0)
    })

    it('returns empty map for only comments', () => {
      expect(parseEnvContent('# comment\n# another').size).toBe(0)
    })

    it('does not lose entries between multiline files', () => {
      const r = parseEnvContent('A=1\nB=2\nC=3')
      expect([...r.keys()]).toEqual(['A', 'B', 'C'])
    })

    it('last duplicate key wins', () => {
      const r = parseEnvContent('FOO=first\nFOO=second')
      expect(r.get('FOO')).toBe('second')
    })
  })
})
