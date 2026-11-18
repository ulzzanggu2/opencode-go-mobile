/* 오픈코드 Go — 한국어 대화형 클라이언트 */
'use strict';

const DEFAULT_BASE = 'https://opencode.ai/inference/go/openai/v1';
const DEFAULT_MODEL = 'glm-5.3';
const DEFAULT_SYSTEM =
  '당신은 한국어로 대화하는 유능한 도우미입니다. 간결하고 정확하게 답하고, ' +
  '코드나 목록은 읽기 쉽게 정리하세요. 음성으로 읽힐 수 있으니 과한 기호는 피하세요.';

const LS = {
  key: 'ocgo.key',
  base: 'ocgo.base',
  model: 'ocgo.model',
  system: 'ocgo.system',
  rate: 'ocgo.rate',
  autoListen: 'ocgo.autoListen',
  autoSpeak: 'ocgo.autoSpeak',
  talk: 'ocgo.talk',
  webSearch: 'ocgo.webSearch',
  sessions: 'ocgo.sessions',
  active: 'ocgo.active',
};

const state = {
  key: localStorage.getItem(LS.key) || '',
  base: localStorage.getItem(LS.base) || DEFAULT_BASE,
  model: localStorage.getItem(LS.model) || DEFAULT_MODEL,
  system: localStorage.getItem(LS.system) ?? DEFAULT_SYSTEM,
  rate: parseFloat(localStorage.getItem(LS.rate) || '1'),
  autoListen: localStorage.getItem(LS.autoListen) !== '0',
  autoSpeak: localStorage.getItem(LS.autoSpeak) !== '0',
  talk: localStorage.getItem(LS.talk) === '1',
  webSearch: localStorage.getItem(LS.webSearch) !== '0',
  models: [],
  sessions: [],        // [{id, title, model, messages:[{role,content}], updatedAt}]
  activeId: localStorage.getItem(LS.active) || '',
  streaming: false,
  listening: false,
  speaking: false,
  sessionId: uuid(),   // x-opencode-session 헤더용 (앱 실행마다 새로)
  currentBubble: null,
  currentText: '',
  ttsReady: null,
  turnSources: [],
};

const $ = (id) => document.getElementById(id);
const cap = () => (window.Capacitor && window.Capacitor.Plugins) || {};
const nativeStream = () => cap().OcStream;
const nativeSpeech = () => cap().OcSpeech;
const nativeHttp = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) || null;

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function toast(text, ms = 2400) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ─────────── 저장 ─────────── */
function persist() {
  localStorage.setItem(LS.key, state.key);
  localStorage.setItem(LS.base, state.base);
  localStorage.setItem(LS.model, state.model);
  localStorage.setItem(LS.system, state.system);
  localStorage.setItem(LS.rate, String(state.rate));
  localStorage.setItem(LS.autoListen, state.autoListen ? '1' : '0');
  localStorage.setItem(LS.autoSpeak, state.autoSpeak ? '1' : '0');
  localStorage.setItem(LS.talk, state.talk ? '1' : '0');
  localStorage.setItem(LS.webSearch, state.webSearch ? '1' : '0');
}

function loadSessions() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS.sessions) || '[]');
    state.sessions = Array.isArray(raw) ? raw : [];
  } catch (_) {
    state.sessions = [];
  }
}

function persistSessions() {
  state.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  state.sessions = state.sessions.slice(0, 30);
  try {
    localStorage.setItem(LS.sessions, JSON.stringify(state.sessions));
  } catch (e) {
    toast('저장 공간이 부족해 기록을 저장하지 못했습니다');
  }
  localStorage.setItem(LS.active, state.activeId);
}

function activeSession() {
  return state.sessions.find((s) => s.id === state.activeId) || null;
}

function ensureSession() {
  let s = activeSession();
  if (!s) {
    s = { id: uuid(), title: '새 대화', model: state.model, messages: [], updatedAt: Date.now() };
    state.sessions.unshift(s);
    state.activeId = s.id;
    persistSessions();
  }
  return s;
}

function newSession() {
  const s = { id: uuid(), title: '새 대화', model: state.model, messages: [], updatedAt: Date.now() };
  state.sessions.unshift(s);
  state.activeId = s.id;
  persistSessions();
  renderEmpty();
}

