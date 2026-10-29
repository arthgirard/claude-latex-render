// Pure LaTeX helpers: finding math and TikZ figures in markdown, Unicode
// conversion, the documents a display formula or a figure is typeset in. No `$` here, so tests reach it all.

import type { Mode } from '../types'

export type Segment =
  | { kind: 'markdown'; text: string }
  // `source` is the line of inline math a lone formula was written as.
  | { kind: 'display'; tex: string; env?: string; source?: string }
  | { kind: 'figure'; tex: string }

const DISPLAY_ENVS = 'equation|align|gather|multline|eqnarray|flalign|alignat'

const FIGURE_ENVS = 'tikzpicture|tikzcd|axis'

// A line holding nothing but one inline formula is display math too: it is
// on a line of its own already, so drawing it as a picture costs no layout.
const DISPLAY = new RegExp(
  String.raw`\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\begin\{(${DISPLAY_ENVS})(\*?)\}([\s\S]*?)\\end\{\3\4\}` +
    String.raw`|\\begin\{(${FIGURE_ENVS})\}[\s\S]*?\\end\{\6\}` +
    String.raw`|^[ \t]*(?:\\\(((?:(?!\\\)).)+)\\\)|\$(?![\s$])([^$\n]+?)(?<![\s\\])\$)[ \t]*$`,
  'gm',
)

// A `$` glued to a digit or a letter before it, or a digit after it, is a
// price (`US$5`, `5$`, `$5-$10`), so `$n$th` and `_$x$_` are math and `$5-$10` is not.
const INLINE = /\\\((.+?)\\\)|(?<![\\$0-9A-Za-z])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![$\d])/g

// A number written as math, `$0$`, `$-3.5$` or `$1,000$`.
const NUMBER = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/

