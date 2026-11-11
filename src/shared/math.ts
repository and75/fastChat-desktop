// Formule nel testo del modello: prepara il Markdown perché le formule LaTeX vengano impaginate.
// I modelli scrivono le formule in tre modi: $…$ e $$…$$ (già capiti dal parser), \(…\) e \[…\] (da convertire).

/** Applica `fn` solo fuori dal codice (blocchi ``` e `inline`), che resta com'è. */
function outsideCode(text: string, fn: (s: string) => string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join('')
}

/**
 * - \(…\) → $…$ e \[…\] → $$…$$;
 * - i prezzi non sono formule: in «$5 e $10» i dollari seguiti da una cifra, senza una chiusura plausibile
 *   sulla stessa riga, vengono protetti.
 */
export function normalizeMath(text: string): string {
  if (!text.includes('$') && !text.includes('\\')) return text
  return outsideCode(text, (s) =>
    s
      .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `$$${body}$$`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body}$`)
      .split('\n')
      .map(protectPrices)
      .join('\n')
  )
}

/** Su una riga: un «$» seguito da una cifra è un prezzo se non c'è un altro «$» che chiude subito dopo un non-spazio. */
function protectPrices(line: string): string {
  if (!/\$\d/.test(line) || line.includes('$$')) return line
  let out = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\') {
      out += ch + (line[i + 1] ?? '')
      i++
      continue
    }
    if (ch !== '$') {
      out += ch
      continue
    }
    const close = line.indexOf('$', i + 1)
    const isMath = close > i + 1 && !/\s/.test(line[close - 1]) && !/\d/.test(line[close + 1] ?? '')
    if (isMath) {
      out += line.slice(i, close + 1)
      i = close
    } else if (/\d/.test(line[i + 1] ?? '')) out += '\\$'
    else out += ch
  }
  return out
}
