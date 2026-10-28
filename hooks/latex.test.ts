import { describe, expect, test } from 'claude-code/testing'

import {
  displayToUnicode,
  dvipngColor,
  figureDocument,
  hashKey,
  hasMath,
  inlineToUnicode,
  isSafeTex,
  nextMode,
  pngSize,
  segmentsToUnicode,
  settledLength,
  splitMath,
  styleGuide,
  texDocument,
  texToUnicode,
} from './latex'

describe('splitMath', () => {
  test('finds $$, \\[ and environment display math', async () => {
    const parts = splitMath('A\n$$x^2$$\nB \\[ y \\] C\n\\begin{align}a &= b\\end{align}\n')
    expect(parts.filter(p => p.kind === 'display').map(p => (p as { tex: string }).tex)).toEqual([
      'x^2',
      'y',
      'a &= b',
    ])
    expect(parts[5]).toEqual({ kind: 'display', tex: 'a &= b', env: 'align' })
  })

  test('leaves fenced and inline code alone', async () => {
    const text = '```tex\n$$x$$\n```\nand `$$y$$` here'
    expect(splitMath(text)).toEqual([{ kind: 'markdown', text }])
  })
})

describe('inlineToUnicode', () => {
  test('converts $...$ and \\(...\\)', async () => {
    expect(inlineToUnicode('Let $\\alpha \\leq \\beta$ and \\(x^2\\).')).toBe('Let α ≤ β and x².')
  })

  test('keeps prices and code', async () => {
    expect(inlineToUnicode('costs $5 and $10, `$x$`')).toBe('costs $5 and $10, `$x$`')
  })

  test('escapes markdown in the result', async () => {
    expect(inlineToUnicode('$a_{ij}^*$')).toBe('aᵢⱼ\\*')
  })

  test('converts math with a word ending glued to it, or in underscore italics', async () => {
    expect(inlineToUnicode('the $n$th term')).toBe('the nth term')
    expect(inlineToUnicode('all the $x$s')).toBe('all the xs')
    expect(inlineToUnicode('_$x$_')).toBe('_x_')
  })

  test('converts a number written as math', async () => {
    expect(inlineToUnicode('at $0$ and $3.5$, then $1,000$ and $-2$')).toBe('at 0 and 3.5, then 1,000 and -2')
  })

  test('keeps prices written close together', async () => {
    expect(inlineToUnicode('from $5-$10, or $5/$10, or $5,$10')).toBe('from $5-$10, or $5/$10, or $5,$10')
    expect(inlineToUnicode('US$5 or 5$ and 10$')).toBe('US$5 or 5$ and 10$')
  })
})

describe('texToUnicode', () => {
  test('fractions, roots and scripts', async () => {
    expect(texToUnicode('\\frac{a+b}{2}')).toBe('(a + b)/2')
    expect(texToUnicode('\\sqrt{x}')).toBe('√x')
    expect(texToUnicode('e^{i\\pi} + 1 = 0')).toBe('e^(iπ) + 1 = 0')
    expect(texToUnicode('x_{n+1}')).toBe('xₙ₊₁')
    expect(texToUnicode("f'(x)")).toBe('f′(x)')
  })

  test('a subscript with no Unicode form goes between subscript parentheses', async () => {
    expect(texToUnicode('S_N')).toBe('S₍N₎')
    expect(texToUnicode('P_{C \\leftarrow B}')).toBe('P₍C ← B₎')
    expect(texToUnicode('[b_i]_C')).toBe('[bᵢ]₍C₎')
    expect(texToUnicode('[p]_{\\mathcal{B}}')).toBe('[p]₍ℬ₎')
    expect(inlineToUnicode('les $[b_i]_C$, et')).toBe('les \\[bᵢ\\]₍C₎, et')
  })

  test('sets, operators and fonts', async () => {
    expect(texToUnicode('\\forall x \\in \\mathbb{R}, \\exists n \\in \\mathbb{N}')).toBe('∀x ∈ ℝ, ∃n ∈ ℕ')
    expect(texToUnicode('\\sum_{i=1}^{n} i')).toBe('∑ᵢ₌₁ⁿ i')
    expect(texToUnicode('\\lim_{x \\to 0} \\frac{\\sin x}{x}')).toBe('lim₍x → 0₎ (sin x)/x')
    expect(texToUnicode('\\vec{v} \\cdot \\hat{n}')).toBe('v⃗ · n̂')
    expect(texToUnicode('\\sqrt{\\operatorname{tr}^2 A - 4\\det A}')).toBe('√(tr² A - 4 det A)')
  })

  test('matrices and cases', async () => {
    expect(texToUnicode('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}')).toBe('(a b; c d)')
    expect(texToUnicode('|x| = \\begin{cases} x & x \\ge 0 \\\\ -x & \\text{otherwise} \\end{cases}')).toBe(
      '|x| = { x, x ≥ 0; -x, otherwise',
    )
  })
})

