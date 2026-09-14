#!/usr/bin/env node
// Inlines css/style.css and all js/*.js + vendor/acorn.js directly into index.html,
// so the shipped page has zero dependency on sibling files (only the optional
// Pyodide CDN script, loaded lazily and only when Python mode is first used).
// Run: node build.js
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const css = read('css/style.css');
const acorn = read('vendor/acorn.js');
const interpreter = read('js/interpreter.js');
// python/tracer.py is the single source of truth for the Python tracer; it is
// wrapped here (not hand-copied into a .js file) specifically to avoid the
// two ever drifting apart. String.raw is required, not a plain template
// literal: the tracer source contains Python escapes like '\n' that a normal
// template literal would decode into real newline characters, corrupting the
// embedded Python (this broke Python mode once already - see git history).
const pyTracerPy = read('python/tracer.py');
const pyTracer = 'window.PY_TRACER_SRC = String.raw`\n' + pyTracerPy + '`;\n';
const pyRunner = read('js/py_runner.js');
const examples = read('js/examples.js');
const app = read('js/app.js');

if (/`|\$\{/.test(pyTracerPy)) {
  throw new Error(
    'python/tracer.py contains a backtick or ${ — either would break out of the ' +
    'String.raw template literal it gets embedded in. Rewrite to avoid them.'
  );
}

let html = read('index.template.html');

// Use function replacers: String.replace() treats "$"-sequences specially in
// a string replacement (e.g. "$&", "$'"), which the JS sources are full of
// (template literals like `${x}`). A function replacer inserts the text as-is.
html = html.replace('/*__INLINE_CSS__*/', () => css);
html = html.replace('//__INLINE_ACORN__', () => acorn);
html = html.replace('//__INLINE_INTERPRETER__', () => interpreter);
html = html.replace('//__INLINE_PY_TRACER__', () => pyTracer);
html = html.replace('//__INLINE_PY_RUNNER__', () => pyRunner);
html = html.replace('//__INLINE_EXAMPLES__', () => examples);
html = html.replace('//__INLINE_APP__', () => app);

fs.writeFileSync(path.join(root, 'index.html'), html);
console.log('Wrote index.html (' + (html.length / 1024).toFixed(1) + ' KB)');
