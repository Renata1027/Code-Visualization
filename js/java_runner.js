(function () {
  'use strict';

  function friendlyError(errStr) {
    if (!errStr) return null;
    if (errStr === 'STEP_LIMIT') return '执行步数超过上限，可能存在死循环或递归过深。已显示已执行的步骤。';
    if (errStr === 'TIME_LIMIT') return '执行超时（可能存在死循环）。已显示已执行的步骤。';
    if (errStr.startsWith('SYNTAX: ')) return '语法错误: ' + errStr.slice(8);
    if (errStr.startsWith('RUNTIME: ')) return '运行错误: ' + errStr.slice(9);
    return errStr;
  }

  function runJavaCode(code, entryExpr) {
    let raw;
    try {
      raw = window.JavaInterp.runCode(code, entryExpr || '');
    } catch (e) {
      return { steps: [], output: [], error: '运行环境内部错误: ' + (e && e.message ? e.message : String(e)), truncated: false };
    }
    return {
      steps: raw.steps || [],
      output: raw.output || [],
      error: friendlyError(raw.error),
      truncated: raw.error === 'STEP_LIMIT' || raw.error === 'TIME_LIMIT',
    };
  }

  window.JavaRunner = { runJavaCode };
})();