function renderEmpty() {
  $('messages').innerHTML =
    '<div class="empty" id="emptyState"><div class="empty-logo">◍</div>' +
    '<p>무엇이든 물어보세요.</p>' +
    '<p class="empty-sub">마이크를 누르고 말하면 대화 모드로 이어집니다.</p></div>';
}

function renderActiveSession() {
  const s = activeSession();
  if (!s || !s.messages.length) { renderEmpty(); return; }
  $('messages').innerHTML = '';
  for (const m of s.messages) renderMessage(m.role, m.content);
  scrollBottom(true);
}

/* ─────────── HTTP ─────────── */
async function httpGet(url, headers) {
  const plugin = nativeHttp();
  if (plugin) {
    const res = await plugin.get({ url, headers });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, data: res.data };
  }
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch (_) {}
  return { ok: res.ok, status: res.status, data };
}

async function loadModels() {
  try {
    const res = await httpGet(state.base.replace(/\/$/, '') + '/models', {
      Authorization: 'Bearer ' + state.key,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const list = (res.data && res.data.data) || [];
    state.models = list
      .filter((m) => !m.type || m.type === 'chat')
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        desc: m.description || '',
        usage: m.go && m.go.monthly_usage ? m.go.monthly_usage.go : null,
        vision: !!(m.modalities && (m.modalities.input || []).some((t) => String(t).startsWith('image'))),
        reasoning: !!(m.capabilities && m.capabilities.reasoning && m.capabilities.reasoning.supported),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    renderModelList();
  } catch (e) {
    toast('모델 목록을 불러오지 못했습니다: ' + explainError(e.message));
  }
}

/* ─────────── 오류 안내 ─────────── */
function explainError(msg) {
  const m = String(msg || '');
  if (/HTTP 40[13]/.test(m)) return 'API 키가 올바르지 않거나 권한이 없습니다. 설정에서 키를 확인하세요.';
  if (/HTTP 429/.test(m)) return '사용량 한도를 넘었습니다. 무료 모델로 바꾸거나 잔액을 충전하세요.';
  if (/HTTP 402/.test(m)) return '크레딧이 부족합니다. OpenCode 콘솔에서 충전하세요.';
  if (/HTTP 5\d\d/.test(m)) return 'OpenCode 서버 오류입니다. 잠시 뒤 다시 시도하세요.';
  if (/timeout|Timeout|시간 초과/.test(m)) return '응답 시간이 초과되었습니다. 네트워크를 확인하세요.';
  if (/resolve host|UnknownHost|network|Network|ECONN/i.test(m)) return '네트워크에 연결할 수 없습니다.';
  return m;
}

/* ─────────── 스트리밍 + 웹 검색 도구 ─────────── */

// 모델에게 제공하는 도구 정의 (무료 검색만 사용)
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '인터넷에서 최신 정보를 검색합니다. 날씨, 환율, 뉴스, 최신 버전, 실시간 수치처럼 ' +
        '학습 시점 이후 달라졌을 수 있는 내용은 반드시 이 도구를 사용하세요.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '검색어 (한국어 가능)' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: '검색 결과 중 특정 페이지의 본문을 읽습니다. 자세한 내용이 필요할 때 사용하세요.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http(s) 주소' } },
        required: ['url'],
      },
    },
  },
];

// 검색 결과 캐시 (10분) — 같은 질문 반복 시 DDG 부하와 차단 위험을 줄인다
const searchCache = new Map();
const pageCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL) { map.delete(key); return null; }
  return hit.data;
}

function cacheSet(map, key, data) {
  map.set(key, { ts: Date.now(), data });
  if (map.size > 40) map.delete(map.keys().next().value);
}

function toolsAvailable() {
  const web = cap().OcWeb;
  return state.webSearch && !!web;
}

async function streamChat(userText) {
  const session = ensureSession();
  session.messages.push({ role: 'user', content: userText });
  if (session.messages.length === 1) session.title = userText.slice(0, 28);
  session.model = state.model;
  session.updatedAt = Date.now();
  persistSessions();
  renderMessage('user', userText);
  state.turnSources = [];
  return runTurn(session, 0);
}

function reqHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + state.key,
    'x-opencode-session': state.sessionId,
    'User-Agent': 'ocgo-mobile/1.0 (android)',
  };
}

async function runTurn(session, round) {
  const bubble = renderMessage('assistant', '');
  bubble.classList.add('cursor');
  state.currentText = '';
  state.streaming = true;
  setBusy(true);

  const useTools = toolsAvailable() && round < 2;
  const sys = [state.system];
  if (useTools) {
    sys.push(
      '실시간 정보(환율, 주가, 날씨, 뉴스, 최신 버전·가격, 오늘 날짜 기준 사실)를 물으면 ' +
      '반드시 web_search 도구를 먼저 호출해 결과를 확인한 뒤 답하세요. ' +
      '검색 결과 없이 추측해서 수치를 말하지 마세요. 결과가 부족하면 open_url로 본문을 확인하세요. ' +
      '검색 결과를 근거로 답할 때는 문장 끝에 [1], [2]처럼 결과 번호를 붙여 인용하세요.'
    );
  }
  const body = {
    model: state.model,
    stream: true,
    messages: [
      ...(sys.filter(Boolean).length ? [{ role: 'system', content: sys.filter(Boolean).join('\n\n') }] : []),
      ...session.messages.slice(-24),
    ],
  };
  if (useTools) body.tools = TOOLS;

  const url = state.base.replace(/\/$/, '') + '/chat/completions';
  const headers = reqHeaders();
  const ns = nativeStream();

  if (!ns) return browserFallback(url, headers, body, bubble, session);

  await new Promise((resolve) => {
    let cleanup = () => {};
    let settled = false;
    const settle = () => { if (settled) return; settled = true; cleanup(); resolve(); };

    (async () => {
      const l1 = await ns.addListener('delta', (e) => {
        state.currentText += e.text || '';
        bubble.innerHTML = renderMarkdown(state.currentText, state.turnSources);
        scrollBottom();
      });
      const l2 = await ns.addListener('toolcalls', async (e) => {
        try { await handleToolCalls(session, round, e, bubble); } catch (err) { failTurn(bubble, String(err)); }
        settle();
      });
      const l3 = await ns.addListener('done', (e) => {
        finishTurn(session, (e && e.text) || state.currentText, bubble);
        settle();
      });
      const l4 = await ns.addListener('error', (e) => {
        failTurn(bubble, (e && e.message) || '알 수 없는 오류');
        settle();
      });
      cleanup = () => { l1 && l1.remove(); l2 && l2.remove(); l3 && l3.remove(); l4 && l4.remove(); };
      try {
        await ns.start({ url, headers, body: JSON.stringify(body) });
      } catch (err) {
        failTurn(bubble, err.message || String(err));
        settle();
      }
    })();
  });
}

function finishTurn(session, text, bubble) {
  bubble.classList.remove('cursor');
  const body = (text || '').trim();
  if (body) {
    session.messages.push({ role: 'assistant', content: body });
    session.updatedAt = Date.now();
    persistSessions();
    const src = collectSources(session);
    bubble.innerHTML = renderMarkdown(body, src) + sourcesHtml(src);
  } else {
    bubble.innerHTML = '<span class="thinking">응답이 비어 있습니다.</span>';
  }
  state.streaming = false;
  setBusy(false);
  maybeSpeak(body);
}

function failTurn(bubble, msg) {
  bubble.classList.remove('cursor');
  bubble.innerHTML = '<span class="thinking">' + escapeHtml(explainError(msg)) + '</span>';
  state.streaming = false;
  setBusy(false);
  voiceIdle();
  if (/HTTP 40[13]/.test(String(msg))) toast('설정에서 API 키를 확인하세요', 3200);
}

/* ── 도구 실행 ── */
function toolLine(name, args) {
  const row = document.createElement('div');
  row.className = 'tool-line';
  const label = name === 'web_search'
    ? '🔍 검색 중: ' + (args.query || '')
    : '📄 읽는 중: ' + (args.url || '').slice(0, 60);
  row.textContent = label;
  $('messages').appendChild(row);
  scrollBottom(true);
  return {
    update(result) {
      if (result && result.error) {
        row.textContent = label.replace('검색 중', '검색 실패').replace('읽는 중', '읽기 실패');
        row.classList.add('failed');
        return;
      }
      if (name === 'web_search') {
        const n = (result && result.results ? result.results.length : 0);
        row.textContent = '🔍 ' + (args.query || '') + ' — 결과 ' + n + '건' +
          (result && result.source === 'wikipedia' ? ' (위키백과)' : '');
      } else {
        row.textContent = '📄 ' + (result && result.title ? result.title : (args.url || '')).slice(0, 70);
      }
    },
  };
}

