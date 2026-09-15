(function () {
  'use strict';

  const LINE_HEIGHT = 21;
  const ENTRY_VAR = '__entry_result__';

  const el = {
    langSwitch: document.getElementById('langSwitch'),
    exampleSelect: document.getElementById('exampleSelect'),
    runBtn: document.getElementById('runBtn'),
    clearBtn: document.getElementById('clearBtn'),
    heatmapToggle: document.getElementById('heatmapToggle'),
    editorWrap: document.getElementById('editorWrap'),
    gutter: document.getElementById('gutter'),
    codeArea: document.getElementById('codeArea'),
    lineHighlight: document.getElementById('lineHighlight'),
    codeInput: document.getElementById('codeInput'),
    entryInput: document.getElementById('entryInput'),
    methodSelect: document.getElementById('methodSelect'),
    tcTabs: document.getElementById('tcTabs'),
    statusBox: document.getElementById('statusBox'),
    errorBox: document.getElementById('errorBox'),
    outputResultBox: document.getElementById('outputResultBox'),
    outputResultValue: document.getElementById('outputResultValue'),
    resultsBlock: document.getElementById('resultsBlock'),
    resultsList: document.getElementById('resultsList'),
    firstBtn: document.getElementById('firstBtn'),
    prevBtn: document.getElementById('prevBtn'),
    playBtn: document.getElementById('playBtn'),
    nextBtn: document.getElementById('nextBtn'),
    lastBtn: document.getElementById('lastBtn'),
    progressSlider: document.getElementById('progressSlider'),
    stepCounter: document.getElementById('stepCounter'),
    speedSlider: document.getElementById('speedSlider'),
    currentStepBanner: document.getElementById('currentStepBanner'),
    framesView: document.getElementById('framesView'),
    timelineView: document.getElementById('timelineView'),
    consoleView: document.getElementById('consoleView'),
  };

  let state = {
    language: 'javascript',
    ctx: null,
    lineHits: {},
    index: -1,
    playing: false,
    playTimer: null,
    userLineCount: 0,
    running: false,
    cases: [{ name: '用例 1', method: 'manual', args: '' }],
    activeCase: 0,
    detected: [],
  };

  // ---------------- language switch ----------------
  el.langSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('.lang-btn');
    if (!btn || btn.classList.contains('active')) return;
    Array.from(el.langSwitch.children).forEach((b) => b.classList.toggle('active', b === btn));
    state.language = btn.dataset.lang;
    populateExamples();
    const names = Object.keys(window.EXAMPLES[state.language] || {});
    if (names.length) loadExample(names[0]);
    resetPlayback();
  });

  // ---------------- example dropdown ----------------
  function populateExamples() {
    el.exampleSelect.innerHTML = '<option value="">— 选择示例代码 —</option>';
    const examples = window.EXAMPLES[state.language] || {};
    Object.keys(examples).forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      el.exampleSelect.appendChild(opt);
    });
  }

  // ---------------- method auto-detection ----------------
  // Instead of asking the user to write a full call expression, we scan the
  // pasted code for callable methods/functions and let them pick one from a
  // dropdown, typing only the arguments (LeetCode-style). "自定义表达式"
  // falls back to the old raw-expression behavior when nothing is detected
  // or matched.
  function refreshDetection() {
    state.detected = (window.detectCallables && window.detectCallables(state.language, el.codeInput.value)) || [];
    el.methodSelect.innerHTML = '';
    state.detected.forEach((m, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = m.label;
      el.methodSelect.appendChild(opt);
    });
    const manualOpt = document.createElement('option');
    manualOpt.value = 'manual';
    manualOpt.textContent = '自定义表达式…';
    el.methodSelect.appendChild(manualOpt);
  }

  function methodByValue(val) {
    if (val === 'manual' || val === undefined || val === null) return null;
    const idx = Number(val);
    return state.detected[idx] || null;
  }

  // Builds the actual call expression to execute from a case's {method, args}:
  // a detected method wraps the bare args in its call prefix (LeetCode-style,
  // e.g. "new Solution().subsets(" + "[1, 2, 3]" + ")"); "manual" mode treats
  // `args` as the full expression already, unchanged.
  function computeEntryExpr(caseObj) {
    if (!caseObj) return '';
    const m = methodByValue(caseObj.method);
    const args = (caseObj.args || '').trim();
    if (m) return `${m.prefix}(${args})`;
    return args;
  }

  function updateEntryPlaceholder() {
    const c = state.cases[state.activeCase];
    const m = methodByValue(c && c.method);
    el.entryInput.placeholder = m
      ? (m.params.length ? `参数，例如：${m.params.join(', ')}` : '（无参数，留空即可）')
      : '完整调用表达式，例如：Solution().subsets([1, 2, 3])';
  }

  // Matches an example's full call expression (e.g. "new Solution().subsets([1,2,3])")
  // back to a detected method + its bare arguments, so examples still work
  // with the args-only UI without having to hand-maintain both forms.
  function matchEntryToMethod(entry, detected) {
    if (!entry) return { method: 'manual', args: '' };
    for (let i = 0; i < detected.length; i++) {
      const p = detected[i].prefix;
      if (entry.startsWith(p + '(') && entry.endsWith(')')) {
        return { method: String(i), args: entry.slice(p.length + 1, -1) };
      }
    }
    return { method: 'manual', args: entry };
  }

  function loadExample(name) {
    const ex = (window.EXAMPLES[state.language] || {})[name];
    if (!ex) return;
    el.codeInput.value = ex.code;
    refreshDetection();
    const matched = matchEntryToMethod(ex.entry || '', state.detected);
    state.cases = [{ name: '用例 1', method: matched.method, args: matched.args }];
    state.activeCase = 0;
    el.exampleSelect.value = name;
    applyActiveCaseToUI();
    renderTabs();
    hideResults();
    resizeEditor();
    renderGutter();
    onCodeChanged();
  }

  el.exampleSelect.addEventListener('change', () => {
    if (el.exampleSelect.value) loadExample(el.exampleSelect.value);
  });

  // ---------------- test case tabs (LeetCode-style) ----------------
  function renderTabs() {
    el.tcTabs.innerHTML = '';
    state.cases.forEach((c, i) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tc-tab' + (i === state.activeCase ? ' active' : '');
      const closeHtml = state.cases.length > 1 ? `<span class="tc-close" data-i="${i}" title="删除用例">×</span>` : '';
      tab.innerHTML = `<span>${escapeHtml(c.name)}</span>${closeHtml}`;
      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('tc-close')) {
          e.stopPropagation();
          removeCase(i);
          return;
        }
        switchCase(i);
      });
      el.tcTabs.appendChild(tab);
    });
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'tc-add';
    addBtn.textContent = '+ 用例';
    addBtn.title = '添加一个测试用例';
    addBtn.addEventListener('click', addCase);
    el.tcTabs.appendChild(addBtn);
  }

  function syncActiveEntry() {
    const c = state.cases[state.activeCase];
    if (!c) return;
    c.method = el.methodSelect.value;
    c.args = el.entryInput.value;
  }

  function applyActiveCaseToUI() {
    const c = state.cases[state.activeCase];
    if (!c) return;
    const hasOption = Array.from(el.methodSelect.options).some((o) => o.value === c.method);
    el.methodSelect.value = hasOption ? c.method : 'manual';
    if (!hasOption) c.method = 'manual';
    el.entryInput.value = c.args || '';
    updateEntryPlaceholder();
  }

  function switchCase(i) {
    syncActiveEntry();
    state.activeCase = i;
    applyActiveCaseToUI();
    renderTabs();
    showOutputResult(null);
    if (el.resultsBlock && !el.resultsBlock.hidden) {
      Array.from(el.resultsList.children).forEach((row, idx) => row.classList.toggle('active-case', idx === i));
    }
  }

  function addCase() {
    syncActiveEntry();
    const cur = state.cases[state.activeCase];
    state.cases.push({ name: '用例 ' + (state.cases.length + 1), method: cur.method, args: cur.args });
    state.activeCase = state.cases.length - 1;
    applyActiveCaseToUI();
    renderTabs();
  }

  function removeCase(i) {
    if (state.cases.length <= 1) return;
    state.cases.splice(i, 1);
    state.cases.forEach((c, idx) => { c.name = '用例 ' + (idx + 1); });
    if (state.activeCase >= state.cases.length) state.activeCase = state.cases.length - 1;
    else if (state.activeCase > i) state.activeCase--;
    applyActiveCaseToUI();
    renderTabs();
  }

  el.methodSelect.addEventListener('change', () => {
    syncActiveEntry();
    updateEntryPlaceholder();
  });

  // ---------------- editor (textarea + gutter) ----------------
  function currentLineCount() {
    return el.codeInput.value.split('\n').length;
  }

  function resizeEditor() {
    el.codeInput.style.height = 'auto';
    const h = Math.max(el.codeInput.scrollHeight, currentLineCount() * LINE_HEIGHT + 20);
    el.codeInput.style.height = h + 'px';
  }

  function renderGutter() {
    const n = currentLineCount();
    const showHeat = el.heatmapToggle.checked;
    let html = '';
    for (let i = 1; i <= n; i++) {
      const hit = state.lineHits[i];
      const heatHtml = hit
        ? `<span class="heat ${showHeat ? 'show' : ''}" title="第 ${i} 行执行了 ${hit} 次">${hit}</span>`
        : `<span class="heat"></span>`;
      html += `<div class="gline"><span class="lineno">${i}</span>${heatHtml}</div>`;
    }
    el.gutter.innerHTML = html;
  }

  el.codeInput.addEventListener('input', () => {
    resizeEditor();
    renderGutter();
    refreshDetection();
    applyActiveCaseToUI();
    onCodeChanged();
  });
  el.codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = el.codeInput.selectionStart, en = el.codeInput.selectionEnd;
      el.codeInput.setRangeText('  ', s, en, 'end');
      resizeEditor();
      renderGutter();
      onCodeChanged();
    }
  });
  el.entryInput.addEventListener('input', () => { syncActiveEntry(); onCodeChanged(); });

  function onCodeChanged() {
    if (state.ctx) {
      showError(null);
      showOutputResult(null);
    }
  }

  el.heatmapToggle.addEventListener('change', renderGutter);

  el.clearBtn.addEventListener('click', () => {
    el.codeInput.value = '';
    refreshDetection();
    state.cases = [{ name: '用例 1', method: 'manual', args: '' }];
    state.activeCase = 0;
    applyActiveCaseToUI();
    el.exampleSelect.value = '';
    renderTabs();
    hideResults();
    resizeEditor();
    resetPlayback();
    renderGutter();
    el.codeInput.focus();
  });

  // ---------------- status / error / output-result ----------------
  function showStatus(msg) {
    if (!msg) { el.statusBox.hidden = true; el.statusBox.textContent = ''; return; }
    el.statusBox.hidden = false;
    el.statusBox.textContent = msg;
  }

  function showError(msg) {
    if (!msg) { el.errorBox.hidden = true; el.errorBox.textContent = ''; return; }
    el.errorBox.hidden = false;
    el.errorBox.textContent = msg;
  }

  function showOutputResult(text) {
    if (text === null || text === undefined) { el.outputResultBox.hidden = true; return; }
    el.outputResultBox.hidden = false;
    el.outputResultValue.textContent = text;
  }

  function hideResults() {
    el.resultsBlock.hidden = true;
    el.resultsList.innerHTML = '';
  }

  function renderResults(results, activeIdx) {
    const withEntry = results.filter((r) => !r.skip);
    if (withEntry.length === 0) { hideResults(); return; }
    el.resultsBlock.hidden = false;
    el.resultsList.innerHTML = '';
    results.forEach((r, i) => {
      if (r.skip) return;
      const row = document.createElement('div');
      row.className = 'result-row ' + (r.ok ? 'ok' : 'fail') + (i === activeIdx ? ' active-case' : '');
      row.innerHTML = `<span class="rr-status">${r.ok ? '✓' : '✕'}</span>` +
        `<span class="rr-name">${escapeHtml(r.name)}</span>` +
        `<span class="rr-entry">${escapeHtml(r.entry)}</span>` +
        `<span class="rr-output">${escapeHtml(String(r.output))}</span>`;
      row.title = String(r.output);
      row.addEventListener('click', () => {
        if (state.running) return;
        switchCase(i);
        runCode();
      });
      el.resultsList.appendChild(row);
    });
  }

  // ---------------- run ----------------
  el.runBtn.addEventListener('click', runCode);

  async function runOnce(code, entry) {
    if (state.language === 'python') {
      return await window.PyRunner.runPythonCode(code, entry, showStatus);
    }
    if (state.language === 'java') {
      return window.JavaRunner.runJavaCode(code, entry);
    }
    const fullCode = code + (entry ? `\nvar ${ENTRY_VAR} = (${entry});\n` : '');
    return window.CodeViz.runCode(fullCode);
  }

  async function runCode() {
    if (state.running) return;
    stopPlaying();
    syncActiveEntry();
    const code = el.codeInput.value;
    if (!code.trim()) { showError('请先输入或粘贴一些代码。'); return; }

    state.running = true;
    el.runBtn.disabled = true;
    showError(null);
    showOutputResult(null);
    state.userLineCount = code.split('\n').length;

    const activeEntry = computeEntryExpr(state.cases[state.activeCase]);
    let ctx;
    try {
      if (state.language === 'python') showStatus('准备运行…');
      ctx = await runOnce(code, activeEntry);

      state.ctx = ctx;

      const hits = {};
      ctx.steps.forEach((s) => { hits[s.line] = (hits[s.line] || 0) + 1; });
      state.lineHits = hits;
      renderGutter();

      if (ctx.error && ctx.steps.length === 0) {
        showError(ctx.error);
        state.index = -1;
        el.progressSlider.max = 0;
        el.progressSlider.value = 0;
        renderTimeline();
        renderFrames(null);
        renderConsole(0);
        updateStepCounter();
        setControlsEnabled(false);
        el.currentStepBanner.textContent = '代码存在错误，请修正后重新运行。';
        hideResults();
        return;
      }

      if (ctx.error) showError(ctx.error);

      setControlsEnabled(ctx.steps.length > 0);
      el.progressSlider.max = Math.max(0, ctx.steps.length - 1);
      renderTimeline();
      goToStep(0);

      if (activeEntry) {
        const result = findEntryResult(ctx);
        showOutputResult(result === undefined ? null : result);
      }

      // Run every other case (that has a call expression) to populate the
      // "测试结果" summary, LeetCode-style. The active case reuses `ctx`.
      const results = [];
      for (let i = 0; i < state.cases.length; i++) {
        const c = state.cases[i];
        const entry = computeEntryExpr(c);
        if (!entry) { results.push({ skip: true }); continue; }
        let caseCtx;
        if (i === state.activeCase) caseCtx = ctx;
        else {
          if (state.language === 'python') showStatus(`正在运行 ${c.name}…`);
          caseCtx = await runOnce(code, entry);
        }
        const failed = !!caseCtx.error && caseCtx.steps.length === 0;
        const val = failed ? undefined : findEntryResult(caseCtx);
        results.push({
          name: c.name,
          entry,
          ok: !failed,
          output: failed ? caseCtx.error : (val === undefined ? '(无返回值)' : val),
        });
      }
      renderResults(results, state.activeCase);
    } finally {
      showStatus(null);
      state.running = false;
      el.runBtn.disabled = false;
    }
  }

  function findEntryResult(ctx) {
    for (let i = ctx.steps.length - 1; i >= 0; i--) {
      const frames = ctx.steps[i].frames;
      for (const f of frames) {
        if (Object.prototype.hasOwnProperty.call(f.vars, ENTRY_VAR)) {
          return f.vars[ENTRY_VAR].text;
        }
      }
    }
    return undefined;
  }

  function setControlsEnabled(enabled) {
    [el.firstBtn, el.prevBtn, el.playBtn, el.nextBtn, el.lastBtn, el.progressSlider].forEach((b) => {
      b.disabled = !enabled;
    });
  }

  // ---------------- rendering a step ----------------
  function goToStep(i) {
    if (!state.ctx || !state.ctx.steps.length) return;
    i = Math.max(0, Math.min(i, state.ctx.steps.length - 1));
    state.index = i;
    const step = state.ctx.steps[i];
    const isEntryStep = step.line > state.userLineCount;

    if (isEntryStep) {
      el.lineHighlight.hidden = true;
    } else {
      el.lineHighlight.hidden = false;
      el.lineHighlight.style.top = (step.line - 1) * LINE_HEIGHT + 10 + 'px';
      scrollLineIntoView(step.line);
    }

    if (isEntryStep) {
      const fullExpr = computeEntryExpr(state.cases[state.activeCase]);
      el.currentStepBanner.innerHTML =
        `<span class="kw">调用入口</span>　<code>${escapeHtml(fullExpr)}</code>`;
    } else {
      const kindLabel = KIND_LABEL[step.kind] || '';
      el.currentStepBanner.innerHTML =
        `第 <b>${step.line}</b> 行　<span class="kw">${kindLabel}</span>　<code>${escapeHtml(step.label)}</code>`;
    }

    renderFrames(step);
    renderConsole(step.outputLen);
    el.progressSlider.value = i;
    updateStepCounter();
    highlightTimeline(i);
  }

  const KIND_LABEL = {
    decl: '声明',
    expr: '执行',
    stmt: '执行',
    assign: '赋值',
    if: '条件判断',
    'loop-test': '循环条件',
    'loop-update': '循环更新',
    'loop-iter': '循环迭代',
    call: '函数调用',
    return: '返回',
    break: '跳出循环',
    continue: '继续循环',
    throw: '异常',
    catch: '捕获异常',
    switch: 'switch 分支',
  };

  function updateStepCounter() {
    const total = state.ctx ? state.ctx.steps.length : 0;
    el.stepCounter.textContent = total ? `${state.index + 1} / ${total}` : '0 / 0';
  }

  function scrollLineIntoView(line) {
    const top = (line - 1) * LINE_HEIGHT;
    const wrapTop = el.editorWrap.scrollTop;
    const wrapH = el.editorWrap.clientHeight;
    if (top < wrapTop + 20) {
      el.editorWrap.scrollTop = Math.max(0, top - 20);
    } else if (top + LINE_HEIGHT > wrapTop + wrapH - 20) {
      el.editorWrap.scrollTop = top + LINE_HEIGHT - wrapH + 20;
    }
  }

  // ---------------- shape-based variable visualization ----------------
  // Renders the structured {kind, ...} descriptors the interpreters attach to
  // every variable: primitives as plain text, arrays as boxed cells, linked
  // lists as chained boxes with arrows, binary trees as an actual tree
  // diagram, maps/sets as chips, and generic objects as field cards.
  function renderShape(shape, depth) {
    depth = depth || 0;
    if (!shape) return '<span class="shape-null">null</span>';
    switch (shape.kind) {
      case 'null': return `<span class="shape-null">${escapeHtml(shape.text)}</span>`;
      case 'array': return renderArrayShape(shape, depth);
      case 'list': return renderListShape(shape);
      case 'tree': return renderTreeShape(shape);
      case 'map': return renderMapShape(shape, depth);
      case 'set': return renderSetShape(shape, depth);
      case 'object': return renderObjectShape(shape, depth);
      default: return `<span class="shape-primitive">${escapeHtml(shape.text || '')}</span>`;
    }
  }

  function renderArrayShape(shape, depth) {
    if (depth > 3) return `<span class="shape-primitive">${escapeHtml(shape.text)}</span>`;
    if (!shape.items.length) return `<span class="shape-primitive">[]</span>`;
    const cells = shape.items.map((it, i) => {
      const nested = it && it.kind === 'array';
      return `<div class="arr-cell ${nested ? 'nested' : ''}">
          <div class="arr-val">${renderShape(it, depth + 1)}</div>
          <div class="arr-idx">${i}</div>
        </div>`;
    }).join('');
    return `<div class="shape-array">${cells}${shape.truncated ? '<div class="arr-more">…</div>' : ''}</div>`;
  }

  function renderListShape(shape) {
    if (!shape.nodes.length) return `<span class="shape-primitive">null</span>`;
    const boxes = shape.nodes.map((n, i) => {
      const fieldsHtml = (n.order || Object.keys(n.fields)).map((k) =>
        `<div class="list-field"><span class="lf-name">${escapeHtml(k)}</span><span class="lf-val">${renderShape(n.fields[k], 1)}</span></div>`
      ).join('');
      const showArrow = i < shape.nodes.length - 1 || shape.cyclicTo !== null;
      return `<div class="list-node-wrap">
          <div class="list-node">${fieldsHtml}</div>
          ${showArrow ? '<div class="list-arrow">→</div>' : ''}
        </div>`;
    }).join('');
    let tail;
    if (shape.cyclicTo !== null) {
      const targetIdx = shape.nodes.findIndex((n) => n.id === shape.cyclicTo);
      tail = `<div class="list-cycle" title="回到第 ${targetIdx + 1} 个节点">⟲ 循环</div>`;
    } else {
      tail = `<div class="list-null">null</div>`;
    }
    return `<div class="shape-list">${boxes}${tail}</div>`;
  }

  function renderTreeNode(node) {
    if (!node) return `<div class="tree-slot"><div class="tree-box empty">∅</div></div>`;
    const order = node.order || Object.keys(node.fields);
    const label = order.length
      ? order.map((k) => renderShape(node.fields[k], 1)).join(', ')
      : '·';
    const hasChildren = !!(node.left || node.right);
    return `<div class="tree-slot">
        <div class="tree-box">${label}</div>
        ${hasChildren ? `<div class="tree-children">
            <div class="tree-child">${renderTreeNode(node.left)}</div>
            <div class="tree-child">${renderTreeNode(node.right)}</div>
          </div>` : ''}
      </div>`;
  }
  function renderTreeShape(shape) {
    if (!shape.root) return `<span class="shape-primitive">null</span>`;
    return `<div class="shape-tree">${renderTreeNode(shape.root)}</div>`;
  }

  function renderMapShape(shape, depth) {
    if (!shape.entries.length) return `<span class="shape-primitive">{}</span>`;
    const rows = shape.entries.map((e) =>
      `<div class="map-row"><span class="map-k">${renderShape(e.k, depth + 1)}</span><span class="map-arrow">→</span><span class="map-v">${renderShape(e.v, depth + 1)}</span></div>`
    ).join('');
    return `<div class="shape-map">${rows}</div>`;
  }

  function renderSetShape(shape, depth) {
    if (!shape.items.length) return `<span class="shape-primitive">{}</span>`;
    return `<div class="shape-set">${shape.items.map((x) => `<span class="set-chip">${renderShape(x, depth + 1)}</span>`).join('')}</div>`;
  }

  function renderObjectShape(shape, depth) {
    if (depth > 2) return `<span class="shape-primitive">${escapeHtml(shape.text)}</span>`;
    const order = shape.order || Object.keys(shape.fields);
    if (!order.length) return `<span class="shape-primitive">${escapeHtml(shape.text)}</span>`;
    const rows = order.map((k) =>
      `<div class="obj-row"><span class="obj-k">${escapeHtml(k)}</span><span class="obj-v">${renderShape(shape.fields[k], depth + 1)}</span></div>`
    ).join('');
    return `<div class="shape-object">${shape.className ? `<div class="obj-cls">${escapeHtml(shape.className)}</div>` : ''}${rows}</div>`;
  }

  function renderFrames(step) {
    if (!step) {
      el.framesView.innerHTML = '<p class="empty-hint">尚未运行</p>';
      return;
    }
    const changedSet = new Set(step.changed);
    let html = '';
    step.frames.forEach((f) => {
      const names = f.order.filter((n) => n !== ENTRY_VAR);
      html += `<div class="frame-card"><div class="frame-name">${escapeHtml(f.name)}</div>`;
      if (names.length === 0) {
        html += `<div class="empty-hint">（无变量）</div>`;
      } else {
        names.forEach((name) => {
          const shape = f.vars[name];
          const key = f.id + ':' + name;
          const changed = changedSet.has(key);
          const isComplex = shape.kind !== 'primitive' && shape.kind !== 'null';
          html += `<div class="var-block ${changed ? 'changed' : ''}">
              <div class="var-name-row">
                <span class="vname">${escapeHtml(name)}</span>
                ${isComplex ? '' : `<span class="vval">${escapeHtml(shape.text)}</span>`}
              </div>
              ${isComplex ? `<div class="var-visual">${renderShape(shape)}</div>` : ''}
            </div>`;
        });
      }
      html += `</div>`;
    });
    el.framesView.innerHTML = html;
  }

  function renderConsole(outputLen) {
    if (!state.ctx || outputLen === 0) {
      el.consoleView.innerHTML = '<p class="empty-hint">（无输出）</p>';
      return;
    }
    const lines = state.ctx.output.slice(0, outputLen);
    el.consoleView.innerHTML = lines
      .map((o) => `<div class="console-line ${o.level}">${escapeHtml(o.text)}</div>`)
      .join('');
    el.consoleView.scrollTop = el.consoleView.scrollHeight;
  }

  function renderTimeline() {
    if (!state.ctx || !state.ctx.steps.length) {
      el.timelineView.innerHTML = '<p class="empty-hint">尚未运行</p>';
      return;
    }
    const frag = document.createDocumentFragment();
    state.ctx.steps.forEach((s, i) => {
      const item = document.createElement('div');
      item.className = 'timeline-item';
      item.dataset.index = i;
      const isEntry = s.line > state.userLineCount;
      const lineLabel = isEntry ? '入口' : ('L' + s.line);
      const label = isEntry ? ('调用 ' + el.entryInput.value.trim()) : s.label;
      item.innerHTML = `<span class="tl-line">${lineLabel}</span><span class="tl-label">${escapeHtml(label)}</span>`;
      item.addEventListener('click', () => { stopPlaying(); goToStep(i); });
      frag.appendChild(item);
    });
    el.timelineView.innerHTML = '';
    el.timelineView.appendChild(frag);
  }

  function highlightTimeline(i) {
    const items = el.timelineView.children;
    for (let k = 0; k < items.length; k++) items[k].classList.toggle('active', k === i);
    const active = items[i];
    if (active) {
      const viewTop = el.timelineView.scrollTop;
      const viewH = el.timelineView.clientHeight;
      const itemTop = active.offsetTop;
      if (itemTop < viewTop || itemTop > viewTop + viewH - 24) {
        el.timelineView.scrollTop = itemTop - viewH / 2;
      }
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ---------------- playback controls ----------------
  function resetPlayback() {
    stopPlaying();
    state.ctx = null;
    state.index = -1;
    state.lineHits = {};
    el.lineHighlight.hidden = true;
    el.progressSlider.max = 0;
    el.progressSlider.value = 0;
    setControlsEnabled(false);
    showError(null);
    showOutputResult(null);
    showStatus(null);
    hideResults();
    renderFrames(null);
    renderConsole(0);
    renderTimeline();
    updateStepCounter();
    el.currentStepBanner.textContent = '运行代码以开始可视化 —— 每一步会展示当前执行到的代码行、发生的变化，以及变量的最新取值。';
  }

  el.firstBtn.addEventListener('click', () => { stopPlaying(); goToStep(0); });
  el.lastBtn.addEventListener('click', () => { stopPlaying(); goToStep(state.ctx.steps.length - 1); });
  el.prevBtn.addEventListener('click', () => { stopPlaying(); goToStep(state.index - 1); });
  el.nextBtn.addEventListener('click', () => { stopPlaying(); goToStep(state.index + 1); });
  el.progressSlider.addEventListener('input', () => { stopPlaying(); goToStep(Number(el.progressSlider.value)); });

  function speedToDelay() {
    const v = Number(el.speedSlider.value); // 1..10
    return Math.round(1100 - v * 100); // 1000ms .. 100ms
  }

  function stopPlaying() {
    state.playing = false;
    if (state.playTimer) { clearTimeout(state.playTimer); state.playTimer = null; }
    el.playBtn.textContent = '▶';
  }

  function startPlaying() {
    if (!state.ctx || !state.ctx.steps.length) return;
    if (state.index >= state.ctx.steps.length - 1) state.index = -1;
    state.playing = true;
    el.playBtn.textContent = '⏸';
    tickPlay();
  }

  function tickPlay() {
    if (!state.playing) return;
    if (state.index >= state.ctx.steps.length - 1) { stopPlaying(); return; }
    goToStep(state.index + 1);
    state.playTimer = setTimeout(tickPlay, speedToDelay());
  }

  el.playBtn.addEventListener('click', () => {
    if (state.playing) stopPlaying();
    else startPlaying();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target === el.codeInput || e.target === el.entryInput || e.target.tagName === 'SELECT') return;
    if (!state.ctx || !state.ctx.steps.length) return;
    if (e.key === 'ArrowRight') { stopPlaying(); goToStep(state.index + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { stopPlaying(); goToStep(state.index - 1); e.preventDefault(); }
    else if (e.key === ' ') { e.preventDefault(); state.playing ? stopPlaying() : startPlaying(); }
  });

  // ---------------- init ----------------
  populateExamples();
  const firstName = Object.keys(window.EXAMPLES.javascript)[0];
  loadExample(firstName);
  resetPlayback();
})();