const FENCE = /^ {0,3}(`{3,}|~{3,})/

// A fenced block whose info string is `tikz` holds a figure.
const TIKZ_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*tikz[ \t]*$/m

// Private-use characters stand in for inline code spans while math is found.
const HOLE = ''

/**
 * The mode `/latex <args>` switches to from `current`: no argument flips it,
 * `render` or `source` (or `on` / `off`) sets it, anything else is undefined.
 */
export function nextMode(current: Mode, args: string): Mode | undefined {
  const word = args.trim().toLowerCase()
  if (word === '') return current === 'render' ? 'source' : 'render'
  if (word === 'render' || word === 'on') return 'render'
  if (word === 'source' || word === 'off') return 'source'
  return undefined
}

export function hasMath(text: string): boolean {
  return (
    text.includes('$') || text.includes('\\(') || text.includes('\\[') || text.includes('\\begin{') || TIKZ_FENCE.test(text)
  )
}

/**
 * Splits markdown into text, display-math and figure segments, leaving other
 * fenced code and inline code spans alone. Inline math stays in the text
 * segments. A figure is a closed ```tikz fence or a bare `tikzpicture`,
 * `tikzcd` or pgfplots `axis` environment.
 */
export function splitMath(text: string): Segment[] {
  const out: Segment[] = []
  const pushText = (chunk: string) => {
    if (chunk === '') return
    const last = out[out.length - 1]
    if (last?.kind === 'markdown') last.text += chunk
    else out.push({ kind: 'markdown', text: chunk })
  }

  for (const block of splitFences(text)) {
    if (block.isCode) {
      const figure = tikzFence(block.text)
      if (figure) out.push(figure)
      else pushText(block.text)
      continue
    }
    const { masked, spans } = maskCodeSpans(block.text)
    let at = 0
    for (const m of masked.matchAll(DISPLAY)) {
      const start = m.index ?? 0
      pushText(unmask(masked.slice(at, start), spans))
      if (m[6]) {
        out.push({ kind: 'figure', tex: unmask(m[0], spans).trim() })
        at = start + m[0].length
        continue
      }
      const lone = m[7] ?? m[8]
      if (lone !== undefined) {
        const tex = unmask(lone, spans).trim()
        // A number stays text, as it does inline.
        if (NUMBER.test(tex) || (m[8] !== undefined && /^[\d.,\s]+$/.test(tex))) pushText(unmask(m[0], spans))
        else out.push({ kind: 'display', tex, source: unmask(m[0], spans).trim() })
        at = start + m[0].length
        continue
      }
      const env = m[3]
      const tex = unmask(m[1] ?? m[2] ?? m[5] ?? '', spans).trim()
      if (tex === '') pushText(unmask(m[0], spans))
      else out.push(env ? { kind: 'display', tex, env: env + (m[4] ?? '') } : { kind: 'display', tex })
      at = start + m[0].length
    }
    pushText(unmask(masked.slice(at), spans))
  }

  return out
}

/**
 * How much of a reply still being written is settled: its length up to the
 * end of the line on which its last finished display formula or figure
 * closes, when nothing but spaces follows the close on that line; 0 when no
 * formula or figure has closed so. Math inside code is never a close.
 */
export function settledLength(text: string): number {
  let settled = 0
  let offset = 0
  for (const block of splitFences(text)) {
    if (block.isCode) {
      if (block.text.endsWith('\n') && tikzFence(block.text)) settled = offset + block.text.length
    } else {
      // Code spans keep their length, so offsets in the masked text hold in the reply.
      const masked = block.text.replace(/(`+)[\s\S]*?\1/g, span => HOLE.repeat(span.length))
      for (const m of masked.matchAll(DISPLAY)) {
        const end = (m.index ?? 0) + m[0].length
        const line = /^[ \t]*\n/.exec(masked.slice(end))
        if (line) settled = offset + end + line[0].length
      }
    }
    offset += block.text.length
  }
  return settled
}

/** Replaces inline math in markdown with Unicode, escaped for markdown. */
export function inlineToUnicode(markdown: string): string {
  return splitFences(markdown)
    .map(block => {
      if (block.isCode) return block.text
      const { masked, spans } = maskCodeSpans(block.text)
      const replaced = masked.replace(INLINE, (whole, paren?: string, dollar?: string) => {
        const tex = paren ?? dollar ?? ''
        if (NUMBER.test(tex)) return tex
        // Digits that are no number (`$5,$`) are left as written.
        if (dollar !== undefined && /^[\d.,\s]+$/.test(dollar)) return whole
        return escapeMarkdown(texToUnicode(tex))
      })
      return unmask(replaced, spans)
    })
    .join('')
}

/** The whole reply as markdown with every formula in Unicode, every figure as its code. */
export function segmentsToUnicode(segments: Segment[]): string {
  return segments
    .map(s => {
      if (s.kind === 'markdown') return inlineToUnicode(s.text)
      if (s.kind === 'figure') return figureToCode(s.tex)
      // A lone line of inline math reads as it was written.
      return s.source !== undefined ? inlineToUnicode(s.source) : displayToUnicode(s.tex)
    })
    .join('')
}

/** A figure that cannot be drawn, shown as the TikZ it was written in. */
export function figureToCode(tex: string): string {
  return '\n\n```tex\n' + tex + '\n```\n\n'
}

// The figure in a closed ```tikz fence, undefined for any other block.
function tikzFence(block: string): Segment | undefined {
  const lines = block.split(/(?<=\n)/)
  const marks = TIKZ_FENCE.exec(lines[0] ?? '')?.[1]
  const last = lines[lines.length - 1]?.trim() ?? ''
  if (!marks || lines.length < 2 || last[0] !== marks[0] || !/^(`+|~+)$/.test(last) || last.length < marks.length) {
    return undefined
  }
  const tex = lines.slice(1, -1).join('').trim()
  return tex === '' ? undefined : { kind: 'figure', tex }
}

/** A display formula as indented Unicode lines, one per `\\` row. */
export function displayToUnicode(tex: string): string {
  const body = tex.replace(/\\(?:begin|end)\{(?:aligned|gathered|split|align\*?|gather\*?)\}/g, '')
  const lines = body
    .split(/\\\\(?:\[[^\]]*\])?/)
    .map(line => texToUnicode(line).trim())
    .filter(line => line !== '')
  return '\n\n' + lines.map(line => '    ' + escapeMarkdown(line)).join('  \n') + '\n\n'
}

function splitFences(text: string): { text: string; isCode: boolean }[] {
  const blocks: { text: string; isCode: boolean }[] = []
  let current = ''
  let fence: string | undefined
  for (const line of text.split(/(?<=\n)/)) {
    const marks = FENCE.exec(line)?.[1]
    if (fence === undefined && marks) {
      if (current) blocks.push({ text: current, isCode: false })
      current = line
      fence = marks
    } else if (fence !== undefined && marks && marks[0] === fence[0] && marks.length >= fence.length && line.trim() === marks) {
      blocks.push({ text: current + line, isCode: true })
      current = ''
      fence = undefined
    } else {
      current += line
    }
  }
  if (current) blocks.push({ text: current, isCode: fence !== undefined })
  return blocks
}

function maskCodeSpans(text: string): { masked: string; spans: string[] } {
  const spans: string[] = []
  const masked = text.replace(/(`+)[\s\S]*?\1/g, span => {
    spans.push(span)
    return HOLE + (spans.length - 1) + HOLE
  })
  return { masked, spans }
}

function unmask(text: string, spans: string[]): string {
  return text.replace(/(\d+)/g, (_, i: string) => spans[Number(i)] ?? '')
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>|~]/g, c => '\\' + c)
}

// ---------------------------------------------------------------------------
// LaTeX to Unicode

const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ',
  varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  cdot: '·', cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱', times: '×', div: '÷',
  pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '•', oplus: '⊕', otimes: '⊗',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼',
  simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫', prec: '≺', succ: '≻', perp: '⊥',
  parallel: '∥', mid: '∣', nmid: '∤', vert: '|', Vert: '‖', lvert: '|', rvert: '|', lVert: '‖',
  rVert: '‖', langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
  lbrace: '{', rbrace: '}', '{': '{', '}': '}', '|': '‖', '%': '%', '$': '$', '&': '&', '#': '#', _: '_',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  subsetneq: '⊊', cup: '∪', cap: '∩', bigcup: '⋃', bigcap: '⋂', setminus: '∖', emptyset: '∅',
  varnothing: '∅', forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬', land: '∧',
  wedge: '∧', lor: '∨', vee: '∨', top: '⊤', bot: '⊥', vdash: '⊢', models: '⊨',
  to: '→', rightarrow: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔', Rightarrow: '⇒',
  Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⟹', impliedby: '⟸', iff: '⟺', mapsto: '↦',
  longrightarrow: '⟶', longleftarrow: '⟵', longleftrightarrow: '⟷', Longrightarrow: '⟹',
  Longleftarrow: '⟸', Longleftrightarrow: '⟺', longmapsto: '⟼', uparrow: '↑', downarrow: '↓',
  hookrightarrow: '↪', rightharpoonup: '⇀', nearrow: '↗', searrow: '↘',
  infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬',
  iiint: '∭', oint: '∮', angle: '∠', triangle: '△', square: '□', Box: '□',
  ell: 'ℓ', hbar: 'ℏ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', wp: '℘', prime: '′', degree: '°',
  qed: '∎', blacksquare: '■', checkmark: '✓', dagger: '†', ddagger: '‡',
  colon: ':', ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ', quad: '  ', qquad: '    ',
  enspace: ' ', thinspace: ' ', medspace: ' ', thickspace: ' ', cr: '; ', newline: '; ',
}

const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'coth', 'log', 'ln', 'lg', 'exp', 'lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'det',
  'dim', 'ker', 'deg', 'gcd', 'lcm', 'arg', 'Pr', 'hom', 'mod', 'bmod', 'tr', 'rank', 'span',
])

const IGNORED = new Set([
  'left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr',
  'Biggl', 'Biggr', 'middle', 'displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits',
  'label', 'nonumber', 'notag', 'tag', 'mathstrut', 'strut', 'phantom', 'hphantom', 'vphantom',
])

const TEXT_COMMANDS = new Set([
  'text', 'textrm', 'textit', 'textbf', 'textsf', 'texttt', 'mathrm', 'mathit', 'mathbf', 'mathsf',
  'mathtt', 'boldsymbol', 'bm', 'mbox', 'hbox', 'emph', 'pmb', 'mathnormal',
])

const ACCENTS: Record<string, string> = {
  hat: '̂', widehat: '̂', bar: '̅', overline: '̅', tilde: '̃',
  widetilde: '̃', dot: '̇', ddot: '̈', vec: '⃗', overrightarrow: '⃗',
  check: '̌', acute: '́', grave: '̀', breve: '̆', underline: '̲',
}

const DOUBLE_STRUCK: Record<string, string> = {
  C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ', '1': '𝟙',
}

const SCRIPT: Record<string, string> = {
  B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ',
}

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ',
  e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ',
  r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ', A: 'ᴬ', B: 'ᴮ', D: 'ᴰ',
  E: 'ᴱ', G: 'ᴳ', H: 'ᴴ', I: 'ᴵ', J: 'ᴶ', K: 'ᴷ', L: 'ᴸ', M: 'ᴹ', N: 'ᴺ', O: 'ᴼ', P: 'ᴾ', R: 'ᴿ',
  T: 'ᵀ', U: 'ᵁ', V: 'ⱽ', W: 'ᵂ', 'β': 'ᵝ', 'γ': 'ᵞ', 'δ': 'ᵟ', 'θ': 'ᶿ', 'ϕ': 'ᵠ', 'φ': 'ᵠ',
  'χ': 'ᵡ', '∗': '*', '*': '*', '′': '′', ',': '˒', ' ': '', '∘': '°',
}

