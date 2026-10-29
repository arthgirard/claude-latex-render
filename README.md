# claude-latex-render

A Claude Code mod that renders LaTeX math and TikZ figures in Claude's replies, right in the terminal.

![Claude deriving the Fourier series of a square wave: the reply streams in with a live LaTeX preview, then shows typeset equations, a pgfplots figure of the first three partial sums with the Gibbs overshoot, and a tikz-cd square for the convolution theorem; /latex switches it to source and back](assets/demo.gif)

- **Display math** (`$$…$$`, `\[…\]`, `equation`, `align`, `gather`, …) is typeset with `latex` + `dvipng` and drawn as a crisp image through the kitty graphics protocol. So is a line holding nothing but one inline formula.
- **TikZ figures** (a ` ```tikz ` fenced block, or a bare `tikzpicture` or `tikzcd` environment) are compiled with `pdflatex` + `pdftocairo` and drawn the same way. A fence may hold bare commands (`\draw …;`), which are wrapped in a `tikzpicture`. `pgfplots`, `tikz-cd` and the common TikZ libraries are loaded. On a dark theme `black` is the theme's ink and `white`, along with tints like `blue!20`, turns dark. Named colors too dim for a dark background (`blue`, `navy`, `violet`, `purple`, `brown`, `teal`, `darkgray`, …) are lightened; `navy`, `darkblue`, `maroon` and the other lowercase SVG names are defined on either theme.
- **Inline math** (`$…$`, `\(…\)`) is converted to Unicode: `$\forall x \in \mathbb{R}$` becomes `∀x ∈ ℝ`, `$x_{n+1}^2$` becomes `xₙ₊₁²`. A subscript Unicode has no form for, such as a capital, goes between subscript parentheses: `$P_{C \leftarrow B}$` becomes `P₍C ← B₎`.
- Code blocks, inline code and prices like `$5 and $10` are left alone.
- **Live preview.** Each display formula and figure is compiled as soon as it closes in the streaming reply and shown in a strip above the prompt (up to 12 rows, newest last) while Claude keeps writing. When the reply's text block ends it is drawn in place, the picture already made, and the strip clears.
- Anything that fails to compile, or a terminal without image support, falls back to Unicode text (figures to their TikZ code).
- **Claude is told how to write for it.** A section added to the system prompt in terminal sessions asks for `$…$` and `$$…$$` math, ` ```tikz ` figures, bare numbers as plain text (`0` rather than `$0$`, though both show as `0`), and named colors that read on the theme. It follows the settings: without image support Claude is told math shows as text.

## Install

```
/plugin install latex-render --marketplace arthgirard/claude-latex-render
```

Answer `y` to add the marketplace, then pick the user scope to have it in every session.

## Requirements

- A terminal with the kitty graphics protocol: kitty, Ghostty or WezTerm. Inside tmux or over ssh, display math falls back to Unicode text.
- `latex` and `dvipng` on `PATH` (TeX Live: `texlive-scheme-basic` plus `dvipng`, or your distribution's equivalents), with `amsmath`, `amssymb`, `mathtools` and `bm`.
- For figures, `pdflatex` and `pdftocairo` (poppler-utils), with `pgfplots` and `tikz-cd`.
- ImageMagick (`magick`), optional: pads each picture to whole terminal cells so it keeps its proportions.

Without `latex` or `dvipng` the mod still converts all math to Unicode.

## Rendered or as written

`/latex` flips every reply between rendered and the LaTeX as Claude wrote it (`$$…$$`, `\begin{tikzpicture}`, …), ready to copy; `/latex source` and `/latex render` set it directly. While source is on, the status line says so. It works mid-reply and lasts for the session.

LaTeX inside an ordinary code block (` ```latex `, ` ```tex `) is never rendered, so asking Claude for LaTeX code to paste gets code either way.

## Settings

In `/config`:

| Setting | Default | What it does |
| --- | --- | --- |
| `images` | `auto` | `auto` draws pictures in kitty, Ghostty and WezTerm outside tmux/ssh; `on` always; `off` Unicode only |
| `color` | `auto` | Formula color as hex (`#e6e6e6`), or `auto` to follow the light or dark theme |
| `scale` | `1.25` | Terminal rows one line of LaTeX takes |
| `cellAspect` | `2.1` | Cell height ÷ width; raise it if formulas look squashed, lower it if stretched |
| `preamble` | empty | Extra LaTeX preamble, e.g. `\usepackage{physics}` |
| `preview` | `on` | `on` shows each formula and figure above the prompt as soon as it is typeset; `off` only in the reply, once its block ends |
| `background` | `auto` | On a dark theme, the terminal background as hex, which figures' `white` and tints become (`auto` is `#1e1e1e`) |

Rendered formulas and figures are cached in `~/.cache/claude-latex-render/`.

## Safety

LaTeX can read any file it can name, even with `openin_any=p`. Formulas and figures that use file or macro primitives (`\input`, `\read`, `\write`, `\catcode`, `\csname`, `\def`, `^^` escapes, …) are never compiled and are shown as Unicode instead. `latex` and `pdflatex` run with `-no-shell-escape` and `openout_any=p`.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`hooks/register.tsx` hooks the drawing of assistant messages and of the band above the prompt, the streaming reply and the system prompt; `hooks/latex.ts` holds the parsing, Unicode conversion and document building; `hooks/latex.test.ts` tests them; `hooks/toggle.test.tsx` drives `/latex` through the engine; `hooks/stream.test.tsx` streams a reply through it and watches the preview; `hooks/prompt.test.ts` composes a system prompt through it.

## License

MIT