async function execTool(name, args) {
  const web = cap().OcWeb;
  if (!web) return { error: '검색 기능을 사용할 수 없습니다' };

  if (name === 'web_search') {
    const query = String(args.query || '').trim();
    let data = cacheGet(searchCache, query);
    if (!data) {
      const res = await web.search({ query, limit: 5 });
      data = { source: (res && res.source) || 'duckduckgo', results: ((res && res.results) || []) };
      if (data.results.length) cacheSet(searchCache, query, data);
    }
    // 출처 번호를 매겨 모델이 [1], [2]로 인용할 수 있게 한다
    const results = data.results.map((r) => {
      let n = state.turnSources.findIndex((x) => x.url === r.url);
      if (n < 0) {
        state.turnSources.push({ title: r.title, url: r.url });
        n = state.turnSources.length - 1;
      }
      return { n: n + 1, title: r.title, url: r.url, snippet: r.snippet };
    });
    return { source: data.source, results, cached: !!cacheGet(searchCache, query) };
  }

  if (name === 'open_url') {
    const url = String(args.url || '');
    let data = cacheGet(pageCache, url);
    if (!data) {
      const res = await web.fetchPage({ url });
      data = { title: res.title, url: res.url, text: (res.text || '').slice(0, 2500) };
      if (data.text) cacheSet(pageCache, url, data);
    }
    return data;
  }
  return { error: '알 수 없는 도구: ' + name };
}

async function handleToolCalls(session, round, e, bubble) {
  bubble.classList.remove('cursor');
  const text = e.text || '';
  if (text.trim()) bubble.innerHTML = renderMarkdown(text);

  const raw = (e.calls || []).filter((c) => c && c.function && c.function.name);
  // 같은 이름·같은 인자의 중복 호출은 한 번만 실행한다
  const seenCalls = new Set();
  const calls = raw.filter((c) => {
    const key = c.function.name + '|' + (c.function.arguments || '');
    if (seenCalls.has(key)) return false;
    seenCalls.add(key);
    return true;
  });
  if (!calls.length) { finishTurn(session, text, bubble); return; }

  // assistant 메시지에 도구 호출을 기록
  session.messages.push({
    role: 'assistant',
    content: text || '',
    tool_calls: calls.map((c) => ({
      id: c.id || 'call_' + Math.random().toString(16).slice(2),
      type: 'function',
      function: { name: c.function.name, arguments: c.function.arguments || '{}' },
    })),
  });

  let searchFailures = 0;
  let searchAttempts = 0;
  for (const call of calls) {
    let args = {};
    try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) {}
    const line = toolLine(call.function.name, args);
    let result;
    try {
      result = await execTool(call.function.name, args);
    } catch (err) {
      result = { error: String((err && err.message) || err) };
    }
    if (call.function.name === 'web_search') {
      searchAttempts++;
      if (result && result.error) searchFailures++;
    }
    line.update(result);
    session.messages.push({
      role: 'tool',
      tool_call_id: call.id || 'call_unknown',
      content: JSON.stringify(result).slice(0, 6000),
    });
  }

  if (searchAttempts && searchFailures === searchAttempts) {
    toast('검색에 실패했습니다 — 아는 범위에서 답합니다', 3200);
  }
  session.updatedAt = Date.now();
  persistSessions();
  if (call0EmptyText(bubble, text)) bubble.remove();
  // 이전 스트림 스레드가 완전히 끝난 뒤 다음 라운드를 시작한다
  await new Promise((r) => setTimeout(r, 250));
  await runTurn(session, round + 1);
}

function call0EmptyText(bubble, text) {
  return !text || !text.trim();
}

