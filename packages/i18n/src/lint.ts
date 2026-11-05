import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';

/** Attributes that are read or seen by people (and so must come from the catalog). */
const VISIBLE_ATTRIBUTES = new Set(['title', 'label', 'placeholder', 'aria-label', 'description', 'alt', 'submitLabel', 'confirmLabel', 'hint', 'empty', 'emptyLabel', 'nextLabel', 'noneLabel']);

/** Text that is the same in every language: the brand, formats, codes, symbols, example addresses. */
const LANGUAGE_NEUTRAL = /^(?:ZIPTV|M3U|EPG|MRR|CSV|SLA|GE|HD|4K|[A-Z]{2,3}|\.m3u.*|https?:\/\/\S*|env:\S+|[\s\d\W_]*)$/;

export interface HardcodedText {
  file: string;
  line: number;
  text: string;
}

/**
 * User-facing text written directly in JSX instead of coming from the translations: what a person
 * would see in English whatever language they chose. Used by each app's test suite as a lint rule.
 */
export function findHardcodedText(root: string): HardcodedText[] {
  const found: HardcodedText[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'i18n' && name !== 'test' && name !== 'node_modules') walk(path);
      } else if (name.endsWith('.tsx') && !name.includes('.test.')) {
        check(path);
      }
    }
  };
  const check = (path: string) => {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const report = (node: ts.Node, text: string) => {
      const value = text.replace(/\s+/g, ' ').trim();
      if (/[A-Za-z]{2,}/.test(value) && !LANGUAGE_NEUTRAL.test(value)) found.push({ file: relative(root, path), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: value });
    };
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) report(node, node.getText());
      else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer) && VISIBLE_ATTRIBUTES.has(node.name.getText())) report(node, node.initializer.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  walk(root);
  return found;
}
