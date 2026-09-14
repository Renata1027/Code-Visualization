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
    cases: [{ name: '用例 1', entry: '' }],
    activeCase: 0,
  };

  // ---------------- language switch ----------------
  el.langSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('.lang-btn');
    if (!btn || btn.classList.contains('active')) return;
    Array.from(el.langSwitch.children).forEach((b) => b.classList.toggle('active', b === btn));
    state.language = btn.dataset.lang;
    el.entryInput.placeholder = state.language === 'python'
      ? '例如：Solution().subsets([1, 2, 3])'
      : '例如：twoSum([2, 7, 11, 15], 9)';
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

  function loadExample(name) {
    const ex = (window.EXAMPLES[state.language] || {})[name];
    if (!ex) return;
    el.codeInput.value = ex.code;
    state.cases = [{ name: '用例 1', entry: ex.entry || '' }];
    state.activeCase = 0;
    el.entryInput.value = ex.entry || '';
    el.exampleSelect.value = name;
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
    if (state.cases[state.activeCase]) state.cases[state.activeCase].entry = el.entryInput.value;
  }

  function switchCase(i) {
    syncActiveEntry();
    state.activeCase = i;
    el.entryInput.value = state.cases[i].entry || '';
    renderTabs();
    showOutputResult(null);
    if (el.resultsBlock && !el.resultsBlock.hidden) {
      Array.from(el.resultsList.children).forEach((row, idx) => row.classList.toggle('active-case', idx === i));
    }
  }

  function addCase() {
    syncActiveEntry();
    state.cases.push({ name: '用例 ' + (state.cases.length + 1), entry: state.cases[state.activeCase].entry || '' });
    state.activeCase = state.cases.length - 1;
    el.entryInput.value = state.cases[state.activeCase].entry || '';
    renderTabs();
  }

  function removeCase(i) {
    if (state.cases.length <= 1) return;
    state.cases.splice(i, 1);
    state.cases.forEach((c, idx) => { c.name = '用例 ' + (idx + 1); });
    if (state.activeCase >= state.cases.length) state.activeCase = state.cases.length - 1;
    else if (state.activeCase > i) state.activeCase--;
    el.entryInput.value = state.cases[state.activeCase].entry || '';
    renderTabs();
  }

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
    state.cases = [{ name: '用例 1', entry: '' }];
    state.activeCase = 0;
    el.entryInput.value = '';
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

    const activeEntry = (state.cases[state.activeCase].entry || '').trim();
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
        const entry = (c.entry || '').trim();
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
          return f.vars[ENTRY_VAR];
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
      el.currentStepBanner.innerHTML =
        `<span class="kw">调用入口</span>　<code>${escapeHtml(el.entryInput.value.trim())}</code>`;
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
          const val = f.vars[name];
          const key = f.id + ':' + name;
          const changed = changedSet.has(key);
          html += `<div class="var-row ${changed ? 'changed' : ''}">
              <span class="vname">${escapeHtml(name)}</span>
              <span class="vval">${escapeHtml(val)}</span>
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