const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ',
  k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
  'β': 'ᵦ', 'γ': 'ᵧ', 'ρ': 'ᵨ', 'ϕ': 'ᵩ', 'φ': 'ᵩ', 'χ': 'ᵪ', ',': ',', ' ': '',
}

// The letters Unicode has a subscript for, as the style guide lists them.
const SUBSCRIPT_LETTERS = Object.keys(SUBSCRIPT).filter(k => /^[a-z]$/.test(k)).join(' ')

const MATRIX_ENVS: Record<string, [string, string]> = {
  matrix: ['', ''], pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'],
  vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], smallmatrix: ['', ''], cases: ['{ ', ''],
  array: ['', ''],
}

// Mark a function name's ends: a space where a letter or digit touches it.
const FUNCTION_START = '\uE002'
const FUNCTION_END = '\uE001'

// Relations and binary operators drawn with a space either side.
const SPACED = /[+=<>≤≥≠≈≡∼≃≅∝∈∉∋⊂⊃⊆⊇⊊→←↔⇒⇐⇔⟹⟸⟺↦⟶⟵⟷⊢⊨≪≫·×±∓÷]/g

// A sign with nothing to add to: first, or after a bracket, a comma or another operator.
const SIGNS = '+±∓'
const AFTER_SIGN = /(?:^|[([{,;=<>≤≥≠≈≡∼≃≅∝∈∉∋⊂⊃⊆⊇⊊→←↔⇒⇐⇔⟹⟸⟺↦⟶⊢⊨≪≫·×±∓÷+])$/

function spaceOperator(op: string, at: number, all: string): string {
  return SIGNS.includes(op) && AFTER_SIGN.test(all.slice(0, at).trimEnd()) ? op : ` ${op} `
}

type Token = { type: 'command'; name: string } | { type: 'char'; value: string }

const isChar = (t: Token | undefined, value: string) => t?.type === 'char' && t.value === value

function tokenize(tex: string): Token[] {
  const tokens: Token[] = []
  for (let i = 0; i < tex.length; ) {
    const c = tex[i]
    if (c === '\\') {
      const m = /^[a-zA-Z]+/.exec(tex.slice(i + 1))
      if (m) {
        tokens.push({ type: 'command', name: m[0] })
        i += 1 + m[0].length
        // TeX drops the spaces after a control word.
        while (/[ \t\n]/.test(tex[i] ?? '')) i++
      } else {
        tokens.push({ type: 'command', name: tex[i + 1] ?? '' })
        i += 2
      }
    } else if (c === '%') {
      const end = tex.indexOf('\n', i)
      i = end === -1 ? tex.length : end + 1
    } else {
      const ch = String.fromCodePoint(tex.codePointAt(i) ?? 0)
      tokens.push({ type: 'char', value: ch })
      i += ch.length
    }
  }
  return tokens
}

/** Converts a LaTeX math expression to readable Unicode text. */
export function texToUnicode(tex: string): string {
  const tokens = tokenize(tex)
  let i = 0

  const skipSpace = () => {
    for (let t = tokens[i]; t?.type === 'char' && /\s/.test(t.value); t = tokens[i]) i++
  }

  // One argument: a braced group or a single token.
  const arg = (): string => {
    skipSpace()
    const t = tokens[i]
    if (t === undefined) return ''
    if (t.type === 'char' && t.value === '{') {
      i++
      return expr('}')
    }
    i++
    return atom(t)
  }

  const optionalArg = (): string | undefined => {
    skipSpace()
    const t = tokens[i]
    if (t?.type !== 'char' || t.value !== '[') return undefined
    i++
    return expr(']')
  }

  const rawGroup = (): string => {
    skipSpace()
    if (!isChar(tokens[i], '{')) return ''
    i++
    let depth = 1
    let s = ''
    for (let t = tokens[i]; t !== undefined; t = tokens[i]) {
      i++
      if (t.type === 'char' && t.value === '{') depth++
      if (t.type === 'char' && t.value === '}' && --depth === 0) break
      s += t.type === 'char' ? t.value : '\\' + t.name
    }
    return s
  }

  const environment = (name: string): string => {
    if (name === 'array') rawGroup()
    let row: string[] = []
    const rows: string[][] = [row]
    let cell = ''
    for (let t = tokens[i]; t !== undefined; t = tokens[i]) {
      if (t.type === 'command' && t.name === 'end') {
        i++
        rawGroup()
        break
      }
      if (t.type === 'char' && t.value === '&') {
        i++
        row.push(cell.trim())
        cell = ''
      } else if (t.type === 'command' && t.name === '\\') {
        i++
        optionalArg()
        row.push(cell.trim())
        row = []
        rows.push(row)
        cell = ''
      } else {
        i++
        cell += atom(t)
      }
    }
    row.push(cell.trim())
    const kept = rows.filter(r => r.some(c => c !== ''))
    const [open, close] = (Object.hasOwn(MATRIX_ENVS, name) ? MATRIX_ENVS[name] : undefined) ?? ['', '']
    if (name === 'cases') return open + kept.map(r => r.filter(c => c !== '').join(', ')).join('; ')
    const sep = /matrix|array/.test(name) ? ' ' : ''
    return open + kept.map(r => r.join(sep)).join('; ') + close
  }

  const command = (name: string): string => {
    const symbol = Object.hasOwn(SYMBOLS, name) ? SYMBOLS[name] : undefined
    if (symbol !== undefined && !IGNORED.has(name)) return symbol
    if (FUNCTIONS.has(name)) return FUNCTION_START + name + FUNCTION_END
    if (name === 'operatorname') return FUNCTION_START + arg() + FUNCTION_END
    if (IGNORED.has(name)) {
      if (['label', 'tag', 'phantom', 'hphantom', 'vphantom'].includes(name)) rawGroup()
      if (name === 'left' || name === 'right') {
        skipSpace()
        const t = tokens[i]
        if (t?.type === 'char' && t.value === '.') i++
      }
      return ''
    }
    const mark = Object.hasOwn(ACCENTS, name) ? ACCENTS[name] : undefined
    if (mark !== undefined) {
      const body = arg()
      if (name === 'vec' || name === 'overrightarrow' || name.startsWith('wide')) return body + mark
      return [...body].map(ch => ch + mark).join('')
    }
    if (TEXT_COMMANDS.has(name)) return arg()
    switch (name) {
      case 'frac':
      case 'dfrac':
      case 'tfrac':
      case 'cfrac': {
        const a = arg()
        const b = arg()
        return wrap(a) + '/' + wrap(b)
      }
      case 'binom':
      case 'dbinom':
      case 'tbinom':
        return 'C(' + arg() + ', ' + arg() + ')'
      case 'sqrt': {
        const n = optionalArg()
        const body = arg()
        const root = n === '3' ? '∛' : n === '4' ? '∜' : n ? superscript(n) + '√' : '√'
        return root + wrap(body)
      }
      case 'mathbb':
        return [...arg()].map(ch => DOUBLE_STRUCK[ch] ?? ch).join('')
      case 'mathcal':
      case 'mathscr':
        return [...arg()].map(ch => SCRIPT[ch] ?? ch).join('')
      case 'mathfrak':
        return arg()
      case 'not': {
        const next = arg()
        return next === '=' ? '≠' : next === '∈' ? '∉' : next + '̸'
      }
      case 'begin': {
        const env = rawGroup().replace(/\*$/, '')
        return environment(env)
      }
      case 'end':
        rawGroup()
        return ''
      case 'overset':
      case 'stackrel': {
        arg()
        return arg()
      }
      case 'underbrace':
      case 'overbrace':
        return arg()
      // Color has no Unicode form: drop it, keep what it colors.
      case 'color':
        optionalArg()
        rawGroup()
        return ''
      case 'textcolor':
      case 'colorbox':
        optionalArg()
        rawGroup()
        return arg()
      case 'fcolorbox':
        optionalArg()
        rawGroup()
        rawGroup()
        return arg()
      case 'boxed':
        return arg()
      case 'pmod':
        return ' (mod ' + arg() + ')'
      case '\\':
        return '; '
      default:
        return name
    }
  }

  const atom = (t: Token): string => {
    if (t.type === 'command') return command(t.name)
    switch (t.value) {
      case '^':
        return script(arg(), superscript, plain => '^' + plain)
      case '_':
        // Capitals, arrows and script letters have no subscript form: set the
        // subscript between subscript parentheses rather than after an underscore.
        return script(arg(), subscript, (_, body) => '₍' + body + '₎')
      case "'":
        return '′'
      case '~':
        return ' '
      case '&':
        return ' '
      case '{':
        return expr('}')
      default:
        return /\s/.test(t.value) ? ' ' : t.value
    }
  }

  const expr = (until?: string): string => {
    let s = ''
    for (let t = tokens[i]; t !== undefined; t = tokens[i]) {
      if (until && isChar(t, until)) {
        i++
        break
      }
      i++
      s += atom(t)
    }
    return s
  }

  return expr()
    .replace(new RegExp(FUNCTION_END + '(?=[A-Za-z0-9\u0370-\u03ff])', 'g'), ' ')
    .replaceAll(FUNCTION_END, '')
    .replace(new RegExp('(?<=[A-Za-z0-9)\u0370-\u03ff′])' + FUNCTION_START, 'g'), ' ')
    .replaceAll(FUNCTION_START, '')
    .replace(SPACED, spaceOperator)
    .replace(/[ \t\n]+/g, ' ')
    .replace(/ ([,;.)\]])/g, '$1')
    .replace(/([([]) /g, '$1')
    .trim()
}

function script(
  body: string,
  convert: (s: string) => string | undefined,
  fallback: (plain: string, body: string) => string,
): string {
  const trimmed = body.trim()
  if (/^′+$/.test(trimmed)) return trimmed
  if (trimmed === '') return ''
  const plain = [...trimmed].length === 1 || /^\(.*\)$/.test(trimmed) ? trimmed : '(' + trimmed + ')'
  return convert(trimmed) ?? fallback(plain, trimmed)
}

function superscript(s: string): string | undefined {
  return mapAll(s, SUPERSCRIPT)
}

function subscript(s: string): string | undefined {
  return mapAll(s, SUBSCRIPT)
}

function mapAll(s: string, table: Record<string, string>): string | undefined {
  let out = ''
  for (const ch of s) {
    const mapped = table[ch]
    if (mapped === undefined) return undefined
    out += mapped
  }
  return out
}

function wrap(s: string): string {
  const t = s.trim()
  if ([...t].length <= 1 || /^[\p{L}\p{N}.′]+$/u.test(t) || /^\(.*\)$/.test(t)) return t
  return '(' + t + ')'
}

// ---------------------------------------------------------------------------
// Typesetting a display formula

const STARRED: Record<string, string> = {
  equation: 'gather*', 'equation*': 'gather*', multline: 'gather*', 'multline*': 'gather*',
  flalign: 'align*', 'flalign*': 'align*', align: 'align*', gather: 'gather*', alignat: 'alignat*',
  eqnarray: 'eqnarray*',
}

/**
 * The LaTeX document a display formula is typeset alone in, drawn in `ink`:
 * xcolor sets the page in explicit `black`, which would override dvipng's
 * `-fg`, so `black` is the ink. With `paper`, a dark theme's background, named
 * colors too dim to read on it are lightened. Both are 6-digit hex.
 */
export function texDocument(segment: { tex: string; env?: string }, preamble: string, ink?: string, paper?: string): string {
  const body = segment.tex.replace(/\\label\{[^}]*\}/g, '')
  let env = segment.env ? (STARRED[segment.env] ?? segment.env) : undefined
  if (env === undefined) env = body.includes('&') && !body.includes('\\begin{') ? 'align*' : 'gather*'
  if (env === 'alignat*' && !body.trimStart().startsWith('{')) env = 'align*'
  return [
    '\\documentclass[10pt]{article}',
    '\\usepackage{amsmath,amssymb,amsfonts,mathtools,bm,xcolor}',
    ...figureColors(Boolean(paper)),
    preamble,
    ...(ink ? [`\\definecolor{black}{HTML}{${ink.replace('#', '')}}`] : []),
    '\\pagestyle{empty}',
    '\\setlength{\\textwidth}{60cm}',
    '\\begin{document}',
    ...(ink ? ['\\color{black}'] : []),
    `\\begin{${env}}`,
    body,
    `\\end{${env}}`,
    '\\end{document}',
    '',
  ].join('\n')
}

/**
 * The standalone document a TikZ figure is typeset alone in, drawn in `ink`.
 * With `paper`, the background of a dark theme, `white` (and what colors are
 * mixed with, as in `blue!20`) becomes that background, so fills, masks and
 * tints stay dark; `black` is always the ink. Both are 6-digit hex.
 */
export function figureDocument(tex: string, preamble: string, ink: string, paper?: string): string {
  const body = /\\begin\{(?:tikzpicture|tikzcd)\}/.test(tex)
    ? tex
    : `\\begin{tikzpicture}\n${tex}\n\\end{tikzpicture}`
  const dark = paper ? hexRgb(paper) : undefined
  return [
    '\\documentclass[tikz,border=4pt]{standalone}',
    '\\usepackage{amsmath,amssymb,amsfonts,mathtools,bm,pgfplots}',
    '\\pgfplotsset{compat=1.18,every axis/.append style={axis on top}}',
    '\\usetikzlibrary{arrows.meta,calc,cd,decorations.pathreplacing,patterns,positioning,shapes.geometric}',
    ...figureColors(Boolean(paper)),
    preamble,
    `\\definecolor{black}{HTML}{${ink.replace('#', '')}}`,
    ...(dark
      ? [
          `\\definecolor{white}{HTML}{${paper!.replace('#', '')}}`,
          '\\makeatletter',
          `\\def\\XC@clr@rgb@white{${dark.join(',')}}`,
          `\\def\\XC@clr@gray@white{${((dark[0] + dark[1] + dark[2]) / 3).toFixed(3)}}`,
          `\\def\\XC@clr@cmy@white{${dark.map(c => (1 - c).toFixed(3)).join(',')}}`,
          `\\def\\XC@clr@cmyk@white{${dark.map(c => (1 - c).toFixed(3)).join(',')},0}`,
          '\\makeatother',
        ]
      : []),
    '\\begin{document}',
    '\\color{black}',
    body,
    '\\end{document}',
    '',
  ].join('\n')
}

// Lowercase SVG names xcolor lacks, defined so a figure naming one compiles.
const EXTRA_COLORS: Record<string, string> = {
  navy: '000080',
  darkblue: '00008B',
  midnightblue: '191970',
  indigo: '4B0082',
  maroon: '800000',
  darkred: '8B0000',
  darkgreen: '006400',
}

// On a dark theme, the named colors too dim to read on the background, as
// lighter shades of themselves.
const DARK_COLORS: Record<string, string> = {
  blue: '6EA8FF',
  navy: '7AA2F7',
  darkblue: '6C8CFF',
  midnightblue: '8C9EFF',
  violet: 'B48CFF',
  indigo: 'A58CFF',
  purple: 'D38BD8',
  brown: 'D09A66',
  maroon: 'E07A7A',
  darkred: 'FF6B6B',
  darkgreen: '5CC96B',
  teal: '3CC8C8',
  darkgray: 'A8A8A8',
}

// Ahead of the extra preamble, so a color the person defines there wins.
function figureColors(dark: boolean): string[] {
  const colors = dark ? { ...EXTRA_COLORS, ...DARK_COLORS } : EXTRA_COLORS
  return Object.entries(colors).map(([name, hex]) => `\\definecolor{${name}}{HTML}{${hex}}`)
}

/** What a reply drawn here can show: pictures at all, figures, and a dark theme's background. */
export type StyleFacts = { pictures: boolean; figures: boolean; paper?: string }

/**
 * The system prompt section that tells the model how to write math and
 * figures so this mod draws them well.
 */
export function styleGuide({ pictures, figures, paper }: StyleFacts): string {
  const lines = [
    '# Math and figures',
    'Your replies are shown in a terminal that renders LaTeX (the latex-render plugin). Write math and figures in the forms it renders:',
    '- Write math in LaTeX rather than plain-text approximations like x^2 or sqrt(x): inline `$…$`, display `$$…$$` on lines of its own (or an `align`, `gather` or `equation` environment).',
    '- Inline math is turned into Unicode text, so keep it to symbols, Greek letters, sub- and superscripts, operators and short fractions like `$a/b$`. Anything taller (stacked fractions, matrices, `cases`, sums or integrals with limits) goes in display math.',
    `- Inline subscripts become Unicode only for digits, signs and the letters ${SUBSCRIPT_LETTERS}. Any other stays full size between subscript parentheses: no capital, arrow, \`\\mathcal\`, \`\\mathbb\` or \`\\mathrm\` letter has a subscript form, so \`$S_N$\` shows as \`S₍N₎\` and \`$P_{C \\leftarrow B}$\` as \`P₍C ← B₎\`. When the notation is yours to choose, pick letters that have one (\`$S_n$\`, \`$x_k$\`); when it is fixed, put a formula that should look typeset in display math.`,
    '- A bare number is plain text: write 0 or 3.5 rather than `$0$` or `$3.5$`.',
    '- Never put math meant to be read in a code block or inline code, which show raw LaTeX. Use a ```latex block only when asked for LaTeX source.',
    '- Figures, graphs, plots and commutative diagrams (including pgfplots `axis` plots) always go in a ```tikz fenced block, never loose in the text and never in a ```latex block: bare TikZ commands, or a whole `tikzpicture`, `axis` or `tikzcd` environment. pgfplots, tikz-cd and the TikZ libraries arrows.meta, calc, cd, decorations.pathreplacing, patterns, positioning and shapes.geometric are loaded; write no `\\documentclass`, `\\usepackage` or `\\begin{document}`.',
    '- A formula or figure using `\\def`, `\\newcommand`, `\\let`, `\\input`, `\\write`, `\\csname` or other macro and file primitives is never compiled; use `\\pgfmathsetmacro`, `\\tikzset` or plain repetition instead.',
  ]
  if (!pictures) {
    lines.push(
      '- This terminal shows no images: display math is shown as Unicode text and figures as their TikZ code. Keep display math simple, and draw a figure only when asked.',
    )
  } else if (!figures) {
    lines.push('- Figures cannot be drawn here and are shown as their TikZ code; draw one only when asked.')
  }
  if (pictures && figures && paper) {
    lines.push(
      `- The background is dark (#${paper.replace('#', '')}). In figures, leave lines and text in the default color, the terminal's light text color (\`black\` means the same). \`white\` is the background: a white fill hides what is under it, and tints like \`blue!20\` are dim fills, good for shading regions.`,
      '- Color figures with named colors: red, orange, yellow, green, cyan, blue, magenta, violet, purple, teal, brown, gray. Dark ones are lightened to read on the background. Do not define colors by RGB or hex, and do not use dvipsnames or svgnames (`NavyBlue`, `Navy`): they are not loaded.',
    )
  } else if (pictures && figures) {
    lines.push('- Color figures with named xcolor colors (red, blue, green, orange, …); dvipsnames and svgnames (`NavyBlue`, `Navy`) are not loaded.')
  }
  return lines.join('\n')
}

function hexRgb(hex: string): [number, number, number] | undefined {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return undefined
  return [1, 2, 3].map(k => Number((parseInt(m[k]!, 16) / 255).toFixed(3))) as [number, number, number]
}

/** A short stable hex key for a string (two FNV-1a passes). */
export function hashKey(s: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13)
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

/** Width and height of a PNG from the start of its base64. */
export function pngSize(base64: string): { width: number; height: number } | undefined {
  const head = atob(base64.slice(0, 32))
  if (head.length < 24 || head.slice(1, 4) !== 'PNG') return undefined
  const u32 = (at: number) =>
    ((head.charCodeAt(at) << 24) | (head.charCodeAt(at + 1) << 16) | (head.charCodeAt(at + 2) << 8) | head.charCodeAt(at + 3)) >>> 0
  return { width: u32(16), height: u32(20) }
}

/** `#rrggbb` as dvipng's `rgb r g b`. */
export function dvipngColor(hex: string): string | undefined {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return undefined
  return 'rgb ' + m.slice(1, 4).map(h => (parseInt(h, 16) / 255).toFixed(3)).join(' ')
}

/** The first error line of a LaTeX log. */
export function latexError(log: string): string {
  const line = log.split('\n').find(l => l.startsWith('! '))
  return line ? line.slice(2).trim() : 'LaTeX failed'
}

const UNSAFE = /\\(?:input|include|includeonly|InputIfFileExists|openin|openout|closein|closeout|read|readline|write|message|immediate|special|catcode|uccode|lccode|csname|endcsname|string|def|edef|gdef|xdef|let|futurelet|expandafter|noexpand|newcommand|renewcommand|providecommand|DeclareRobustCommand|usepackage|RequirePackage|documentclass|begin\s*\{\s*document|end\s*\{\s*document|directlua|latelua|pdffilesize|filesize|verbatiminput|lstinputlisting|includegraphics|newread|newwrite|jobname|loop|repeat)(?![a-zA-Z])|\^\^/

/** Whether a formula is plain math: no file access, no macro or catcode tricks. */
export function isSafeTex(tex: string): boolean {
  return !UNSAFE.test(tex)
}
