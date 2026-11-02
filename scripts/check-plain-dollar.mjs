#!/usr/bin/env node
// Lists every use of `$`, the first parameter of a hook, that the Claude plugin directory would not
// read as plain (MOD_CAPABILITY_USE_NOT_PLAIN). Run from the repository root:
//   node scripts/check-plain-dollar.mjs
// Rules, taken from the directory's message and from the findings on v0.8.0 and v0.8.1:
//   - `$` is written only as $.noun.method(...) (no ?., !, cast, parentheses, [], destructuring, bind), or passed
//     bare as one whole argument to a function declared at the top of the same file (a `function` declaration,
//     not a const arrow), with no type arguments on the call.
//   - No variable, parameter, catch variable or inner function anywhere in the file may share a name with such a
//     top-level function (the directory reads the name as the top-level function everywhere, so a local
//     `const choices` made every `choices($)` call look like something else: the v0.8.1 findings).
//   - No local named `$` except the hook's parameter and top-level functions' first parameter.
//   - No destructuring into `_`: `const { rate: _, ...rest } = band` was read as a non-plain use of $ (the v0.8.2
//     findings). A parameter named `_`, as in `.catch((_, e, next) => next(e))`, was not flagged.
//   - A hook is any function passed to `on(...)`, whatever its first parameter is called (`$`, `ctx`, `_$`). The directory
//     reads every hook's first-parameter name as the capability object throughout the file, so each such name is held to
//     the same rules as `$`: no other declaration of it, and no use except $.noun.method(...) or a whole argument to a
//     top-level function (v0.8.3 follow-up: hooks/testkit.ts used `ctx` and `_$` in casts and arrow helpers).
//   - Every `on` in a file that declares a hook must be `on('literal', fn)` or `on('literal', {matcher}, fn)` called
//     directly: no cast, alias, argument, local named `on` (the one allowed declaration is the `register` function's
//     own first parameter), and no registration inside a loop (the engine reports it as `config.set{key=?}`).
// With --strict it also lists uses we only suspect: $ inside a nested function, calls passing $ nested in
// another expression, and reads such as $.plugin.root.
// It needs the TypeScript package (version 6 or older). It looks in TYPESCRIPT_DIR, the repo, then the global npm folder.
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hooksDir = join(root, 'plugins/rightsize/hooks')

function loadTypeScript() {
  // Needs a typescript package with the JavaScript API (version 6 or older; 7 is a native binary).
  const bases = [process.env.TYPESCRIPT_DIR, root]
  try { bases.push(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'typescript')) } catch {}
  for (const base of bases.filter(Boolean)) {
    for (const spec of [base, join(base, 'node_modules/typescript')]) {
      try {
        const m = createRequire(join(root, 'noop.js'))(spec)
        if (m && m.createSourceFile) return m
      } catch {}
    }
  }
  console.error('check-plain-dollar: no typescript package with the JavaScript API found.\n' +
    'Run: npm install --no-save typescript@5   (from the repository root), or set TYPESCRIPT_DIR to a typescript folder.')
  process.exit(2)
}
const ts = loadTypeScript()

const strict = process.argv.includes('--strict')
const args = process.argv.slice(2).filter(a => a !== '--strict')
// Every source file in hooks/, tests included: a file that registers no hook is skipped, as before.
const files = args.length
  ? args
  : readdirSync(hooksDir).filter(f => /\.tsx?$/.test(f)).map(f => join(hooksDir, f))

const isFn = n => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)