function collectSources(session) {
  const out = [];
  const seen = new Set();
  const msgs = (session && session.messages ? session.messages : []).slice(-14);
  for (const m of msgs) {
    if (m.role !== 'tool' || !m.content) continue;
    try {
      const j = JSON.parse(m.content);
      for (const r of (j.results || [])) {
        if (!r || !r.url || seen.has(r.url)) continue;
        seen.add(r.url);
        out.push({ title: r.title || r.url, url: r.url });
      }
    } catch (_) {}
  }
  return out;
}

function sourcesHtml(list) {
  const src = (list || state.turnSources || []).slice(0, 6);
  if (!src.length) return '';
  const uniq = [];
  const seen = new Set();
  for (const s of src) {
    const key = (s.title || '') + '|' + (s.url || '');
    if (!s.url || seen.has(s.url) || seen.has(key)) continue;
    seen.add(s.url);
    seen.add(key);
    uniq.push(s);
  }
  if (!uniq.length) return '';
  const items = uniq.map((s, i) =>
    '<li><span class="cite-num">' + (i + 1) + '</span>' +
    '<a href="' + escapeHtml(s.url) + '" target="_blank" rel="noreferrer">' +
    escapeHtml(s.title || s.url) + '</a></li>').join('');
  return '<div class="sources"><span>출처</span><ul>' + items + '</ul></div>';
}

/* ── 브라우저 폴백 (도구 없이) ── */
async function browserFallback(url, headers, body, bubble, session) {
  const plain = { ...body };
  delete plain.tools;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(plain) });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const d = j.choices && j.choices[0] && j.choices[0].delta;
          if (d && d.content) {
            text += d.content;
            bubble.innerHTML = renderMarkdown(text);
            scrollBottom();
          }
        } catch (_) {}
      }
    }
    finishTurn(session, text, bubble);
  } catch (e) {
    failTurn(bubble, e.message || String(e));
  }
}

async function cancelStream() {
  const ns = nativeStream();
  if (ns) { try { await ns.cancel(); } catch (_) {} }
  stopSpeaking();
  state.streaming = false;
  setBusy(false);
}

/* ─────────── 렌더 ─────────── */
function renderMessage(role, text) {
  const empty = $('emptyState');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'msg-row ' + role;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = text ? renderMarkdown(text) : '';
  row.appendChild(bubble);
  $('messages').appendChild(row);
  scrollBottom();
  return bubble;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMarkdown(src, cite) {
  const blocks = [];
  let text = escapeHtml(src).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push('<pre><code>' + code.replace(/\n$/, '') + '</code></pre>');
    return '\u0000B' + (blocks.length - 1) + '\u0000';
  });
  text = text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^### (.*)$/gm, '<strong>$1</strong>')
    .replace(/^## (.*)$/gm, '<strong>$1</strong>')
    .replace(/^# (.*)$/gm, '<strong>$1</strong>')
    .replace(/^\s*[-*] (.*)$/gm, '• $1')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  text = text.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[+i]);
  // [1], [2] 인용을 출처 링크로 바꾼다
  if (cite && cite.length) {
    text = text.replace(/\[(\d{1,2})\]/g, (m, n) => {
      const src = cite[Number(n) - 1];
      if (!src) return m;
      return '<a class="cite" href="' + escapeHtml(src.url) + '" target="_blank" rel="noreferrer">[' + n + ']</a>';
    });
  }
  return text;
}

let scrollTick = 0;
function scrollBottom(force) {
  const now = Date.now();
  if (!force && now - scrollTick < 60) return;
  scrollTick = now;
  const m = $('messages');
  m.scrollTop = m.scrollHeight;
}

function setBusy(busy) {
  $('send').disabled = busy;
  $('stop').classList.toggle('hidden', !busy);
}

/* ─────────── 음성 ─────────── */
function autoLang() { return 'ko-KR'; }

async function checkVoice() {
  const ns = nativeSpeech();
  if (!ns || !ns.available) return;
  try {
    const res = await ns.available();
    state.ttsReady = !!res.tts;
    if (!res.tts) toast('이 기기에서 음성 읽기를 쓸 수 없습니다', 3200);
    else if (res.ttsKo === false) toast('한국어 음성이 없습니다 — 기기 설정 → TTS에서 설치', 3600);
  } catch (_) {}
}

