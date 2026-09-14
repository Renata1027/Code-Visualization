(function () {
  'use strict';

  const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';

  let pyodidePromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('无法从 CDN 加载脚本'));
      document.head.appendChild(s);
    });
  }

  async function getPyodide(onStatus) {
    if (!pyodidePromise) {
      pyodidePromise = (async () => {
        if (typeof loadPyodide !== 'function') {
          onStatus && onStatus('正在加载 Python 运行环境（首次使用需下载几 MB，请稍候）…');
          await loadScript(PYODIDE_CDN);
        }
        onStatus && onStatus('正在初始化 Python 解释器…');
        const pyodide = await loadPyodide();
        return pyodide;
      })();
    }
    return pyodidePromise;
  }

  function friendlyError(errStr) {
    if (!errStr) return null;
    if (errStr === 'STEP_LIMIT') return '执行步数超过上限，可能存在死循环或递归过深。已显示已执行的步骤。';
    if (errStr === 'TIME_LIMIT') return '执行超时（可能存在死循环）。已显示已执行的步骤。';
    if (errStr.startsWith('SYNTAX: ')) return '语法错误: ' + errStr.slice(8);
    if (errStr.startsWith('RUNTIME: ')) return '运行错误: ' + errStr.slice(9);
    return errStr;
  }

  function normalizeResult(raw) {
    const err = friendlyError(raw.error);
    return {
      steps: raw.steps || [],
      output: raw.output || [],
      error: err,
      truncated: raw.error === 'STEP_LIMIT' || raw.error === 'TIME_LIMIT',
    };
  }

  async function runPythonCode(code, entryExpr, onStatus) {
    let pyodide;
    try {
      pyodide = await getPyodide(onStatus);
    } catch (e) {
      return {
        steps: [],
        output: [],
        error: 'Python 运行环境加载失败：需要联网访问 cdn.jsdelivr.net 才能首次加载 Python 运行时，请检查网络连接后重试。（' + e.message + '）',
        truncated: false,
      };
    }
    try {
      onStatus && onStatus('正在运行…');
      pyodide.runPython(window.PY_TRACER_SRC);
      pyodide.globals.set('__user_source__', code);
      pyodide.globals.set('__entry_expr__', entryExpr || '');
      const resultJson = pyodide.runPython(
        'import json as __json\n__json.dumps(_run(__user_source__, __entry_expr__))'
      );
      const raw = JSON.parse(resultJson);
      return normalizeResult(raw);
    } catch (e) {
      return { steps: [], output: [], error: '运行环境内部错误: ' + e.message, truncated: false };
    }
  }

  window.PyRunner = { runPythonCode };
})();
