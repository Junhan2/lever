// Shell-style globs as regular expressions over whole paths, shared by glob() and the permission rules.

export const GLOB_CHARS = /[*?[{]/

export const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A glob as a RegExp over a whole path: `*` and `?` stay inside one folder, `**` crosses folders, `{a,b}` and
 * `[abc]` work. `*.ts` matches only at the top; use `**\/*.ts` for every folder. */
export function globToRegExp(pattern, { ignoreCase = false } = {}) {
  let source = ''
  let groups = 0
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const wholeSegment = (i === 0 || pattern[i - 1] === '/') && (pattern[i + 2] === '/' || pattern[i + 2] === undefined)
        if (wholeSegment && pattern[i + 2] === '/') {
          source += '(?:.*/)?'
          i += 2
        } else {
          source += wholeSegment ? '.*' : '[^/]*'
          i += 1
        }
      } else source += '[^/]*'
    } else if (c === '?') source += '[^/]'
    else if (c === '[' && pattern.indexOf(']', i + 2) !== -1) {
      const end = pattern.indexOf(']', i + 2)
      const body = pattern.slice(i + 1, end).replace(/\\/g, '\\\\')
      source += `[${body[0] === '!' ? `^${body.slice(1)}` : body}]`
      i = end
    } else if (c === '{') {
      source += '(?:'
      groups++
    } else if (c === '}' && groups > 0) {
      source += ')'
      groups--
    } else if (c === ',' && groups > 0) source += '|'
    else if (c === '\\' && i + 1 < pattern.length) source += escapeRegExp(pattern[++i])
    else source += escapeRegExp(c)
  }
  if (groups > 0) throw new TypeError(`Unclosed { in glob ${pattern}`)
  return new RegExp(`^${source}$`, ignoreCase ? 'i' : '')
}

/** The folder a glob can start listing from: the leading segments without glob characters. */
export function globRoot(pattern) {
  const parts = pattern.split('/')
  const fixed = []
  for (const part of parts.slice(0, -1)) {
    if (GLOB_CHARS.test(part)) break
    fixed.push(part)
  }
  const root = fixed.join('/')
  return root === '' && pattern.startsWith('/') ? '/' : root
}
