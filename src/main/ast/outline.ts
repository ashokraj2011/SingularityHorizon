import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import ts from 'typescript'

/**
 * Structural views of source files, built with the TypeScript compiler.
 *
 * The point is context economy. Attaching a file spends tokens proportional to
 * its length, but most questions only need its shape — what it exports, what
 * the signatures are, how the pieces relate. An outline delivers that at a
 * fraction of the size, and unlike a grep excerpt it is guaranteed to be
 * structurally complete: every export is present, none are half-quoted.
 *
 * TypeScript is used rather than tree-sitter because it is already a
 * dependency, needs no native module or WASM grammar, and covers TS/JS/TSX —
 * which is the bulk of what this is pointed at. Other languages return null and
 * the caller falls back to sending the file, so nothing silently degrades into
 * a wrong answer.
 */

const SUPPORTED = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

export function isOutlineSupported(path: string): boolean {
  return SUPPORTED.has(extname(path).toLowerCase())
}

function scriptKind(path: string): ts.ScriptKind {
  switch (extname(path).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX
    case '.jsx':
      return ts.ScriptKind.JSX
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS
    default:
      return ts.ScriptKind.TS
  }
}

export interface SymbolEntry {
  name: string
  kind: string
  line: number
  endLine: number
  exported: boolean
  /** The declaration signature, body stripped. */
  signature: string
  /** For class/interface members. */
  container?: string
}

export interface FileOutline {
  path: string
  symbols: SymbolEntry[]
  imports: string[]
  totalLines: number
}

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path))
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return !!mods?.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword
  )
}

/**
 * Declaration text with the implementation removed. For a function that means
 * everything up to `{`; for a type or interface there is no body to strip, so
 * the declaration is already the signature.
 */
function signatureOf(node: ts.Node, sf: ts.SourceFile): string {
  const text = node.getText(sf)
  const start = node.getStart(sf)

  // Classes and interfaces: header only. Their members are emitted separately,
  // so including the body here would print the whole declaration twice — which
  // made outlines of class-heavy files *larger* than the source.
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
    const brace = node.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.OpenBraceToken)
    if (brace) return collapse(text.slice(0, brace.getStart(sf) - start))
  }

  // Anything function-like: drop the implementation.
  const body = (node as { body?: ts.Node }).body
  if (body) return collapse(text.slice(0, body.getStart(sf) - start).trimEnd())

  // A property's initializer can be an arbitrarily large literal.
  if (ts.isPropertyDeclaration(node) && node.initializer) {
    return collapse(
      text
        .slice(0, node.initializer.getStart(sf) - start)
        .replace(/=\s*$/, '')
        .trimEnd()
    )
  }

  return collapse(text)
}

/** Signatures can wrap across many lines; one line each keeps outlines dense. */
function collapse(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

function nameOf(node: ts.Node, sf: ts.SourceFile): string | null {
  const named = node as { name?: ts.Node }
  if (named.name) return named.name.getText(sf)
  if (ts.isVariableStatement(node)) {
    const d = node.declarationList.declarations[0]
    return d?.name.getText(sf) ?? null
  }
  return null
}

export async function outlineFile(path: string): Promise<FileOutline | null> {
  if (!isOutlineSupported(path)) return null
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch {
    return null
  }
  return outlineSource(path, source)
}

export function outlineSource(path: string, source: string): FileOutline {
  const sf = parse(path, source)
  const symbols: SymbolEntry[] = []
  const imports: string[] = []

  const push = (
    node: ts.Node,
    name: string | null,
    kind: string,
    container?: string
  ): void => {
    if (!name) return
    symbols.push({
      name,
      kind,
      line: lineOf(sf, node.getStart(sf)),
      endLine: lineOf(sf, node.getEnd()),
      exported: isExported(node),
      signature: signatureOf(node, sf),
      container
    })
  }

  const visitMembers = (members: ts.NodeArray<ts.Node>, container: string): void => {
    for (const m of members) {
      if (ts.isMethodDeclaration(m) || ts.isMethodSignature(m)) {
        push(m, nameOf(m, sf), 'method', container)
      } else if (ts.isPropertyDeclaration(m) || ts.isPropertySignature(m)) {
        push(m, nameOf(m, sf), 'property', container)
      } else if (ts.isConstructorDeclaration(m)) {
        push(m, 'constructor', 'method', container)
      } else if (ts.isGetAccessor(m) || ts.isSetAccessor(m)) {
        push(m, nameOf(m, sf), 'accessor', container)
      }
    }
  }

  for (const node of sf.statements) {
    if (ts.isImportDeclaration(node)) {
      imports.push(collapse(node.getText(sf)))
      continue
    }
    if (ts.isFunctionDeclaration(node)) push(node, nameOf(node, sf), 'function')
    else if (ts.isClassDeclaration(node)) {
      const name = nameOf(node, sf)
      push(node, name, 'class')
      if (name) visitMembers(node.members, name)
    } else if (ts.isInterfaceDeclaration(node)) {
      const name = nameOf(node, sf)
      push(node, name, 'interface')
      if (name) visitMembers(node.members, name)
    } else if (ts.isTypeAliasDeclaration(node)) push(node, nameOf(node, sf), 'type')
    else if (ts.isEnumDeclaration(node)) push(node, nameOf(node, sf), 'enum')
    else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        const init = d.initializer
        const kind =
          init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
            ? 'function'
            : 'const'
        symbols.push({
          name: d.name.getText(sf),
          kind,
          line: lineOf(sf, node.getStart(sf)),
          endLine: lineOf(sf, node.getEnd()),
          exported: isExported(node),
          signature:
            kind === 'function' && init
              ? collapse(
                  `${isExported(node) ? 'export ' : ''}${d.name.getText(sf)}${signatureOfArrow(init, sf)}`
                )
              : collapse(d.getText(sf).split('=')[0].trim())
        })
      }
    }
  }

  return { path, symbols, imports, totalLines: sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1 }
}

