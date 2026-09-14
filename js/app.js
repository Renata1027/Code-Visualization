(function () {
  'use strict';

  const LINE_HEIGHT = 21;

  const el = {
    exampleSelect: document.getElementById('exampleSelect'),
    runBtn: document.getElementById('runBtn'),
    clearBtn: document.getElementById('clearBtn'),
    heatmapToggle: document.getElementById('heatmapToggle'),
    editorWrap: document.getElementById('editorWrap'),
    gutter: document.getElementById('gutter'),
    codeArea: document.getElementById('codeArea'),
    lineHighlight: document.getElementById('lineHighlight'),
    codeInput: document.getElementById('codeInput'),
    errorBox: document.getElementById('errorBox'),
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
    ctx: null,          // result of CodeViz.runCode()
    lineHits: {},        // line -> execution count
    index: -1,           // current step index
    playing: false,
    playTimer: null,
    dirty: false,        // code changed since last run
  };

  // ---------------- example dropdown ----------------
  function populateExamples() {
    const examples = window.CODE_EXAMPLES || {};
    Object.keys(examples).forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      el.exampleSelect.appendChild(opt);
    });
  }
  el.exampleSelect.addEventListener('change', () => {
    const name = el.exampleSelect.value;
    if (!name) return;
    el.codeInput.value = window.CODE_EXAMPLES[name];
    onCodeChanged();
    resizeEditor();
    renderGutter();
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
    onCodeChanged();
  });
  el.codeInput.addEventListener('scroll', () => {
    // textarea itself never scrolls internally (overflow hidden + auto height),
    // kept for safety in case of long unbroken lines with wrap=off.
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

  function onCodeChanged() {
    if (state.ctx) {
      state.dirty = true;
      showError(null);
    }
  }

  el.heatmapToggle.addEventListener('change', renderGutter);

  el.clearBtn.addEventListener('click', () => {
    el.codeInput.value = '';
    el.exampleSelect.value = '';
    resizeEditor();
    resetPlayback();
    renderGutter();
    onCodeChanged();
    el.codeInput.focus();
  });

  // ---------------- run ----------------
  function showError(msg) {
    if (!msg) { el.errorBox.hidden = true; el.errorBox.textContent = ''; return; }
    el.errorBox.hidden = false;
    el.errorBox.textContent = msg;
  }

  el.runBtn.addEventListener('click', runCode);

  function runCode() {
    stopPlaying();
    const code = el.codeInput.value;
    if (!code.trim()) { showError('请先输入或粘贴一些 JavaScript 代码。'); return; }

    const ctx = window.CodeViz.runCode(code);
    state.ctx = ctx;
    state.dirty = false;

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
      return;
    }

    if (ctx.error) {
      showError(ctx.error);
    }

    setControlsEnabled(ctx.steps.length > 0);
    el.progressSlider.max = Math.max(0, ctx.steps.length - 1);
    renderTimeline();
    goToStep(0);
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

    // line highlight
    el.lineHighlight.hidden = false;
    el.lineHighlight.style.top = (step.line - 1) * LINE_HEIGHT + 10 + 'px';
    scrollLineIntoView(step.line);

    // banner
    const kindLabel = KIND_LABEL[step.kind] || '';
    el.currentStepBanner.innerHTML =
      `第 <b>${step.line}</b> 行　<span class="kw">${kindLabel}</span>　<code>${escapeHtml(step.label)}</code>`;

    renderFrames(step);
    renderConsole(step.outputLen);
    el.progressSlider.value = i;
    updateStepCounter();
    highlightTimeline(i);
  }

  const KIND_LABEL = {
    decl: '声明',
    expr: '执行',
    assign: '赋值',
    if: '条件判断',
    'loop-test': '循环条件',
    'loop-update': '循环更新',
    'loop-iter': '循环迭代',
    call: '函数调用',
    return: '返回',
    break: '跳出循环',
    continue: '继续循环',
    throw: '抛出异常',
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
      html += `<div class="frame-card"><div class="frame-name">${escapeHtml(f.name)}</div>`;
      if (f.order.length === 0) {
        html += `<div class="empty-hint">（无变量）</div>`;
      } else {
        f.order.forEach((name) => {
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
      item.innerHTML = `<span class="tl-line">L${s.line}</span><span class="tl-label">${escapeHtml(s.label)}</span>`;
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
    if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; }
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
    if (e.target === el.codeInput || e.target.tagName === 'SELECT') return;
    if (!state.ctx || !state.ctx.steps.length) return;
    if (e.key === 'ArrowRight') { stopPlaying(); goToStep(state.index + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { stopPlaying(); goToStep(state.index - 1); e.preventDefault(); }
    else if (e.key === ' ') { e.preventDefault(); state.playing ? stopPlaying() : startPlaying(); }
  });

  // ---------------- init ----------------
  populateExamples();
  el.codeInput.value = window.CODE_EXAMPLES ? window.CODE_EXAMPLES['累加循环 (for loop)'] : '';
  el.exampleSelect.value = '累加循环 (for loop)';
  resizeEditor();
  renderGutter();
  resetPlayback();
})();