async function startListening() {
  if (state.streaming || state.listening) return;
  state.listening = true;
  $('mic').classList.add('recording');

  const ns = nativeSpeech();
  if (ns) {
    let cleanup = () => {};
    try {
      const p = await ns.addListener('partial', (e) => { $('input').value = e.text || ''; });
      const f = await ns.addListener('final', (e) => {
        const t = (e.text || '').trim();
        cleanup(); stopListening();
        if (t) { $('input').value = t; send(); }
      });
      const er = await ns.addListener('sttError', (e) => {
        cleanup(); stopListening();
        const msg = e.message || '실패';
        if (!/알아듣지|말소리|시간/.test(msg)) toast('음성 인식: ' + msg);
        if (state.talk) setTimeout(() => startListening(), 900);
      });
      cleanup = () => { p && p.remove(); f && f.remove(); er && er.remove(); };
      await ns.startListening({ lang: autoLang() });
    } catch (e) {
      stopListening();
      toast('마이크를 열 수 없습니다: ' + (e.message || e));
    }
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { stopListening(); toast('이 환경에서는 음성 인식을 지원하지 않습니다.'); return; }
  const rec = new SR();
  rec.lang = autoLang();
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (ev) => {
    let t = '';
    for (let i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript;
    $('input').value = t;
    if (ev.results[ev.results.length - 1].isFinal) { rec.stop(); if (t.trim()) send(); }
  };
  rec.onerror = (e) => { stopListening(); toast('음성 인식 오류: ' + e.error); };
  rec.onend = () => stopListening();
  state._rec = rec;
  rec.start();
}

function stopListening() {
  state.listening = false;
  $('mic').classList.remove('recording');
  const ns = nativeSpeech();
  if (ns) { try { ns.stopListening(); } catch (_) {} }
  if (state._rec && state._rec.stop) { try { state._rec.stop(); } catch (_) {} state._rec = null; }
}

async function speak(text) {
  const clean = text
    .replace(/```[\s\S]*?```/g, ' 코드 블록 ')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) { voiceIdle(); return; }
  state.speaking = true;
  const ns = nativeSpeech();
  if (ns) {
    try {
      const l = await ns.addListener('speakDone', () => { l && l.remove(); onSpeakDone(); });
      await ns.speak({ text: clean.slice(0, 4000), lang: autoLang(), rate: state.rate });
    } catch (e) { state.speaking = false; onSpeakDone(); }
    return;
  }
  if (!window.speechSynthesis) { state.speaking = false; onSpeakDone(); return; }
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = autoLang();
  u.rate = state.rate;
  u.onend = () => { state.speaking = false; onSpeakDone(); };
  u.onerror = () => { state.speaking = false; onSpeakDone(); };
  window.speechSynthesis.speak(u);
}

function stopSpeaking() {
  state.speaking = false;
  const ns = nativeSpeech();
  if (ns) { try { ns.stopSpeaking(); } catch (_) {} }
  if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (_) {} }
}

function maybeSpeak(text) {
  if (state.talk && state.autoSpeak) speak(text);
  else voiceIdle();
}

function onSpeakDone() {
  if (state.talk && state.autoListen) setTimeout(() => startListening(), 320);
  else voiceIdle();
}

function voiceIdle() {
  $('mic').classList.remove('recording');
}

/* ─────────── 전송 ─────────── */
function send() {
  if (state.streaming) return;
  const el = $('input');
  const text = el.value.trim();
  if (!text) return;
  if (!state.key) { showSetup('API 키를 먼저 입력하세요.'); return; }
  el.value = '';
  el.style.height = 'auto';
  stopListening();
  stopSpeaking();
  streamChat(text);
}

/* ─────────── 화면 전환 ─────────── */
function showSetup(msg) {
  $('setup').classList.remove('hidden');
  $('chat').classList.add('hidden');
  $('keyInput').value = state.key;
  $('baseInput').value = state.base;
  $('setupMsg').textContent = msg || '';
}

function showChat() {
  $('setup').classList.add('hidden');
  $('chat').classList.remove('hidden');
  $('modelName').textContent = displayModelName();
  updateTalkUI();
}

function displayModelName() {
  const m = state.models.find((x) => x.id === state.model);
  return m ? m.name : state.model;
}

function updateTalkUI() {
  $('toggleTalk').setAttribute('aria-pressed', state.talk ? 'true' : 'false');
  $('talkBanner').classList.toggle('hidden', !state.talk);
}