describe('typesetting helpers', () => {
  test('displayToUnicode makes one indented line per row', async () => {
    expect(displayToUnicode('a &= b \\\\ c &= d')).toBe('\n\n    a = b  \n    c = d\n\n')
  })

  test('texDocument stars numbered environments and picks align for &', async () => {
    expect(texDocument({ tex: 'x', env: 'equation' }, '')).toContain('\\begin{gather*}')
    expect(texDocument({ tex: 'a &= b' }, '')).toContain('\\begin{align*}')
    expect(texDocument({ tex: '\\begin{pmatrix}a&b\\end{pmatrix}' }, '')).toContain('\\begin{gather*}')
  })

  test('texDocument loads xcolor, lightening dim colors on a dark theme', async () => {
    expect(texDocument({ tex: '\\color{red}x' }, '')).toContain('xcolor')
    expect(texDocument({ tex: 'x' }, '', 'e6e6e6', '1e1e1e')).toContain('\\definecolor{blue}{HTML}{6EA8FF}')
    expect(texDocument({ tex: 'x' }, '', 'e6e6e6')).toContain('\\definecolor{black}{HTML}{e6e6e6}')
    expect(texDocument({ tex: 'x' }, '', 'e6e6e6')).toMatch(/\\begin\{document\}\n\\color\{black\}/)
    expect(texDocument({ tex: 'x' }, '')).not.toContain('\\definecolor{blue}')
  })

  test('texToUnicode drops color and keeps what it colors', async () => {
    expect(texToUnicode('\\mathbb{R}^{\\color{red}n} \\Longrightarrow \\color{blue}n \\times \\color{red}n')).toBe(
      'ℝⁿ ⟹ n × n',
    )
    expect(texToUnicode('\\textcolor{red}{x} + \\colorbox{yellow}{y} + \\boxed{z}')).toBe('x + y + z')
  })

  test('isSafeTex refuses file access and macro tricks', async () => {
    expect(isSafeTex('\\int_0^1 f(x)\\,dx')).toBe(true)
    expect(isSafeTex('\\input{/etc/passwd}')).toBe(false)
    expect(isSafeTex('\\csname input\\endcsname')).toBe(false)
    expect(isSafeTex('^^5cinput')).toBe(false)
    expect(isSafeTex('\\inputfoo')).toBe(true)
  })

  test('pngSize, dvipngColor, hashKey', async () => {
    // An 8-byte signature, then IHDR declaring 352 x 102.
    const header = '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x01\x60\x00\x00\x00\x66'
    expect(pngSize(btoa(header + '\x08\x03\x00\x00\x00'))).toEqual({ width: 352, height: 102 })
    expect(dvipngColor('#ffffff')).toBe('rgb 1.000 1.000 1.000')
    expect(dvipngColor('nope')).toBeUndefined()
    expect(hashKey('a')).not.toBe(hashKey('b'))
    expect(hashKey('a')).toHaveLength(16)
  })
})

