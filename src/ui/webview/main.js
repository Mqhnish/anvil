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

  let running = false;
  let currentAssistant = null; // element receiving deltas for thread 'main'
  const threadEls = new Map(); // threadId -> element for subagent output
  const toolCards = new Map(); // tool call id -> card
  let lastToolCardByName = new Map();

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

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
    const t = el('div', 'title');
    t.innerHTML = title;
    t.addEventListener('click', () => c.classList.toggle('collapsed'));
    c.appendChild(t);
    const b = el('div', 'body');
    if (body !== undefined) b.textContent = body;
    c.appendChild(b);
    log.appendChild(c);
    scroll();
    return c;
  }

  function ensureAssistant() {
    if (!currentAssistant) {
      currentAssistant = el('div', 'msg assistant');
      currentAssistant.dataset.raw = '';
      log.appendChild(currentAssistant);
    }
    return currentAssistant;
  }

  function setRunning(r, text) {
    running = r;
    sendBtn.disabled = r;
    cancelBtn.classList.toggle('hidden', !r);
    statusLine.classList.toggle('running', r);
    if (text !== undefined) statusLine.textContent = text;
    if (!r) { currentAssistant = null; threadEls.clear(); }
  }

  function send() {
    const text = input.value.trim();
    if (!text || running) return;
    input.value = '';
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
      d.appendChild(el('span', '', (it.kind === 'symbol' ? 'ƒ ' : '📄 ') + it.label));
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
      case 'reset': log.innerHTML = ''; setRunning(false, ''); break;
      case 'status': {
        const s = m.payload;
        modelChip.textContent = 'model: ' + (s.model || 'not set — click to choose') + (s.fallback ? '  ⇢ ' + s.fallback : '');
        tfChip.textContent = 'TrueForge: ' + s.trueforge;
        tfChip.className = 'chip ' + (/^ok/.test(s.trueforge) ? 'ok' : 'bad');
        sessionChip.classList.toggle('hidden', !s.session);
        sessionChip.textContent = 'session ' + (s.session || '').slice(0, 8) + ' ↗';
        if (s.text !== undefined) statusLine.textContent = s.text;
        if (typeof s.running === 'boolean' && s.running !== running) setRunning(s.running);
        break;
      }
      case 'user': { const u = el('div', 'msg user', m.text); log.appendChild(u); setRunning(true, 'sending…'); currentAssistant = null; scroll(); break; }
      case 'delta': {
        let target;
        if (m.threadId === 'main' || !m.threadId) target = ensureAssistant();
        else {
          target = threadEls.get(m.threadId);
          if (!target) { const c = card('thread', '🧵 sub-agent ' + esc(m.threadId), '', true); target = c.querySelector('.body'); target.dataset.raw = ''; threadEls.set(m.threadId, target); }
        }
        target.dataset.raw += m.text;
        if (target.classList.contains('msg')) target.innerHTML = md(target.dataset.raw); else target.textContent = target.dataset.raw;
        scroll();
        break;
      }
      case 'thread': {
        if (m.done) { const t = threadEls.get(m.threadId); if (t) t.parentElement.querySelector('.badge')?.remove(); break; }
        const c = card('thread', '🧵 sub-agent: ' + esc(m.title) + ' <span class="badge">running</span>', '', true);
        const b = c.querySelector('.body'); b.dataset.raw = ''; threadEls.set(m.threadId, b);
        break;
      }
      case 'tool.call': {
        currentAssistant = null; // next deltas start a new assistant bubble
        let args = m.args;
        try { const a = JSON.parse(m.args); args = Object.entries(a).map(([k, v]) => k + ': ' + (typeof v === 'string' ? v.slice(0, 400) : JSON.stringify(v).slice(0, 400))).join('\n'); } catch { }
        const c = card('tool running', '🔧 ' + esc(m.name) + (m.threadId && m.threadId !== 'main' ? ' <span class="badge">' + esc(m.threadId) + '</span>' : ''), args, true);
        toolCards.set(m.id, c);
        lastToolCardByName.set(m.name, c);
        statusLine.textContent = 'running ' + m.name + '…';
        break;
      }
      case 'tool.result': {
        const c = (m.id && toolCards.get(m.id)) || lastToolCardByName.get(m.name);
        if (c) {
          c.classList.remove('running');
          const b = c.querySelector('.body');
          b.textContent = (b.textContent ? b.textContent + '\n\n' : '') + '→ ' + m.text.slice(0, 4000) + (m.text.length > 4000 ? '\n… (' + m.text.length + ' chars)' : '');
          const t = c.querySelector('.title');
          if (m.ms !== undefined && !t.querySelector('.ms')) { const s = el('span', 'badge ms', m.ms + ' ms'); t.appendChild(s); }
          if (m.name === 'propose_edit') c.classList.add('review');
        }
        statusLine.textContent = 'thinking…';
        break;
      }
      case 'context.pack': {
        const p = m.pack;
        const c = card('context', '🧭 Context pack — ' + p.chosen.length + ' files chosen, ' + p.usedTokens + '/' + p.budgetTokens + ' tokens, ' + p.candidatesConsidered + ' considered (' + p.tookMs + ' ms)', undefined, false);
        const b = c.querySelector('.body');
        b.textContent = '';
        const bar = el('div', 'bar'); const fill = el('span'); fill.style.width = Math.min(100, Math.round(100 * p.usedTokens / p.budgetTokens)) + '%'; bar.appendChild(fill); b.appendChild(bar);
        p.chosen.forEach(f => {
          const row = el('div', 'ctx-file');
          const a = el('a', 'file', f.path); a.dataset.path = f.path; a.dataset.line = f.ranges && f.ranges[0] ? f.ranges[0].startLine : '';
          row.appendChild(a);
          row.appendChild(el('span', 'why', f.reason + ' [' + f.mode + (f.ranges && f.ranges.length ? ': ' + f.ranges.map(r => (r.symbol ? r.symbol + ' ' : '') + 'L' + r.startLine + '-' + r.endLine).join(', ') : '') + ']'));
          row.appendChild(el('span', 'tok', '~' + f.tokens + ' tok'));
          b.appendChild(row);
        });
        if (p.skipped && p.skipped.length) {
          const sk = el('div', 'why', 'skipped: ' + p.skipped.slice(0, 8).map(s => s.path + ' (' + s.reason + ')').join(', '));
          sk.style.marginTop = '6px'; sk.style.fontFamily = 'inherit';
          b.appendChild(sk);
        }
        break;
      }
      case 'review': { card('review', '👀 Reviewing ' + esc(m.path) + ' — ' + m.hunks + ' hunk' + (m.hunks === 1 ? '' : 's') + ' (accept/reject each in the diff editor)', undefined, true); statusLine.textContent = 'waiting for your review of ' + m.path; break; }
      case 'approval': {
        const c = card('approval', '⚠️ Run command?', (m.cwd ? '(in ' + m.cwd + ')\n' : '') + '$ ' + m.command, false);
        const row = el('div', 'row');
        const ok = el('button', 'primary', 'Allow'); const no = el('button', 'danger', 'Deny');
        ok.addEventListener('click', () => vscode.postMessage({ type: 'approve', id: m.id, allow: true }));
        no.addEventListener('click', () => vscode.postMessage({ type: 'approve', id: m.id, allow: false }));
        row.appendChild(ok); row.appendChild(no); c.appendChild(row); c.dataset.id = m.id;
        statusLine.textContent = 'waiting for approval…';
        break;
      }
      case 'approval.resolved': {
        const c = [...log.querySelectorAll('.card.approval')].find(x => x.dataset.id === m.id);
        if (c) { const row = c.querySelector('.row'); if (row) row.replaceWith(el('div', 'why', m.allow ? '✓ allowed' : '✗ denied')); }
        break;
      }
      case 'question': {
        const c = card('question', '❓ ' + esc(m.question), undefined, false);
        const row = el('div', 'row'); row.style.flexWrap = 'wrap';
        (m.options || []).forEach(o => { const b = el('button', '', o); b.addEventListener('click', () => { vscode.postMessage({ type: 'answer', id: m.id, answer: o }); row.replaceWith(el('div', 'why', '→ ' + o)); }); row.appendChild(b); });
        const free = el('input'); free.placeholder = 'or type an answer and press Enter'; free.style.flex = '1';
        free.addEventListener('keydown', e => { if (e.key === 'Enter') { vscode.postMessage({ type: 'answer', id: m.id, answer: free.value }); row.replaceWith(el('div', 'why', '→ ' + free.value)); } });
        row.appendChild(free); c.appendChild(row);
        break;
      }
      case 'notice': card('notice ' + m.level, (m.level === 'error' ? '⛔ ' : m.level === 'warn' ? '⚠️ ' : 'ℹ️ ') + esc(m.text), undefined, true); break;
      case 'compaction': card('notice info', m.phase === 'started' ? '🗜 TrueForge is compacting the session context…' : '🗜 Context compacted', undefined, true); break;
      case 'turn.done': {
        const t = el('div', 'turn-done', (m.status === 'done' ? '✓ done' : m.status === 'cancelled' ? '■ cancelled' : '✗ ' + (m.message || 'error')) + (m.model ? ' · ' + m.model : '') + (m.usedFallback ? ' (fallback)' : '') + (m.attempts > 1 ? ' · ' + m.attempts + ' attempts' : ''));
        log.appendChild(t);
        setRunning(false, m.status === 'done' ? '' : m.message || '');
        scroll();
        break;
      }
      case 'mention.results': { if (currentMention() && currentMention().q === m.q) { mentionItems = m.items; mentionSel = 0; renderMentions(); } break; }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
