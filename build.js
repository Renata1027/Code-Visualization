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
const pyTracer = read('js/py_tracer_src.js');
const pyRunner = read('js/py_runner.js');
const examples = read('js/examples.js');
const app = read('js/app.js');

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