/* ─────────── 모델 목록 ─────────── */
function renderModelList(filter = '') {
  const list = $('modelList');
  list.innerHTML = '';
  const f = filter.trim().toLowerCase();
  const items = state.models.filter(
    (m) => !f || m.id.toLowerCase().includes(f) || m.name.toLowerCase().includes(f)
  );
  if (!items.length) {
    list.innerHTML = '<p class="hint">일치하는 모델이 없습니다. 설정에서 키를 확인해 주세요.</p>';
    return;
  }
  for (const m of items) {
    const btn = document.createElement('button');
    btn.className = 'model-item' + (m.id === state.model ? ' active' : '');
    btn.type = 'button';
    btn.innerHTML =
      '<div class="mi-top"><span class="mi-name">' + escapeHtml(m.name) + '</span>' +
      (m.vision ? '<span class="badge free">이미지</span>' : '') +
      (m.reasoning ? '<span class="badge free">추론</span>' : '') +
      (m.usage != null ? '<span class="badge">$' + m.usage + '</span>' : '') +
      '</div>' +
      '<span class="mi-id">' + escapeHtml(m.id) + '</span>' +
      (m.desc ? '<span class="mi-desc">' + escapeHtml(m.desc.slice(0, 110)) + '</span>' : '');
    btn.onclick = () => {
      state.model = m.id;
      persist();
      $('modelName').textContent = m.name;
      closeSheet('sheetModel');
      toast(m.name + ' 선택됨');
    };
    list.appendChild(btn);
  }
}

/* ─────────── 대화 목록 ─────────── */
function renderSessionList() {
  const list = $('sessionList');
  list.innerHTML = '';
  if (!state.sessions.length) {
    list.innerHTML = '<p class="hint">저장된 대화가 없습니다.</p>';
    return;
  }
  for (const s of state.sessions) {
    const row = document.createElement('div');
    row.className = 'session-item' + (s.id === state.activeId ? ' active' : '');
    const btn = document.createElement('button');
    btn.className = 'session-main';
    btn.type = 'button';
    btn.innerHTML =
      '<span class="si-title">' + escapeHtml(s.title || '새 대화') + '</span>' +
      '<span class="si-meta">' + escapeHtml(s.model || '') + ' · ' + s.messages.length + '개 메시지</span>';
    btn.onclick = () => {
      state.activeId = s.id;
      persistSessions();
      renderActiveSession();
      closeSheet('sheetSessions');
    };
    const del = document.createElement('button');
    del.className = 'session-del';
    del.type = 'button';
    del.setAttribute('aria-label', '삭제');
    del.textContent = '✕';
    del.onclick = (e) => {
      e.stopPropagation();
      state.sessions = state.sessions.filter((x) => x.id !== s.id);
      if (state.activeId === s.id) {
        state.activeId = state.sessions[0] ? state.sessions[0].id : '';
        renderActiveSession();
      }
      persistSessions();
      renderSessionList();
    };
    row.appendChild(btn);
    row.appendChild(del);
    list.appendChild(row);
  }
}

function closeSheet(id) { $(id).classList.add('hidden'); }

