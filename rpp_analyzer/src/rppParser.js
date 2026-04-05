/**
 * RPP Parser — converts Reaper .rpp text to a nested node tree.
 *
 * Node shape:
 *   { type: string, args: string[], props: Map<string, string[][]>, children: Node[] }
 *
 * props maps KEY -> [[val, val, ...], [val, ...], ...]  (one entry per occurrence of the key)
 */

function tokenize(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line.charCodeAt(i) <= 32) i++;
    if (i >= line.length) break;
    if (line[i] === '"') {
      i++;
      let s = '';
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) { i++; s += line[i]; }
        else s += line[i];
        i++;
      }
      if (i < line.length) i++;
      tokens.push(s);
    } else {
      let s = '';
      while (i < line.length && line.charCodeAt(i) > 32) s += line[i++];
      tokens.push(s);
    }
  }
  return tokens;
}

export function parseRppText(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let pos = 0;
  while (pos < lines.length && !lines[pos].trimStart().startsWith('<')) pos++;

  function parseBlock() {
    const headerToks = tokenize(lines[pos++].trimStart().slice(1));
    const node = {
      type: (headerToks[0] || '').toUpperCase(),
      args: headerToks.slice(1),
      props: new Map(),
      children: [],
    };
    while (pos < lines.length) {
      const t = lines[pos].trimStart();
      if (!t || t[0] === ';') { pos++; continue; }
      if (t === '>') { pos++; break; }
      if (t[0] === '<') { node.children.push(parseBlock()); continue; }
      const toks = tokenize(t);
      if (toks.length) {
        const key = toks[0].toUpperCase();
        const vals = toks.slice(1);
        if (!node.props.has(key)) node.props.set(key, []);
        node.props.get(key).push(vals);
      }
      pos++;
    }
    return node;
  }
  return parseBlock();
}

/** First occurrence of a property, as string[]. */
export const getProp     = (n, k) => n.props.get(k.toUpperCase())?.[0] ?? null;
/** All occurrences of a property. */
export const getAllProps  = (n, k) => n.props.get(k.toUpperCase()) ?? [];
/** First child block of given type. */
export const getChild    = (n, t) => n.children.find(c => c.type === t.toUpperCase()) ?? null;
/** All child blocks of given type. */
export const getChildren = (n, t) => n.children.filter(c => c.type === t.toUpperCase());
