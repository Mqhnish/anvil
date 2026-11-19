#!/usr/bin/env node
/**
 * mock-model — a tiny OpenAI-compatible chat-completions server with a scripted "coding agent" policy.
 *
 * Why: the competition scores what the extension DOES, not how clever the model is. This server lets us
 * exercise the whole TrueForge → MCP → review → apply loop deterministically in CI and in demos, and it
 * can be told to fail (for the resilience task):
 *
 *   node scripts/mock-model.mjs --port 8999            # healthy
 *   node scripts/mock-model.mjs --port 8998 --fail 503  # every request → 503 (simulates a dead provider)
 *   node scripts/mock-model.mjs --port 8997 --fail drop # closes the socket without answering
 *   node scripts/mock-model.mjs --port 8996 --rate-limit-at 4 --rate-limit-secs 12
 *       from the 4th chat request, answer every request for 12 s with a Gemini-style per-minute 429
 *       ("Please retry in 12s"), like a free-tier quota window; then behave normally
 *
 * Register it in TrueForge as a `custom` provider: base_url http://127.0.0.1:8999/v1, model id "mock-coder".
 *
 * Policy (per conversation): if a tool result from assemble_context is absent → call assemble_context with the
 * user task; then read_file on the first chosen file; then propose_edit appending a comment to that file;
 * then finish with a summary. In inline mode (user text starts with INLINE EDIT) it calls propose_edit with the
 * selected block annotated on its first line. The optional --multi-hunk mode annotates two distant lines for editor tests.
 */
import http from 'node:http';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const port = Number(arg('--port', '8999'));
const fail = arg('--fail', '');
const multiHunk = process.argv.includes('--multi-hunk');
const rateLimitAt = Number(arg('--rate-limit-at', '0'));
const rateLimitSecs = Number(arg('--rate-limit-secs', '1'));
let chatRequests = 0;
let limitedUntil = 0;