function check(file) {
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const problems = []
  const topFns = new Set()
  for (const s of sf.statements) if (ts.isFunctionDeclaration(s) && s.name) topFns.add(s.name.text)

  // A hook callback is a function that is an argument of a call `on(...)`.
  const isHook = n => isFn(n) && !ts.isFunctionDeclaration(n) && ts.isCallExpression(n.parent) && ts.isIdentifier(n.parent.expression) && n.parent.expression.text === 'on' && n.parent.arguments.includes(n)
  // The first-parameter names of the hooks: `$`, and whatever else a file calls it.
  const hookNames = new Set()
  let declaresHook = false
  ;(function find(n) {
    if (isHook(n)) {
      declaresHook = true
      const first = n.parameters[0]?.name
      if (first && ts.isIdentifier(first)) hookNames.add(first.text)
    }
    ts.forEachChild(n, find)
  })(sf)
  if (!declaresHook) return { declaresHook, problems }
  hookNames.add('$')

  const report = (n, kind, why) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart())
    problems.push({ line: line + 1, col: character + 1, kind, why, src: text.split('\n')[line].trim().slice(0, 140) })
  }
  const owner = n => { for (let p = n.parent; p; p = p.parent) if (isFn(p)) return p }
  const topFn = f => f && ts.isFunctionDeclaration(f) && f.parent === sf
  const hookFn = f => f && isHook(f)

  const bindingNames = name => {
    if (ts.isIdentifier(name)) return [name]
    return name.elements.flatMap(e => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)))
  }
  ;(function visit(n) {
    if (ts.isIdentifier(n) && hookNames.has(n.text) && !isPropertyName(n)) classify(n)
    if (ts.isIdentifier(n) && n.text === 'on' && !isPropertyName(n)) checkOn(n)
    let names = []
    if (ts.isParameter(n) || ts.isVariableDeclaration(n)) names = bindingNames(n.name)
    else if ((ts.isFunctionExpression(n) || ts.isClassExpression(n)) && n.name) names = [n.name]
    else if (ts.isFunctionDeclaration(n) && n.name && n.parent !== sf) names = [n.name]
    else if (ts.isClassDeclaration(n) && n.name) names = [n.name]
    for (const id of names)
      if (id.text === '_' && ts.isBindingElement(id.parent)) report(id, 'destructure-_', 'destructuring into _, which the directory reads as a use of $')
      else if (topFns.has(id.text)) report(id, 'shadow', `a local named ${id.text} hides the top-level function ${id.text}, so ${id.text}($) is not read as a call to it`)
    ts.forEachChild(n, visit)
  })(sf)

  // `x.name`, `{ name: 1 }`, `{ name() {} }`, `type T = { name: string }`: not a variable, so not a use of the name.
  function isPropertyName(id) {
    const p = id.parent
    return ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && (p.name ?? p.right) === id) ||
      ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === id) ||
      (ts.isBindingElement(p) && p.propertyName === id)
  }

  // `on` must be the registration function called directly with a literal event, nothing wrapped around it.
  function checkOn(id) {
    const p = id.parent
    if (ts.isParameter(p) && p.name === id) {
      // `export const register: Register = (on, options) => ...` is where `on` comes from.
      const f = p.parent
      const decl = f.parent
      if (f.parameters[0] === p && ts.isArrowFunction(f) && ts.isVariableDeclaration(decl) && decl.name.getText() === 'register' && decl.parent.parent.parent === sf) return
      return report(id, 'local-on', 'a parameter or variable named on other than the first parameter of `register`')
    }
    if (ts.isCallExpression(p) && p.expression === id) {
      const [event, second, third] = p.arguments
      const literal = event && (ts.isStringLiteral(event) || ts.isNoSubstitutionTemplateLiteral(event))
      const fn = x => x && (ts.isArrowFunction(x) || ts.isFunctionExpression(x))
      const shape = p.arguments.length === 2 ? fn(second) : p.arguments.length === 3 && ts.isObjectLiteralExpression(second) && fn(third)
      if (!literal || !shape) return report(id, 'on-shape', "on(...) is not on('literal', hook) or on('literal', { matcher }, hook)")
      if (p.questionDotToken || p.typeArguments?.length) return report(id, 'on-shape', 'on(...) called with ?. or type arguments')
      for (let a = p.parent; a && a !== sf; a = a.parent) {
        if (isFn(a)) break
        if (ts.isForStatement(a) || ts.isForOfStatement(a) || ts.isForInStatement(a) || ts.isWhileStatement(a) || ts.isDoStatement(a))
          return report(id, 'loop-hook', 'a hook registered inside a loop (the directory sees one hook with a computed matcher)')
      }
      return
    }
    report(id, 'on-use', 'on used other than as a direct call on(...) (a cast, alias, argument or local)')
  }

  function classify(id) {
    const p = id.parent
    // A declaration named $.
    if (ts.isParameter(p) && p.name === id) {
      const f = p.parent
      const first = f.parameters[0] === p
      if (first && (hookFn(f) || topFn(f))) return
      return report(id, 'local-$', 'a variable or parameter named $ other than the hook parameter or a top-level function parameter')
    }
    if ((ts.isVariableDeclaration(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isPropertyAssignment(p) && p.name === id) && p.name === id)
      return report(id, 'local-$', 'a declaration named $')
    if (ts.isShorthandPropertyAssignment(p)) return report(id, 'shorthand', '$ in a shorthand property')
    // A use. It must sit directly in the hook callback or a top-level function, not in a nested function.
    const f = owner(id)
    if (!(hookFn(f) || topFn(f))) return strict && report(id, 'closure', '(strict) $ used inside a nested function (arrow, callback or inner function)')

    // $.noun.method(...)
    if (ts.isPropertyAccessExpression(p) && p.expression === id) {
      if (p.questionDotToken) return report(id, 'optional', '?. on $')
      const q = p.parent
      if (ts.isPropertyAccessExpression(q) && q.expression === p) {
        if (q.questionDotToken) return report(id, 'optional', '?. after $.noun')
        const c = q.parent
        if (ts.isCallExpression(c) && c.expression === q && !c.questionDotToken) return
        if (ts.isCallExpression(c) && c.expression === q) return report(id, 'optional', '?. call on $.noun.method')
        return strict && report(id, 'read', '(strict) $.noun.method is read, not called')
      }
      return strict && report(id, 'read', '(strict) $.noun.property is read, not called')
    }
    // f($, ...): one whole argument of a top-level function declared in this file.
    if (ts.isCallExpression(p) && p.arguments.includes(id)) {
      const callee = p.expression
      if (!ts.isIdentifier(callee) || !topFns.has(callee.text)) return report(id, 'bad-callee', '$ passed to something that is not a top-level function of this file')
      if (p.questionDotToken) return report(id, 'optional', '?. call')
      let call = p, up = call.parent
      if (ts.isAwaitExpression(up)) { call = up; up = call.parent }
      const ok = ts.isExpressionStatement(up) || ts.isReturnStatement(up) ||
        (ts.isVariableDeclaration(up) && up.initializer === call) ||
        (ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.EqualsToken && up.right === call && ts.isExpressionStatement(up.parent))
      if (p.typeArguments?.length) return report(id, 'type-args', 'call passing $ has type arguments')
      if (!ok && strict) return report(id, 'nested-call', '(strict) call passing $ is nested inside another expression (' + ts.SyntaxKind[up.kind] + ')')
      return
    }
    report(id, 'other', '$ used in a way other than $.noun.method(...) or f($, ...) (' + ts.SyntaxKind[p.kind] + ')')
  }
  return { declaresHook, problems }
}

let total = 0
for (const file of files) {
  const { declaresHook, problems } = check(file)
  if (!declaresHook) continue
  const rel = file.startsWith(root) ? file.slice(root.length + 1) : file
  for (const p of problems) console.log(`${rel}:${p.line}:${p.col}  [${p.kind}] ${p.why}\n    ${p.src}`)
  total += problems.length
  if (!problems.length) console.log(`${rel}: ok`)
}
if (total) { console.log(`\n${total} non-plain use(s) of $`); process.exit(1) }