describe('figures', () => {
  test('a closed ```tikz fence is a figure', async () => {
    const parts = splitMath('Before\n```tikz\n\\draw (0,0) -- (1,1);\n```\nAfter')
    expect(parts).toEqual([
      { kind: 'markdown', text: 'Before\n' },
      { kind: 'figure', tex: '\\draw (0,0) -- (1,1);' },
      { kind: 'markdown', text: 'After' },
    ])
  })

  test('an unclosed ```tikz fence, still streaming, stays text', async () => {
    const text = 'See\n```tikz\n\\draw (0,0) -- (1,1);\n'
    expect(splitMath(text)).toEqual([{ kind: 'markdown', text }])
  })

  test('a bare tikzpicture or tikzcd is a figure, math inside it and all', async () => {
    const pic = '\\begin{tikzpicture}\\node at (0,0) {$x^2$};\\end{tikzpicture}'
    const cd = '\\begin{tikzcd} A \\arrow[r, "f"] & B \\end{tikzcd}'
    const parts = splitMath(`One ${pic} two\n${cd}`)
    expect(parts.filter(p => p.kind === 'figure')).toEqual([
      { kind: 'figure', tex: pic },
      { kind: 'figure', tex: cd },
    ])
  })

  test('a reply with only a tikz fence is noticed', async () => {
    expect(hasMath('```tikz\n\\draw (0,0) circle (1);\n```')).toBe(true)
    expect(hasMath('```ts\nconst x = 1\n```')).toBe(false)
  })

  test('a figure that cannot be drawn is shown as its code', async () => {
    expect(segmentsToUnicode([{ kind: 'figure', tex: '\\draw (0,0) -- (1,0);' }])).toBe(
      '\n\n```tex\n\\draw (0,0) -- (1,0);\n```\n\n',
    )
  })

  test('bare commands are wrapped in a tikzpicture, environments are not', async () => {
    const wrapped = figureDocument('\\draw (0,0) -- (1,0);', '', 'e6e6e6')
    expect(wrapped).toContain('\\begin{tikzpicture}\n\\draw (0,0) -- (1,0);\n\\end{tikzpicture}')
    const cd = figureDocument('\\begin{tikzcd} A \\end{tikzcd}', '', 'e6e6e6')
    expect(cd).not.toContain('\\begin{tikzpicture}')
  })

  test('a dark paper turns white and tints dark, a light theme leaves them', async () => {
    const dark = figureDocument('\\draw (0,0) -- (1,0);', '', '#e6e6e6', '#1e1e1e')
    expect(dark).toContain('\\definecolor{black}{HTML}{e6e6e6}')
    expect(dark).toContain('\\definecolor{white}{HTML}{1e1e1e}')
    expect(dark).toContain('\\def\\XC@clr@rgb@white{0.118,0.118,0.118}')
    const light = figureDocument('\\draw (0,0) -- (1,0);', '', '1f1f1f')
    expect(light).not.toContain('{white}')
  })

  test('a dark theme lightens dim named colors, before the preamble so it can override them', async () => {
    const dark = figureDocument('\\draw[navy] (0,0) -- (1,0);', '\\definecolor{blue}{HTML}{0000FF}', 'e6e6e6', '1e1e1e')
    expect(dark).toContain('\\definecolor{navy}{HTML}{7AA2F7}')
    expect(dark).toContain('\\definecolor{darkgray}{HTML}{A8A8A8}')
    expect(dark.indexOf('\\definecolor{blue}{HTML}{6EA8FF}')).toBeLessThan(dark.indexOf('\\definecolor{blue}{HTML}{0000FF}'))
  })

  test('a light theme keeps xcolor\'s colors but still defines the SVG names', async () => {
    const light = figureDocument('\\draw[navy] (0,0) -- (1,0);', '', '1f1f1f')
    expect(light).toContain('\\definecolor{navy}{HTML}{000080}')
    expect(light).not.toContain('{blue}')
  })
})