function toolCall(name, args) {
  return { id: 'call_' + Math.random().toString(36).slice(2, 10), type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function availableTool(tools, name) {
  return (tools || []).some(t => t.function?.name === name);
}

/** Decide the next assistant message from the transcript. */
function policy(messages, tools) {
  const user = [...messages].reverse().find(m => m.role === 'user');
  const userText = typeof user?.content === 'string' ? user.content : (user?.content || []).map(p => p.text || '').join('');
  const toolMsgs = messages.filter(m => m.role === 'tool');
  const calledNames = messages.filter(m => m.role === 'assistant' && m.tool_calls).flatMap(m => m.tool_calls.map(t => t.function.name));
  const lastTool = toolMsgs[toolMsgs.length - 1];
  const lastToolText = lastTool ? String(lastTool.content) : '';
  const direct = n => (availableTool(tools, n) ? n : null);
  const via = (n, input) => (direct(n) ? toolCall(n, input) : toolCall('call_tool', { server_name: 'vscode-workspace', tool_name: n, input }));

  if (/^INLINE EDIT/.test(userText)) {
    if (!calledNames.some(n => n === 'propose_edit' || n === 'call_tool')) {
      const file = (userText.match(/file: (.+)/) || [])[1];
      const block = (userText.match(/```\n([\s\S]*?)\n```/) || [])[1] || '';
      const lines = block.split('\n');
      const newBlock = [lines[0] + '  # edited by mock-coder', ...lines.slice(1)].join('\n');
      return { tool_calls: [via('propose_edit', { path: file, summary: 'mock inline edit', edits: [{ old: block, new: newBlock }] })] };
    }
    return { content: 'Done: ' + lastToolText.split('\n')[0] };
  }

  if (!calledNames.includes('assemble_context') && !lastToolText.startsWith('Context pack')) {
    return { tool_calls: [via('assemble_context', { task: userText })] };
  }
  const packMsg = toolMsgs.find(m => String(m.content).startsWith('Context pack'));
  const firstFile = packMsg ? (String(packMsg.content).match(/^1\. (\S+)/m) || [])[1] : undefined;
  if (firstFile && !calledNames.includes('read_file') && !lastToolText.startsWith(firstFile)) {
    return { content: `I will edit ${firstFile} (chosen by the context pack because it ranked first).`, tool_calls: [via('read_file', { path: firstFile, start_line: 1, end_line: multiHunk ? 100 : 5 })] };
  }
  const proposed = calledNames.includes('propose_edit') || messages.some(m => m.role === 'assistant' && JSON.stringify(m).includes('"propose_edit"'));
  if (firstFile && !proposed) {
    const firstLine = (lastToolText.split('\n')[1] || '').replace(/^\s*\d+\| /, '');
    const edits = [{ old: firstLine, new: firstLine + '  # touched by mock-coder' }];
    if (multiHunk) {
      const lastLine = lastToolText.split('\n').slice(1).map(line => line.replace(/^\s*\d+\| ?/, '')).filter(line => line.trim()).at(-1);
      if (lastLine && lastLine !== firstLine) edits.push({ old: lastLine, new: lastLine + '  # second hunk' });
    }
    return { tool_calls: [via('propose_edit', { path: firstFile, summary: 'scripted editor regression edit', edits })] };
  }
  return { content: `Finished. ${lastToolText.split('\n')[0]}` };
}

const server = http.createServer((req, res) => {
  if (fail === 'drop') { req.socket.destroy(); return; }
  if (fail) { res.writeHead(Number(fail) || 503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'mock provider is down (simulated)', type: 'server_error' } })); return; }
  if (req.url === '/v1/models' || req.url === '/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-coder', object: 'model' }] })); return; }
  if (!/chat\/completions$/.test(req.url || '')) { res.writeHead(404); res.end(); return; }
  if (rateLimitAt && ++chatRequests === rateLimitAt) limitedUntil = Date.now() + rateLimitSecs * 1000;
  if (Date.now() < limitedUntil) {
    const left = Math.max(1, Math.ceil((limitedUntil - Date.now()) / 1000));
    process.stderr.write(`[mock] 429 for request ${chatRequests} (${left}s left in window)\n`);
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(left) });
    res.end(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `You exceeded your current quota (simulated). Quota exceeded for metric: input_token_count, limit: 250000, description: input tokens per minute limit exceeded on Free Tier.\nPlease retry in ${left}s.` } }));
    return;
  }
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
    const out = policy(payload.messages || [], payload.tools || []);
    const id = 'chatcmpl-' + Date.now();
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: Math.ceil(body.length / 4), completion_tokens: 20, total_tokens: Math.ceil(body.length / 4) + 20 };
    if (payload.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({ id, object: 'chat.completion.chunk', created, model: 'mock-coder', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      const words = (out.content || '').split(/(?<=\s)/);
      let i = 0;
      const tick = () => {
        if (i < words.length) { send({ id, object: 'chat.completion.chunk', created, model: 'mock-coder', choices: [{ index: 0, delta: { content: words[i++] }, finish_reason: null }] }); setTimeout(tick, 25); return; }
        if (out.tool_calls) {
          out.tool_calls.forEach((tc, idx) => send({ id, object: 'chat.completion.chunk', created, model: 'mock-coder', choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] }));
        }
        send({ id, object: 'chat.completion.chunk', created, model: 'mock-coder', choices: [{ index: 0, delta: {}, finish_reason: out.tool_calls ? 'tool_calls' : 'stop' }], usage });
        res.write('data: [DONE]\n\n');
        res.end();
      };
      tick();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, object: 'chat.completion', created, model: 'mock-coder', choices: [{ index: 0, message: { role: 'assistant', content: out.content ?? null, tool_calls: out.tool_calls }, finish_reason: out.tool_calls ? 'tool_calls' : 'stop' }], usage }));
    }
  });
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ listening: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock-coder', fail: fail || null })));
