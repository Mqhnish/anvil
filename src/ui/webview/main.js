// Anvil agent panel — plain JS, no framework, so the bundle stays tiny and the extension host is never blocked.
(function () {
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const cancelBtn = document.getElementById('cancel');
  const statusLine = document.getElementById('statusLine');
  const modelChip = document.getElementById('modelChip');
  const tfChip = document.getElementById('tfChip');
  const sessionChip = document.getElementById('sessionChip');
  const mentions = document.getElementById('mentions');
  const welcome = document.getElementById('welcome');
  const setup = document.getElementById('setup');
  // Held by reference: the setup box lives inside the welcome section, which is removed once a task starts,
  // so looking these up by id later would return null and abort every status update.
  const setupTitle = document.getElementById('setupTitle');
  const setupText = document.getElementById('setupText');
  const setupAction = document.getElementById('setupAction');
  const hint = document.getElementById('inputHint');
  const HINT_IDLE = hint.textContent;
  let setupCommand = 'anvil.startTrueForge';
  setupAction.addEventListener('click', () => vscode.postMessage({ type: 'command', command: setupCommand }));
  document.querySelectorAll('.example').forEach(button => button.addEventListener('click', () => { input.value = button.dataset.prompt; input.focus(); }));
  function showActivity() { welcome.remove(); }
  function finishTools() { toolCards.forEach(c => { if (c.classList.contains('running')) { c.classList.remove('running'); c.querySelector('.title').appendChild(el('span', 'badge', 'Not run')); } }); toolCards.clear(); lastToolCardByName.clear(); }


  let running = false;
  let currentAssistant = null; // element receiving deltas for thread 'main'
  const threadEls = new Map(); // threadId -> element for subagent output
  const toolCards = new Map(); // tool call id -> card
  let lastToolCardByName = new Map();

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  // Tool steps read as actions ("Read src/flask/cli.py L1–120"); the raw tool name stays in the tooltip.
  const TOOL_VERBS = { read_file: 'Read', list_dir: 'List', search_workspace: 'Search', find_symbols: 'Find symbols', assemble_context: 'Assemble context', get_diagnostics: 'Diagnostics', open_editors: 'Open editors', propose_edit: 'Propose edit', run_command: 'Run', git_status: 'Git status' };
  const SPARK = '<svg viewBox="104 4 40 22" aria-hidden="true"><path d="m112 17-2-9m11 7 5-9m2 16 9-5" stroke="currentColor" stroke-width="3" stroke-linecap="square" fill="none"/></svg>';
  const EFFECT_TOOLS = new Set(['propose_edit', 'run_command']);
  function toolVerb(name) { return TOOL_VERBS[name] || name; }
  function toolTarget(name, a) {
    if (!a || typeof a !== 'object') return '';
    if (name === 'read_file' && a.path) return a.path + (a.start_line ? ' L' + a.start_line + (a.end_line ? '–' + a.end_line : '') : '');
    if (name === 'search_workspace' || name === 'find_symbols') return a.query ? '"' + a.query + '"' : '';
    if (name === 'run_command') return a.command || '';
    if (name === 'assemble_context') return '';
    return a.path || a.query || '';
  }

  // Tiny markdown: fenced code, inline code, bold, bullets, links to files (path:line).
  function md(text) {
    const parts = text.split(/```/);
    let html = '';
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) { const body = parts[i].replace(/^[a-zA-Z0-9_-]*\n/, ''); html += '<pre>' + esc(body) + '</pre>'; continue; }
      let t = esc(parts[i]);
      t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
      t = t.replace(/(^|\n)[-*] /g, '$1• ');
      t = t.replace(/((?:[\w.-]+\/)+[\w.-]+\.\w{1,6})(?::(\d+))?/g, (m, p, l) => `<a class="file" data-path="${p}" data-line="${l || ''}">${m}</a>`);
      html += t;
    }
    return html;
  }

  function card(kind, title, body, collapsed) {
    const c = el('div', 'card ' + kind + (collapsed ? ' collapsed' : ''));
    const t = el('button', 'title');
    t.type = 'button'; t.setAttribute('aria-expanded', String(!collapsed));
    t.innerHTML = title;
    t.addEventListener('click', () => { c.classList.toggle('collapsed'); t.setAttribute('aria-expanded', String(!c.classList.contains('collapsed'))); });
    c.appendChild(t);
    const b = el('div', 'body');
    if (body !== undefined) b.textContent = body;
    if (kind.split(' ')[0] !== 'tool') b.classList.add('prose');
    c.appendChild(b);
    showActivity();
    log.appendChild(c);
    scroll();
    return c;
  }

  function endStream() { if (currentAssistant) currentAssistant.classList.remove('streaming'); }
  function ensureAssistant() {
    if (!currentAssistant) {
      currentAssistant = el('div', 'msg assistant streaming');
      currentAssistant.dataset.raw = '';
      log.appendChild(currentAssistant);
    }
    return currentAssistant;
  }

  function setRunning(r, text) {
    running = r;
    sendBtn.disabled = r;
    // While a turn runs, Cancel takes Send's place so the one available action is the one on screen.
    sendBtn.classList.toggle('hidden', r);
    hint.textContent = r ? 'Esc to cancel' : HINT_IDLE;
    document.getElementById('newChat').disabled = r;
    cancelBtn.classList.toggle('hidden', !r);
    statusLine.classList.toggle('running', r);
    if (text !== undefined) statusLine.textContent = text;
    if (!r) { endStream(); currentAssistant = null; threadEls.clear(); }
  }

  function send() {
    const text = input.value.trim();
    if (!text || running) return;
    setRunning(true, 'Checking the connection…');
    hideMentions();
    vscode.postMessage({ type: 'send', text });
  }
  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  document.getElementById('newChat').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  modelChip.addEventListener('click', () => vscode.postMessage({ type: 'selectModel' }));
  sessionChip.addEventListener('click', () => vscode.postMessage({ type: 'openSession' }));
  log.addEventListener('click', e => {
    const a = e.target.closest('a.file');
    if (a) vscode.postMessage({ type: 'openFile', path: a.dataset.path, line: a.dataset.line ? Number(a.dataset.line) : undefined });
  });

  // @mention autocomplete
  let mentionItems = [], mentionSel = 0, mentionStart = -1;
  function hideMentions() { mentions.classList.add('hidden'); mentionItems = []; mentionStart = -1; }
  function currentMention() {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const m = before.match(/(?:^|\s)@([\w./-]*)$/);
    if (!m) return null;
    return { q: m[1], start: pos - m[1].length - 1 };
  }
  input.addEventListener('input', () => {
    const m = currentMention();
    if (!m) { hideMentions(); return; }
    mentionStart = m.start;
    vscode.postMessage({ type: 'mention.query', q: m.q });
  });
  function applyMention(item) {
    const pos = input.selectionStart;
    input.value = input.value.slice(0, mentionStart) + '@' + item.label + ' ' + input.value.slice(pos);
    const np = mentionStart + item.label.length + 2;
    input.setSelectionRange(np, np);
    hideMentions();
    input.focus();
  }
  function renderMentions() {
    mentions.innerHTML = '';
    if (!mentionItems.length) { hideMentions(); return; }
    mentionItems.forEach((it, i) => {
      const d = el('div', i === mentionSel ? 'sel' : '');
      const lab = el('span', 'label', it.label); lab.dataset.kind = it.kind === 'symbol' ? 'symbol' : 'file'; d.appendChild(lab);
      d.appendChild(el('span', 'd', it.detail));
      d.addEventListener('mousedown', ev => { ev.preventDefault(); applyMention(it); });
      mentions.appendChild(d);
    });
    mentions.classList.remove('hidden');
  }
  input.addEventListener('keydown', e => {
    if (!mentions.classList.contains('hidden') && mentionItems.length) {
      if (e.key === 'ArrowDown') { mentionSel = (mentionSel + 1) % mentionItems.length; renderMentions(); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { mentionSel = (mentionSel - 1 + mentionItems.length) % mentionItems.length; renderMentions(); e.preventDefault(); return; }
      if (e.key === 'Tab' || e.key === 'Enter') { applyMention(mentionItems[mentionSel]); e.preventDefault(); return; }
      if (e.key === 'Escape') { hideMentions(); e.preventDefault(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === 'Escape' && running) vscode.postMessage({ type: 'cancel' });
  });

  window.addEventListener('message', ev => {
    const m = ev.data;
    switch (m.type) {
      case 'reset': log.replaceChildren(welcome); finishTools(); hideMentions(); setRunning(false, 'Ready when you are'); break;
      case 'status': {
        const s = m.payload;
        modelChip.textContent = s.model || 'Choose model';
        modelChip.title = s.model ? 'Primary: ' + s.model + (s.fallback ? '\nFallback: ' + s.fallback : '\nNo fallback configured') : 'Select a model configured in TrueForge';
        const connected = s.trueforge === 'ok';
        setup.classList.toggle('hidden', connected && !!s.model);
        setupTitle.textContent = connected ? 'Choose your model' : 'Connect to TrueForge';
        setupText.textContent = connected ? 'Add a provider in TrueForge Settings → Models, then choose it here.' : 'Start the local server, configure a model, then send your task.';
        setupAction.textContent = connected ? 'Choose model' : 'Start TrueForge';
        setupCommand = connected ? 'anvil.selectModel' : 'anvil.startTrueForge';
        tfChip.textContent = s.trueforge === 'ok' ? 'Connected' : s.trueforge === 'checking…' ? 'Connecting…' : 'Offline';
        tfChip.className = 'chip ' + (/^ok/.test(s.trueforge) ? 'ok' : 'bad');
        sessionChip.classList.toggle('hidden', !s.session);
        sessionChip.textContent = 'session ' + (s.session || '').slice(0, 8) + ' ↗';
        if (s.text !== undefined) statusLine.textContent = s.text;
        if (typeof s.running === 'boolean' && s.running !== running) setRunning(s.running, s.text ?? (s.running ? 'Working…' : 'Ready'));
        break;
      }
      case 'user': { showActivity(); if (input.value.trim() === m.text.trim()) input.value = ''; const u = el('div', 'msg user', m.text); log.appendChild(u); setRunning(true, 'Sending…'); currentAssistant = null; scroll(); break; }
      case 'delta': {
        showActivity();
        let target;
        if (!threadEls.has(m.threadId)) target = ensureAssistant();
        else {
          target = threadEls.get(m.threadId);
          if (!target) { const c = card('thread', 'Sub-agent ' + esc(m.threadId), '', true); target = c.querySelector('.body'); target.dataset.raw = ''; threadEls.set(m.threadId, target); }
        }
        target.dataset.raw += m.text;
        if (target.classList.contains('msg')) target.innerHTML = md(target.dataset.raw); else target.textContent = target.dataset.raw;
        scroll();
        break;
      }
      case 'thread': {
        if (m.done) { const t = threadEls.get(m.threadId); if (t) t.parentElement.querySelector('.badge')?.remove(); break; }
        const c = card('thread', 'Sub-agent: ' + esc(m.title) + ' <span class="badge">Running</span>', '', true);
        const b = c.querySelector('.body'); b.dataset.raw = ''; threadEls.set(m.threadId, b);
        break;
      }
      case 'tool.call': {
        endStream(); currentAssistant = null; // next deltas start a new assistant bubble
        let args = m.args, parsed;
        try { parsed = JSON.parse(m.args); args = Object.entries(parsed).map(([k, v]) => k + ': ' + (typeof v === 'string' ? v.slice(0, 400) : JSON.stringify(v).slice(0, 400))).join('\n'); } catch { }
        const target = toolTarget(m.name, parsed);
        const title = '<span class="verb">' + esc(toolVerb(m.name)) + '</span>' + (target ? '<span class="target">' + esc(target) + '</span>' : '') + (m.threadId && m.threadId !== 'main' ? ' <span class="badge">' + esc(m.threadId) + '</span>' : '');
        // Steps that change the workspace get a square marker, so they stand out without relying on colour.
        const c = card('tool running' + (EFFECT_TOOLS.has(m.name) ? ' effect' : ''), title, args, true);
        c.querySelector('.title').title = m.name;
        toolCards.set(m.id, c);
        lastToolCardByName.set(m.name, c);
        statusLine.textContent = toolVerb(m.name) + (target ? ' ' + target : '') + '…';
        break;
      }
      case 'tool.result': {
        const c = (m.id && toolCards.get(m.id)) || lastToolCardByName.get(m.name);
        if (c) {
          c.classList.remove('running');
          c.classList.add('settled'); c.addEventListener('animationend', () => c.classList.remove('settled'), { once: true });
          const b = c.querySelector('.body');
          b.textContent = (b.textContent ? b.textContent + '\n\n' : '') + '→ ' + m.text.slice(0, 4000) + (m.text.length > 4000 ? '\n… (' + m.text.length + ' chars)' : '');
          const t = c.querySelector('.title');
          if (m.ms !== undefined && !t.querySelector('.ms')) { const s = el('span', 'badge ms', m.ms >= 1000 ? (m.ms / 1000).toFixed(1) + ' s' : m.ms + ' ms'); t.appendChild(s); }
          if (m.name === 'propose_edit') c.classList.add('review');
        }
        if (running) statusLine.textContent = 'Thinking…';
        break;
      }
      case 'context.pack': {
        const p = m.pack;
        const n = v => Number(v).toLocaleString('en-US');
        const c = card('context', 'Context: ' + p.chosen.length + ' file' + (p.chosen.length === 1 ? '' : 's') + ' <span class="badge">' + n(p.usedTokens) + ' of ' + n(p.budgetTokens) + ' tokens</span>', undefined, false);
        const b = c.querySelector('.body');
        b.textContent = '';
        const left = Math.max(0, p.budgetTokens - p.usedTokens);
        b.appendChild(el('div', 'meta', 'Ranked from ' + n(p.candidatesConsidered) + ' candidates in ' + p.tookMs + ' ms'));
        // Budget meter: one segment per chosen file in rank order, width = its tokens; the hatched tail is unused budget.
        // Segment i and row i share data-i, so hovering either one highlights both.
        const bar = el('div', 'heat'); bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', n(p.usedTokens) + ' of ' + n(p.budgetTokens) + ' tokens used across ' + p.chosen.length + ' files');
        const link = (node, i) => {
          node.dataset.i = String(i);
          node.addEventListener('mouseenter', () => b.querySelectorAll('[data-i="' + i + '"]').forEach(x => x.classList.add('hot')));
          node.addEventListener('mouseleave', () => b.querySelectorAll('[data-i="' + i + '"]').forEach(x => x.classList.remove('hot')));
        };
        p.chosen.forEach((f, i) => { const seg = el('span'); seg.style.flexGrow = String(f.tokens); seg.style.setProperty('--i', String(i)); seg.title = (i + 1) + '. ' + f.path + ': ' + n(f.tokens) + ' tokens'; link(seg, i); bar.appendChild(seg); });
        const free = el('span', 'free'); free.style.flexGrow = String(left); free.title = n(left) + ' tokens left in the budget'; bar.appendChild(free);
        b.appendChild(bar);
        p.chosen.forEach((f, i) => {
          const row = el('div', 'ctx-file'); link(row, i); row.style.setProperty('--i', String(i));
          row.appendChild(el('span', 'rank', String(i + 1)));
          const a = el('a', 'file', f.path); a.dataset.path = f.path; a.dataset.line = f.ranges && f.ranges[0] ? f.ranges[0].startLine : '';
          row.appendChild(a);
          row.appendChild(el('span', 'tok', n(f.tokens)));
          const why = el('span', 'why', f.reason);
          if (f.ranges && f.ranges.length) why.appendChild(el('span', 'ranges', f.ranges.map(r => (r.symbol ? r.symbol + ' ' : '') + 'L' + r.startLine + '–' + r.endLine).join(', ')));
          row.appendChild(why);
          b.appendChild(row);
        });
        if (p.skipped && p.skipped.length) {
          b.appendChild(el('div', 'skipped', 'Left out: ' + p.skipped.slice(0, 8).map(s => s.path + ' (' + s.reason + ')').join(', ')));
        }
        break;
      }
      case 'review': { card('review', 'Review <span class="target">' + esc(m.path) + '</span>', m.hunks + ' change' + (m.hunks === 1 ? '' : 's') + ' waiting in the diff editor. Accept or reject each one there.', false); statusLine.textContent = 'Waiting for your review of ' + m.path; break; }
      case 'approval': {
        const c = card('approval', 'Run this command?' + (m.cwd && m.cwd !== '.' ? ' <span class="badge">in ' + esc(m.cwd) + '</span>' : ''), undefined, false);
        const b = c.querySelector('.body'); b.classList.remove('prose'); b.classList.add('command'); b.textContent = m.command;
        const row = el('div', 'row');
        const ok = el('button', 'primary', 'Allow'); const no = el('button', '', 'Deny');
        ok.addEventListener('click', () => { ok.disabled = true; no.disabled = true; vscode.postMessage({ type: 'approve', id: m.id, allow: true }); });
        no.addEventListener('click', () => { ok.disabled = true; no.disabled = true; vscode.postMessage({ type: 'approve', id: m.id, allow: false }); });
        row.appendChild(ok); row.appendChild(no); c.appendChild(row); c.dataset.id = m.id;
        statusLine.textContent = 'Waiting for your approval';
        break;
      }
      case 'approval.resolved': {
        const c = [...log.querySelectorAll('.card.approval')].find(x => x.dataset.id === m.id);
        if (c) { const row = c.querySelector('.row'); if (row) row.replaceWith(el('div', 'resolved ' + (m.allow ? 'yes' : 'no'), m.allow ? 'Allowed' : 'Denied')); }
        break;
      }
      case 'question': {
        const c = card('question', esc(m.question), undefined, false);
        const row = el('div', 'row'); row.style.flexWrap = 'wrap';
        (m.options || []).forEach(o => { const b = el('button', '', o); b.addEventListener('click', () => { vscode.postMessage({ type: 'answer', id: m.id, answer: o }); row.replaceWith(el('div', 'resolved', o)); }); row.appendChild(b); });
        const free = el('input'); free.placeholder = 'Or type an answer and press Enter'; free.style.flex = '1';
        free.addEventListener('keydown', e => { if (e.key === 'Enter') { vscode.postMessage({ type: 'answer', id: m.id, answer: free.value }); row.replaceWith(el('div', 'resolved', free.value)); } });
        row.appendChild(free); c.appendChild(row);
        break;
      }
      case 'notice': card('notice ' + m.level, esc(m.text), undefined, true); break;
      case 'compaction': card('notice info', m.phase === 'started' ? 'TrueForge is compacting the session context…' : 'Session context compacted', undefined, true); break;
      case 'turn.done': {
        finishTools();
        log.querySelectorAll('.card.question .row').forEach(row => row.replaceWith(el('div', 'resolved', 'No longer waiting for an answer')));
        const t = el('div', 'turn-done ' + (m.status === 'done' ? 'ok' : m.status === 'cancelled' ? 'cancelled' : 'failed'));
        if (m.status === 'done') { const sp = el('span', 'spark'); sp.innerHTML = SPARK; t.appendChild(sp); }
        t.appendChild(el('strong', '', m.status === 'done' ? 'Done' : m.status === 'cancelled' ? 'Cancelled' : 'Failed' + (m.message ? ': ' + m.message : '')));
        const meta = [m.model ? m.model.split('/').pop() + (m.usedFallback ? ' (fallback)' : '') : '', m.attempts > 1 ? m.attempts + ' attempts' : ''].filter(Boolean);
        if (meta.length) { const s = el('span', '', meta.join(', ')); if (m.model) s.title = m.model; t.appendChild(s); }
        log.appendChild(t);
        setRunning(false, m.status === 'done' ? 'Ready' : m.status === 'cancelled' ? 'Cancelled · accepted edits remain applied' : m.message || 'Turn failed');
        scroll();
        break;
      }
      case 'mention.results': { if (currentMention() && currentMention().q === m.q) { mentionItems = m.items; mentionSel = 0; renderMentions(); } break; }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
