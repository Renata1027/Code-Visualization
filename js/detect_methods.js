// Best-effort (regex-based, not a real parse) detection of callable
// class/top-level methods in the user's pasted code, so the "调用表达式"
// field can just be arguments (LeetCode-style) instead of a full call
// expression. Falls back to "自定义表达式" (raw expression) mode when
// nothing is detected or the user picks it explicitly.
(function () {
  'use strict';

  const JAVA_JS_SKIP_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'try', 'else', 'do', 'function']);

  // Finds the index of the `}` matching the `{` at code[openIdx], skipping
  // over string/char/template literals and comments so braces inside them
  // don't throw off the count.
  function findMatchingBrace(code, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < code.length; i++) {
      const c = code[i];
      if (c === '"' || c === "'" || c === '`') {
        const quote = c;
        i++;
        while (i < code.length && code[i] !== quote) { if (code[i] === '\\') i++; i++; }
        continue;
      }
      if (c === '/' && code[i + 1] === '/') { while (i < code.length && code[i] !== '\n') i++; continue; }
      if (c === '/' && code[i + 1] === '*') { i += 2; while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++; i++; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    return code.length - 1;
  }

  function splitParams(s) {
    s = (s || '').trim();
    if (!s) return [];
    return s.split(',').map((p) => p.trim()).filter(Boolean);
  }

  function lastToken(paramText) {
    // Java/typed params look like "int[] nums" or "List<Integer> path" -> take the identifier name.
    const cleaned = paramText.replace(/<[^<>]*>/g, '').trim();
    const parts = cleaned.split(/\s+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1].replace(/^\.\.\./, '').replace(/\[\]$/, '') : paramText;
  }

  function detectJavaScript(code) {
    const results = [];
    const classRe = /\bclass\s+([A-Za-z_$][\w$]*)[^{]*\{/g;
    let m;
    while ((m = classRe.exec(code))) {
      const className = m[1];
      const bodyStart = m.index + m[0].length;
      const bodyEnd = findMatchingBrace(code, bodyStart - 1);
      const body = code.slice(bodyStart, bodyEnd);
      const methodRe = /(?:^|[;{}\s])(static\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
      let mm;
      while ((mm = methodRe.exec(body))) {
        const isStatic = !!mm[1];
        const name = mm[2];
        if (name === className || name === 'constructor' || JAVA_JS_SKIP_NAMES.has(name)) continue;
        const params = splitParams(mm[3]);
        results.push({
          label: `${className}.${name}(${params.join(', ')})`,
          prefix: isStatic ? `${className}.${name}` : `new ${className}().${name}`,
          params,
        });
      }
    }
    const funcRe = /(?:^|\n)\s*function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
    while ((m = funcRe.exec(code))) {
      const name = m[1];
      const params = splitParams(m[2]);
      results.push({ label: `${name}(${params.join(', ')})`, prefix: name, params });
    }
    const varFuncRe = /(?:^|\n)\s*(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*function\s*\(([^)]*)\)/g;
    while ((m = varFuncRe.exec(code))) {
      const name = m[1];
      if (results.some((r) => r.prefix === name)) continue;
      const params = splitParams(m[2]);
      results.push({ label: `${name}(${params.join(', ')})`, prefix: name, params });
    }
    return results;
  }

  function detectPython(code) {
    const results = [];
    const lines = code.split('\n');
    let currentClass = null;
    for (const line of lines) {
      const classM = /^class\s+([A-Za-z_]\w*)/.exec(line);
      if (classM) { currentClass = classM[1]; continue; }
      const methodM = /^\s{2,}def\s+([A-Za-z_]\w*)\s*\(\s*self\s*(?:,\s*(.*))?\)\s*:/.exec(line);
      if (methodM && currentClass && /^\s{4}def\s/.test(line)) {
        const name = methodM[1];
        if (name.startsWith('__')) continue;
        const params = methodM[2] ? splitParams(methodM[2]).map((p) => p.split('=')[0].trim()) : [];
        results.push({ label: `${currentClass}.${name}(${params.join(', ')})`, prefix: `${currentClass}().${name}`, params });
        continue;
      }
      const topM = /^def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/.exec(line);
      if (topM) {
        const name = topM[1];
        const params = splitParams(topM[2]).map((p) => p.split('=')[0].trim());
        results.push({ label: `${name}(${params.join(', ')})`, prefix: name, params });
      }
    }
    return results;
  }

  function detectJava(code) {
    const results = [];
    const classRe = /\bclass\s+([A-Za-z_]\w*)[^{]*\{/g;
    let m;
    while ((m = classRe.exec(code))) {
      const className = m[1];
      const bodyStart = m.index + m[0].length;
      const bodyEnd = findMatchingBrace(code, bodyStart - 1);
      const body = code.slice(bodyStart, bodyEnd);
      const methodRe = /(?:^|[;{}])\s*((?:(?:public|private|protected|static|final|synchronized)\s+)*)[\w<>\[\],.\s]+?\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:throws\s+[\w,\s.]+)?\{/g;
      let mm;
      while ((mm = methodRe.exec(body))) {
        const modifiers = mm[1] || '';
        const isStatic = /\bstatic\b/.test(modifiers);
        const isPrivate = /\bprivate\b/.test(modifiers);
        const name = mm[2];
        if (name === className || name === 'main' || JAVA_JS_SKIP_NAMES.has(name)) continue;
        const params = splitParams(mm[3]).map(lastToken);
        results.push({
          label: `${className}.${name}(${params.join(', ')})`,
          prefix: isStatic ? `${className}.${name}` : `new ${className}().${name}`,
          params,
          rank: isPrivate ? 1 : 0,
        });
      }
    }
    return results;
  }

  function detectCallables(language, code) {
    let results = [];
    try {
      if (language === 'javascript') results = detectJavaScript(code);
      else if (language === 'python') results = detectPython(code);
      else if (language === 'java') results = detectJava(code);
    } catch (e) {
      // best-effort: never let a detection bug block running the code
      return [];
    }
    // Stable sort: public/non-helper methods first, so the default
    // selection lands on the method you're most likely testing, not an
    // internal helper like a recursive backtrack() worker.
    return results
      .map((r, i) => ({ r, i }))
      .sort((a, b) => (a.r.rank || 0) - (b.r.rank || 0) || a.i - b.i)
      .map((x) => x.r);
  }

  window.detectCallables = detectCallables;
})();
