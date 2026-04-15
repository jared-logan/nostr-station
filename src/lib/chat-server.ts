/**
 * Lightweight chat server for nostr-station chat.
 * Reads AI provider config from ~/.claude_env + keychain,
 * injects NOSTR_STATION.md as system context on every request,
 * and streams responses via SSE.
 * Supports both Anthropic native API and OpenAI-compatible endpoints.
 */

import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { getKeychain } from './keychain.js';

interface ProviderConfig {
  isAnthropic: boolean;
  baseUrl:     string;
  model:       string;
  apiKey:      string;
  providerName: string;
}

// ── Config loading ─────────────────────────────────────────────────────────────

function parseClaudeEnv(homeDir: string): { baseUrl: string; model: string } {
  const envPath = path.join(homeDir, '.claude_env');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const baseMatch  = content.match(/^export ANTHROPIC_BASE_URL="([^"]+)"/m);
    const modelMatch = content.match(/^export CLAUDE_MODEL="([^"]+)"/m);
    return {
      baseUrl: baseMatch?.[1]  ?? '',
      model:   modelMatch?.[1] ?? '',
    };
  } catch {
    return { baseUrl: '', model: '' };
  }
}

function inferProviderName(baseUrl: string): string {
  if (baseUrl.includes('openrouter'))  return 'OpenRouter';
  if (baseUrl.includes('routstr'))     return 'Routstr';
  if (baseUrl.includes('ppq.ai'))      return 'PayPerQ';
  if (baseUrl.includes('opencode.ai')) return 'OpenCode Zen';
  if (baseUrl.includes(':8081'))       return 'Maple';
  if (baseUrl.includes(':11434'))      return 'Ollama';
  if (baseUrl.includes(':1234'))       return 'LM Studio';
  return 'Custom';
}

async function loadConfig(): Promise<ProviderConfig> {
  const homeDir = os.homedir();
  const { baseUrl, model } = parseClaudeEnv(homeDir);
  const isAnthropic = !baseUrl;

  // Resolution order for the Anthropic API key:
  //   1. process.env.ANTHROPIC_API_KEY — lets power users override ad-hoc
  //      (e.g. `ANTHROPIC_API_KEY=sk-... nostr-station chat`).
  //   2. OS keychain (ai-api-key slot) — the canonical store populated by
  //      onboard + `nostr-station keychain set ai-api-key`.
  //
  // Before: we only checked (1). On Linux, the env var comes from sourcing
  // ~/.claude_env in the user's shell rc, but chat is often launched from
  // a context that didn't source it (GUI terminal, fresh subshell, etc.),
  // so the key was stored in GNOME Keyring yet unavailable to chat-server.
  let apiKey: string;
  if (isAnthropic) {
    apiKey = process.env.ANTHROPIC_API_KEY
      || (await getKeychain().retrieve('ai-api-key'))
      || '';
    if (!apiKey) {
      throw new Error(
        'Anthropic API key not set.\n'
        + '  Store it: nostr-station keychain set ai-api-key\n'
        + '  Or override: ANTHROPIC_API_KEY=sk-ant-... nostr-station chat\n'
        + '  Or reconfigure: nostr-station onboard'
      );
    }
  } else {
    apiKey = (await getKeychain().retrieve('ai-api-key')) ?? '';
  }

  return {
    isAnthropic,
    baseUrl,
    model:        model || (isAnthropic ? 'claude-opus-4-6' : 'default'),
    apiKey,
    providerName: isAnthropic ? 'Anthropic' : inferProviderName(baseUrl),
  };
}

function getContextContent(homeDir: string): string {
  const contextPath = path.join(homeDir, 'projects', 'NOSTR_STATION.md');
  try {
    return fs.readFileSync(contextPath, 'utf8');
  } catch {
    return 'You are a helpful assistant for Nostr protocol development.';
  }
}

export function contextExists(): boolean {
  return fs.existsSync(path.join(os.homedir(), 'projects', 'NOSTR_STATION.md'));
}

// ── AI proxy ───────────────────────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end',  ()    => resolve(body));
    req.on('error', reject);
  });
}

function completionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return base.endsWith('/v1')
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
}

type Msg = { role: string; content: string };

