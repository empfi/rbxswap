#!/usr/bin/env node
'use strict';
const fs = require('fs');

// State machine strip of // and /* */ comments. Preserves line numbers for
// block comments (replaces with spaces), drops line-comment content but keeps
// the newline. Never touches content inside ' " ` strings or /regex/.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let mode = 'code'; // code | squote | dquote | template | regex
  let lineComment = false, blockComment = false;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (mode === 'squote') {
      out += c;
      if (c === '\\') { out += next || ''; i += 2; continue; }
      if (c === "'") mode = 'code';
      i++; continue;
    }
    if (mode === 'dquote') {
      out += c;
      if (c === '\\') { out += next || ''; i += 2; continue; }
      if (c === '"') mode = 'code';
      i++; continue;
    }
    if (mode === 'template') {
      out += c;
      if (c === '\\') { out += next || ''; i += 2; continue; }
      if (c === '`') mode = 'code';
      i++; continue;
    }
    if (mode === 'regex') {
      out += c;
      if (c === '\\') { out += next || ''; i += 2; continue; }
      if (c === '[') { /* char class */ }
      if (c === ']') { }
      if (c === '/') mode = 'code';
      i++; continue;
    }

    // code mode
    if (c === "'") { mode = 'squote'; out += c; i++; continue; }
    if (c === '"') { mode = 'dquote'; out += c; i++; continue; }
    if (c === '`') { mode = 'template'; out += c; i++; continue; }

    if (c === '/' && next === '/') {
      // Guard against URLs like http:// (immediately preceded by ':').
      if (!/:$/.test(out.slice(-2))) {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      out += c; i++; continue;
    }
    if (c === '/' && next === '*') {
      if (!/:$/.test(out.slice(-2))) {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
          if (src[i] === '\n') out += '\n';
          i++;
        }
        i += 2;
        continue;
      }
      out += c; i++; continue;
    }
    if (c === '/') {
      const prev = out.replace(/\s+$/, '').slice(-1);
      if ('=([{,;:!&|?+-*%~^<>'.includes(prev) || /\b(return|typeof|case|in|of|new|delete|void|instanceof|do|else)\s*$/.test(out.slice(-30))) {
        mode = 'regex'; out += c; i++; continue;
      }
    }
    if (c === '#') {
      // C# preprocessor / shebang: keep as-is (we only process C# for #if style; harmless)
      out += c; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

const files = process.argv.slice(2);
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const stripped = stripComments(src);
  fs.writeFileSync(f, stripped);
  console.log('stripped:', f);
}