/* ─────────── 이벤트 ─────────── */
function bind() {
  $('toggleKey').onclick = () => {
    const i = $('keyInput');
    const hidden = i.type === 'password';
    i.type = hidden ? 'text' : 'password';
    $('toggleKey').textContent = hidden ? '숨기기' : '보기';
  };
  $('setToggleKey').onclick = () => {
    const i = $('setKey');
    const hidden = i.type === 'password';
    i.type = hidden ? 'text' : 'password';
    $('setToggleKey').textContent = hidden ? '숨기기' : '보기';
  };

  $('saveKey').onclick = async () => {
    const k = $('keyInput').value.trim();
    const b = $('baseInput').value.trim() || DEFAULT_BASE;
    if (!k) { $('setupMsg').textContent = 'API 키를 입력하세요.'; return; }
    state.key = k;
    state.base = b;
    persist();
    $('setupMsg').textContent = '확인 중…';
    try {
      const res = await httpGet(b.replace(/\/$/, '') + '/models', { Authorization: 'Bearer ' + k });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      $('setupMsg').textContent = '';
      showChat();
      await loadModels();
      if (!state.models.find((m) => m.id === state.model) && state.models.length) {
        state.model = state.models[0].id;
        persist();
        $('modelName').textContent = displayModelName();
      }
      renderActiveSession();
      toast('연결되었습니다');
    } catch (e) {
      $('setupMsg').textContent = '연결 실패: ' + explainError(e.message);
    }
  };

  $('pickModel').onclick = () => {
    if (!state.models.length) loadModels();
    $('sheetModel').classList.remove('hidden');
  };
  $('modelSearch').oninput = (e) => renderModelList(e.target.value);

  $('openSessions').onclick = () => {
    renderSessionList();
    $('sheetSessions').classList.remove('hidden');
  };
  $('newChat').onclick = () => {
    stopListening();
    stopSpeaking();
    newSession();
    closeSheet('sheetSessions');
    toast('새 대화를 시작합니다');
  };

  $('openSettings').onclick = () => {
    $('setKey').value = state.key;
    $('setBase').value = state.base;
    $('setRate').value = state.rate;
    $('rateVal').textContent = state.rate.toFixed(1) + '×';
    $('setAutoListen').checked = state.autoListen;
    $('setAutoSpeak').checked = state.autoSpeak;
    $('setWebSearch').checked = state.webSearch;
    $('setSystem').value = state.system;
    $('sheetSettings').classList.remove('hidden');
  };
  $('setRate').oninput = (e) => { $('rateVal').textContent = parseFloat(e.target.value).toFixed(1) + '×'; };
  $('saveSettings').onclick = () => {
    state.key = $('setKey').value.trim() || state.key;
    state.base = $('setBase').value.trim() || DEFAULT_BASE;
    state.rate = parseFloat($('setRate').value) || 1;
    state.autoListen = $('setAutoListen').checked;
    state.autoSpeak = $('setAutoSpeak').checked;
    state.webSearch = $('setWebSearch').checked;
    state.system = $('setSystem').value;
    persist();
    closeSheet('sheetSettings');
    toast('저장되었습니다');
    loadModels();
    checkVoice();
  };
  $('clearChat').onclick = () => {
    const s = ensureSession();
    s.messages = [];
    s.title = '새 대화';
    s.updatedAt = Date.now();
    persistSessions();
    renderEmpty();
    closeSheet('sheetSettings');
    toast('이 대화를 지웠습니다');
  };

  document.querySelectorAll('.close-sheet').forEach((b) => {
    b.onclick = () => closeSheet(b.dataset.close);
  });
  document.querySelectorAll('.sheet').forEach((s) => {
    s.addEventListener('click', (e) => { if (e.target === s) s.classList.add('hidden'); });
  });

  $('send').onclick = send;
  $('stop').onclick = cancelStream;

  // 입력 영역의 빈 곳을 눌러도 키보드가 올라오게
  document.querySelector('.composer').addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target === input) return;
    input.focus();
  });

  // 키보드가 올라오면 마지막 메시지가 가리지 않도록
  window.addEventListener('resize', () => scrollBottom(true));

  const input = $('input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  $('mic').onclick = () => {
    if (state.listening) stopListening();
    else { stopSpeaking(); startListening(); }
  };

  $('toggleTalk').onclick = () => {
    state.talk = !state.talk;
    persist();
    updateTalkUI();
    if (state.talk) {
      toast('대화 모드 켜짐 — 말해보세요');
      startListening();
    } else {
      stopListening();
      stopSpeaking();
      toast('대화 모드 꺼짐');
    }
  };
}

/* ─────────── 시작 ─────────── */
(function init() {
  bind();
  loadSessions();
  if (state.key) {
    showChat();
    renderActiveSession();
    loadModels();
    checkVoice();
    // 검색 플러그인이 없으면 조용히 경고
    setTimeout(() => {
      if (state.webSearch && !cap().OcWeb) toast('웹 검색을 사용할 수 없습니다', 3000);
    }, 1200);
  } else {
    showSetup();
  }
  document.addEventListener('backbutton', (e) => {
    const open = document.querySelector('.sheet:not(.hidden)');
    if (open) { e.preventDefault(); open.classList.add('hidden'); }
  });
})();