async function streamAnthropic(
  messages: Msg[], system: string, cfg: ProviderConfig, res: http.ServerResponse,
): Promise<void> {
  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
      'accept':            'text/event-stream',
    },
    body: JSON.stringify({
      model: cfg.model, max_tokens: 8192, system, messages, stream: true,
    }),
  });

  if (!apiRes.ok) {
    const text = await apiRes.text().catch(() => '');
    throw new Error(`Anthropic ${apiRes.status}: ${text.slice(0, 200)}`);
  }

  const reader  = apiRes.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ content: parsed.delta.text })}\n\n`);
        }
      } catch {}
    }
  }
}

async function streamOpenAICompat(
  messages: Msg[], system: string, cfg: ProviderConfig, res: http.ServerResponse,
): Promise<void> {
  const allMessages: Msg[] = [{ role: 'system', content: system }, ...messages];
  const url = completionsUrl(cfg.baseUrl);

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const bareKeys = new Set(['none', 'ollama', 'lm-studio', 'maple-desktop-auto']);
  if (cfg.apiKey && !bareKeys.has(cfg.apiKey)) {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  }

  const apiRes = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: cfg.model, messages: allMessages, stream: true }),
  });

  if (!apiRes.ok) {
    const text = await apiRes.text().catch(() => '');
    throw new Error(`${cfg.providerName} ${apiRes.status}: ${text.slice(0, 200)}`);
  }

  const reader  = apiRes.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;
      try {
        const parsed  = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
      } catch {}
    }
  }
}

async function proxyChat(
  req:  http.IncomingMessage,
  res:  http.ServerResponse,
  cfg:  ProviderConfig,
): Promise<void> {
  let messages: Msg[];
  try {
    const body = await readBody(req);
    ({ messages } = JSON.parse(body));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
    return;
  }

  const system = getContextContent(os.homedir());

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  try {
    if (cfg.isAnthropic) {
      await streamAnthropic(messages, system, cfg, res);
    } else {
      await streamOpenAICompat(messages, system, cfg, res);
    }
  } catch (e: any) {
    res.write(`data: ${JSON.stringify({ error: String(e.message ?? e) })}\n\n`);
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

// ── HTML UI ────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>nostr-station chat</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d0d0d;--bg2:#111;--border:#222;--border2:#2a2a2a;
  --text:#c0c0c0;--bright:#e8e8e8;--muted:#555;--muted2:#444;
  --purple:#7B68EE;--green:#3DDC84;--red:#FF5A5A;
  --font:'SF Mono','Cascadia Code','Fira Code',Menlo,Consolas,monospace
}
html,body{height:100%}
body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.65;display:flex;flex-direction:column;height:100vh;overflow:hidden}
#hdr{padding:9px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;background:var(--bg)}
#hdr-title{color:var(--purple);font-weight:700;font-size:13px;letter-spacing:.4px}
#hdr-meta{color:var(--muted);font-size:11px}
#feed{flex:1;overflow-y:auto;padding:20px 22px;display:flex;flex-direction:column;gap:22px}
.msg{}
.lbl{font-size:10px;letter-spacing:1.8px;text-transform:uppercase;margin-bottom:5px}
.msg-user   .lbl{color:var(--green)}
.msg-asst   .lbl{color:var(--purple)}
.msg-error  .lbl{color:var(--red)}
.body{white-space:pre-wrap;word-break:break-word;color:var(--bright)}
.msg-error  .body{color:var(--red)}
#bar{border-top:1px solid var(--border);padding:11px 14px;display:flex;gap:8px;flex-shrink:0}
#inp{flex:1;background:var(--bg2);border:1px solid var(--border2);color:var(--bright);padding:8px 11px;font-family:var(--font);font-size:14px;border-radius:2px;resize:none;height:38px;max-height:160px;outline:none;overflow-y:hidden}
#inp:focus{border-color:var(--purple)}
#inp::placeholder{color:var(--muted)}
#btn{background:transparent;border:1px solid var(--purple);color:var(--purple);padding:8px 15px;cursor:pointer;font-family:var(--font);font-size:13px;border-radius:2px;white-space:nowrap;transition:background .1s,color .1s}
#btn:hover:not(:disabled){background:var(--purple);color:var(--bg)}
#btn:disabled{opacity:.3;cursor:not-allowed}
.cur{display:inline-block;width:7px;height:13px;background:var(--purple);vertical-align:middle;margin-left:1px;animation:blink 1s step-end infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:2px}
</style>
</head>
<body>
<div id="hdr">
  <span id="hdr-title">nostr-station</span>
  <span id="hdr-meta">connecting…</span>
</div>
<div id="feed">
  <div class="msg msg-asst">
    <div class="lbl">assistant</div>
    <div class="body">Ready. NOSTR_STATION.md loaded as context. What are you building?</div>
  </div>
</div>
<div id="bar">
  <textarea id="inp" placeholder="Ask about Nostr development…"></textarea>
  <button id="btn">send</button>
</div>
<script>
const feed=$('feed'), inp=$('inp'), btn=$('btn');
let history=[], busy=false;

fetch('/api/config').then(r=>r.json()).then(c=>{
  $('hdr-meta').textContent=c.provider+' · '+c.model+(c.hasContext?' · context ✓':' · no context file');
}).catch(()=>{ $('hdr-meta').textContent='error loading config'; });

inp.addEventListener('input',()=>{
  inp.style.height='auto';
  inp.style.height=Math.min(inp.scrollHeight,160)+'px';
});
inp.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}
});
btn.addEventListener('click',sendMsg);
inp.focus();

function $(id){return document.getElementById(id);}

function addMsg(role,text){
  const d=document.createElement('div');
  d.className='msg msg-'+role;
  d.innerHTML='<div class="lbl">'+role.replace('asst','assistant')+'</div><div class="body"></div>';
  d.querySelector('.body').textContent=text;
  feed.appendChild(d);
  feed.scrollTop=feed.scrollHeight;
  return d.querySelector('.body');
}

async function sendMsg(){
  if(busy)return;
  const text=inp.value.trim();
  if(!text)return;
  inp.value='';inp.style.height='auto';
  busy=true;btn.disabled=true;
  history.push({role:'user',content:text});
  addMsg('user',text);
  const bodyEl=addMsg('asst','');
  const cur=document.createElement('span');
  cur.className='cur';bodyEl.appendChild(cur);
  let full='';
  try{
    const res=await fetch('/api/chat',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({messages:history})
    });
    if(!res.ok)throw new Error('Server error '+res.status);
    const reader=res.body.getReader();
    const dec=new TextDecoder();
    let buf='';
    while(true){
      const{done,value}=await reader.read();
      if(done)break;
      buf+=dec.decode(value,{stream:true});
      const lines=buf.split('\\n');buf=lines.pop();
      for(const line of lines){
        if(!line.startsWith('data: '))continue;
        const d=line.slice(6).trim();
        if(d==='[DONE]')break;
        try{
          const p=JSON.parse(d);
          if(p.error)throw new Error(p.error);
          if(p.content){full+=p.content;bodyEl.textContent=full;bodyEl.appendChild(cur);feed.scrollTop=feed.scrollHeight;}
        }catch(e){if(e.message&&!e.message.startsWith('{'))throw e;}
      }
    }
  }catch(e){
    bodyEl.textContent='✗ '+e.message;
    bodyEl.parentElement.className='msg msg-error';
    full='';
  }
  cur.remove();
  if(full)history.push({role:'assistant',content:full});
  busy=false;btn.disabled=false;inp.focus();
}
</script>
</body>
</html>`;

// ── Server ─────────────────────────────────────────────────────────────────────

export async function startChatServer(port: number): Promise<void> {
  const cfg = await loadConfig();

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = req.url ?? '/';

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type',
        });
        res.end();
        return;
      }

      if (url === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML);
        return;
      }

      if (url === '/api/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          provider:   cfg.providerName,
          model:      cfg.model,
          hasContext: contextExists(),
        }));
        return;
      }

      if (url === '/api/chat' && req.method === 'POST') {
        await proxyChat(req, res, cfg);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use — check: lsof -i :${port}`));
      } else {
        reject(e);
      }
    });

    server.listen(port, '127.0.0.1', () => resolve());
  });
}