function signatureOfArrow(init: ts.Node, sf: ts.SourceFile): string {
  const body = (init as { body?: ts.Node }).body
  const text = init.getText(sf)
  if (!body) return text
  const cut = body.getStart(sf) - init.getStart(sf)
  return text.slice(0, cut).replace(/=>\s*$/, '').trimEnd()
}

/** Renders an outline as the text that actually goes into the prompt. */
export function renderOutline(outline: FileOutline): string {
  const lines: string[] = [
    `// Structural outline of ${outline.path} (${outline.totalLines} lines)`,
    `// Signatures only — bodies omitted. Ask for the full file if you need one.`,
    ''
  ]

  if (outline.imports.length) {
    lines.push(...outline.imports.slice(0, 40))
    if (outline.imports.length > 40) lines.push(`// …${outline.imports.length - 40} more imports`)
    lines.push('')
  }

  let currentContainer: string | undefined
  for (const s of outline.symbols) {
    if (s.container !== currentContainer) {
      currentContainer = s.container
      if (currentContainer) lines.push('')
    }
    const indent = s.container ? '  ' : ''
    lines.push(`${indent}${s.signature}${s.container ? '' : ''}   // :${s.line}`)
  }

  return lines.join('\n')
}

/**
 * Extracts one symbol's full source — the basis for attaching a single function
 * instead of the file that contains it.
 */
export async function extractSymbol(
  path: string,
  name: string
): Promise<{ text: string; line: number; endLine: number; kind: string } | null> {
  if (!isOutlineSupported(path)) return null
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const sf = parse(path, source)
  const lines = source.split('\n')

  let found: { node: ts.Node; kind: string } | null = null
  const check = (node: ts.Node, kind: string): void => {
    if (found) return
    if (nameOf(node, sf) === name) found = { node, kind }
  }

  const walk = (node: ts.Node): void => {
    if (found) return
    if (ts.isFunctionDeclaration(node)) check(node, 'function')
    else if (ts.isClassDeclaration(node)) check(node, 'class')
    else if (ts.isInterfaceDeclaration(node)) check(node, 'interface')
    else if (ts.isTypeAliasDeclaration(node)) check(node, 'type')
    else if (ts.isEnumDeclaration(node)) check(node, 'enum')
    else if (ts.isMethodDeclaration(node)) check(node, 'method')
    else if (ts.isVariableDeclaration(node)) check(node, 'const')
    if (!found) ts.forEachChild(node, walk)
  }
  ts.forEachChild(sf, walk)
  if (!found) return null

  const node = (found as { node: ts.Node }).node
  const kind = (found as { kind: string }).kind
  const startLine = lineOf(sf, node.getStart(sf))
  const endLine = lineOf(sf, node.getEnd())
  return {
    text: lines.slice(startLine - 1, endLine).join('\n'),
    line: startLine,
    endLine,
    kind
  }
}

/** Symbol index across a set of files, for `@symbol` completion. */
export async function indexSymbols(
  paths: string[],
  query: string,
  limit = 40
): Promise<Array<SymbolEntry & { path: string }>> {
  const needle = query.toLowerCase()
  const out: Array<SymbolEntry & { path: string }> = []
  for (const path of paths) {
    if (out.length >= limit) break
    const outline = await outlineFile(path)
    if (!outline) continue
    for (const s of outline.symbols) {
      if (out.length >= limit) break
      // Top-level exports first-class; members reachable via Container.member.
      if (!needle || s.name.toLowerCase().includes(needle)) {
        out.push({ ...s, path })
      }
    }
  }
  // Exported, top-level symbols are almost always what someone means.
  return out.sort((a, b) => {
    const score = (s: SymbolEntry): number =>
      (s.exported ? 0 : 2) + (s.container ? 1 : 0) + (s.name.toLowerCase() === needle ? -4 : 0)
    return score(a) - score(b) || a.name.length - b.name.length
  })
}

export { basename }