describe('styleGuide', () => {
  test('asks for LaTeX math, plain numbers and tikz fences', async () => {
    const guide = styleGuide({ pictures: true, figures: true })
    expect(guide).toContain('`$…$`')
    expect(guide).toContain('write 0 or 3.5')
    expect(guide).toContain('```tikz')
    expect(guide).not.toContain('background is dark')
  })

  test('lists the subscript letters Unicode has and what happens to the rest', async () => {
    const guide = styleGuide({ pictures: true, figures: true })
    expect(guide).toContain('the letters a e h i j k l m n o p r s t u v x.')
    expect(guide).toContain('`$S_N$` shows as `S₍N₎`')
    expect(guide).toContain('`$P_{C \\leftarrow B}$` as `P₍C ← B₎`')
  })

  test('a dark theme names its background and the colors to use', async () => {
    const guide = styleGuide({ pictures: true, figures: true, paper: '#1e1e1e' })
    expect(guide).toContain('background is dark (#1e1e1e)')
    expect(guide).toContain('Dark ones are lightened')
  })

  test('without pictures it says math is text and leaves colors out', async () => {
    const guide = styleGuide({ pictures: false, figures: false, paper: '1e1e1e' })
    expect(guide).toContain('shows no images')
    expect(guide).not.toContain('named colors')
  })
})

describe('nextMode', () => {
  test('no argument flips, a word sets, anything else is refused', async () => {
    expect(nextMode('render', '')).toBe('source')
    expect(nextMode('source', '  ')).toBe('render')
    expect(nextMode('source', 'source')).toBe('source')
    expect(nextMode('source', 'Render')).toBe('render')
    expect(nextMode('render', 'off')).toBe('source')
    expect(nextMode('render', 'images')).toBe(undefined)
  })
})

describe('degrees and signs', () => {
  test('^\\circ is a degree sign', async () => {
    expect(texToUnicode('-45^\\circ')).toBe('-45°')
    expect(texToUnicode('90^{\\circ}')).toBe('90°')
    expect(inlineToUnicode('rotates by $-45^\\circ$, then back by $+45^\\circ$.')).toBe('rotates by -45°, then back by +45°.')
  })

  test('a leading sign stays on its number, a sum is spaced', async () => {
    expect(texToUnicode('+45')).toBe('+45')
    expect(texToUnicode('\\theta=+1')).toBe('θ = +1')
    expect(texToUnicode('(+1, \\pm 2)')).toBe('(+1, ±2)')
    expect(texToUnicode('a+b')).toBe('a + b')
    expect(texToUnicode('x \\pm y')).toBe('x ± y')
  })
})

describe('settledLength', () => {
  test('settles after the line a formula closes on', async () => {
    const text = 'Take\n$$x^2$$\nso'
    expect(settledLength(text)).toBe('Take\n$$x^2$$\n'.length)
    expect(settledLength('Take\n$$x^2$$  \n')).toBe('Take\n$$x^2$$  \n'.length)
    expect(settledLength('A \\[ y \\]\nB \\begin{align}a\\end{align}\nC')).toBe(
      'A \\[ y \\]\nB \\begin{align}a\\end{align}\n'.length,
    )
  })

  test('nothing is settled while a formula is open or its line goes on', async () => {
    expect(settledLength('Take $$x^2')).toBe(0)
    expect(settledLength('Take $$x^2$$')).toBe(0)
    expect(settledLength('Take $$x^2$$ and')).toBe(0)
    expect(settledLength('\\begin{align}a &= b\n')).toBe(0)
  })

  test('a closed tikz fence settles, other code never does', async () => {
    const fig = '```tikz\n\\draw (0,0) -- (1,1);\n```\n'
    expect(settledLength(fig + 'after')).toBe(fig.length)
    expect(settledLength('```tikz\n\\draw (0,0) -- (1,1);\n```')).toBe(0)
    expect(settledLength('```tikz\n\\draw (0,0) -- (1,1);\n')).toBe(0)
    expect(settledLength('```latex\n$$x$$\n```\n')).toBe(0)
    expect(settledLength('```latex\n$$x$$\n')).toBe(0)
    expect(settledLength('Use `$$x$$`\n')).toBe(0)
  })
})
