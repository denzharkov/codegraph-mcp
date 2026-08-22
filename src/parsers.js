// Cross-platform tree-sitter loading: WASM grammars via web-tree-sitter,
// no native compilation. Works identically on Windows / macOS / Linux.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

let ParserCtor = null;
let LanguageLoader = null;
let sharedParser = null;
const languageCache = new Map();

function wasmDir() {
  return path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
}

export async function initParsers() {
  if (ParserCtor) return;
  const m = await import('web-tree-sitter');
  // API shim: <=0.24 exports default Parser with static Language,
  // >=0.25 exports named { Parser, Language }.
  const P = m.default || m.Parser;
  await P.init();
  ParserCtor = P;
  LanguageLoader = m.Language && m.Language.load ? m.Language : P.Language;
  sharedParser = new ParserCtor();
}

export async function getLanguage(grammar) {
  if (languageCache.has(grammar)) return languageCache.get(grammar);
  const file = path.join(wasmDir(), `tree-sitter-${grammar}.wasm`);
  if (!fs.existsSync(file)) {
    languageCache.set(grammar, null);
    return null;
  }
  const lang = await LanguageLoader.load(file);
  languageCache.set(grammar, lang);
  return lang;
}

export function parseWith(language, source) {
  sharedParser.setLanguage(language);
  return sharedParser.parse(source);
}
