import * as csstree from 'css-tree';

// Email CSS, sanitised (#134). Style sheets and style attributes come from the sender, and CSS can
// load things (url(), image-set(), @import, @font-face) and, in old engines, run things
// (expression(), behavior, -moz-binding). DOMPurify leaves CSS alone, so it is parsed here with a
// spec-following parser (css-tree) and rebuilt from what is allowed:
//
// - at-rules: only @media, @supports and @keyframes (no @import, @font-face, @namespace, @property,
//   @counter-style, or anything Commander doesn't know);
// - declarations: no custom properties (`--x: url(…)` with var(--x) would hide a URL), no behaviours
//   or bindings, nothing a parser couldn't read (Raw), and no function that builds an image or reads
//   a value at run time (image-set, cross-fade, element, var, env, attr…);
// - url(): the caller decides what each becomes (one of Commander's handlers, or nothing, when the
//   image is held back or isn't allowed, in which case it becomes `none`);
// - backslash escapes anywhere in a property, function, selector or at-rule name are refused, since
//   they are how "url(" or "@import" is disguised from filters (css-tree compares names as written,
//   a browser after unescaping them).
//
// Every declaration, selector and at-rule is then generated again and checked once more as text (no
// url() but Commander's, no escape, nothing banned), so a difference between how css-tree and the
// browser read something can only drop CSS, never let it through. Finally every "<" is escaped
// ("\3c "), so style sheet text can never close its <style> element.

/** What a url() in the CSS becomes: Commander's own URL for it, or null to drop it. */
export type CssUrl = (raw: string) => string | null;

const AT_RULES = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes', '-moz-keyframes']);
const BANNED_PROPERTIES = new Set([
  'behavior',
  '-ms-behavior',
  '-moz-binding',
  '-webkit-binding',
  'binding',
  'src',
  '-o-link',
  '-o-link-source',
]);
const BANNED_FUNCTIONS = new Set([
  'url',
  'src',
  'expression',
  'image',
  'image-set',
  '-webkit-image-set',
  'cross-fade',
  '-webkit-cross-fade',
  'element',
  '-moz-element',
  'paint',
  'var',
  'env',
  'attr',
  'if',
  'inherit',
]);
// What generated CSS may never contain (checked lower-case).
const BANNED_TEXT = [
  '\\',
  'expression(',
  'image-set(',
  'cross-fade(',
  'element(',
  '@import',
  '@font-face',
  '@namespace',
  'javascript:',
  'vbscript:',
  'behavior',
  'binding',
  'var(',
  'env(',
  'attr(',
];

type List = csstree.List<csstree.CssNode>;
type ListItem = csstree.ListItem<csstree.CssNode>;

const OPTIONS = {
  parseValue: true,
  parseAtrulePrelude: true,
  parseRulePrelude: false,
  parseCustomProperty: false,
  positions: false,
  onParseError: () => {},
} as const;

function safeText(text: string, allowedUrl: (url: string) => boolean): boolean {
  const lower = text.toLowerCase();
  if (BANNED_TEXT.some((banned) => lower.includes(banned))) return false;
  for (const match of lower.matchAll(/url\s*\(\s*["']?([^"')\s]*)/g)) {
    if (!allowedUrl(match[1] ?? '')) return false;
  }
  return true;
}

export function cssSanitiser(url: CssUrl, allowedUrl: (url: string) => boolean) {
  const generatedOk = (node: csstree.CssNode) => safeText(csstree.generate(node), allowedUrl);

  // Cleans a declaration's value in place. Returns false to drop the declaration.
  function cleanValue(value: csstree.CssNode): boolean {
    if (value.type === 'Raw') return false;
    let ok = true;
    csstree.walk(value, {
      enter(node: csstree.CssNode, item: ListItem | null, list: List | null) {
        if (!ok) return;
        if (node.type === 'Raw') ok = false;
        else if (node.type === 'Function') {
          const name = node.name.toLowerCase();
          if (name.includes('\\') || BANNED_FUNCTIONS.has(name)) ok = false;
        } else if (node.type === 'Url') {
          const replacement = url(node.value);
          if (replacement !== null) node.value = replacement;
          else if (item && list) list.replace(item, list.createItem({ type: 'Identifier', name: 'none' }));
          else ok = false;
        }
      },
    });
    return ok;
  }

  function cleanDeclaration(node: csstree.Declaration): boolean {
    const property = node.property.toLowerCase();
    if (property.includes('\\') || property.startsWith('--') || BANNED_PROPERTIES.has(property)) return false;
    if (!cleanValue(node.value)) return false;
    return generatedOk(node);
  }

  // Cleans a block's contents: declarations, and (CSS nesting) rules and allowed at-rules within.
  function cleanBlock(children: List, { nested }: { nested: boolean }) {
    children.forEach((node, item) => {
      let keep = false;
      if (node.type === 'Declaration') keep = cleanDeclaration(node);
      else if (nested && node.type === 'Rule') keep = cleanRule(node);
      else if (nested && node.type === 'Atrule') keep = cleanAtrule(node);
      if (!keep) children.remove(item);
    });
  }

  function cleanRule(node: csstree.Rule): boolean {
    if (!generatedOk(node.prelude)) return false;
    cleanBlock(node.block.children, { nested: true });
    return true;
  }

  function cleanAtrule(node: csstree.Atrule): boolean {
    const name = node.name.toLowerCase();
    if (!AT_RULES.has(name) || !node.block) return false;
    if (node.prelude && !generatedOk(node.prelude)) return false;
    cleanRules(node.block.children);
    return true;
  }

  // A style sheet's (or an at-rule block's) rules.
  function cleanRules(children: List) {
    children.forEach((node, item) => {
      const keep = (node.type === 'Rule' && cleanRule(node)) || (node.type === 'Atrule' && cleanAtrule(node));
      if (!keep) children.remove(item);
    });
  }

  const escapeMarkup = (css: string) => css.replace(/</g, '\\3c ');

  return {
    /** A <style> element's text. */
    stylesheet(css: string): string {
      const ast = csstree.parse(css, { ...OPTIONS, context: 'stylesheet' }) as csstree.StyleSheet;
      cleanRules(ast.children);
      return escapeMarkup(csstree.generate(ast));
    },
    /** A style attribute's text. */
    declarations(css: string): string {
      const ast = csstree.parse(css, { ...OPTIONS, context: 'declarationList' }) as csstree.DeclarationList;
      cleanBlock(ast.children, { nested: false });
      return escapeMarkup(csstree.generate(ast));
    },
  };
}
