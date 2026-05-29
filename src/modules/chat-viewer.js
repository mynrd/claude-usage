import { escapeHtml, highlightText, formatNum } from './utils.js';

let chatMessages = [];

// Find the index of the bracket that closes the JSON value opened at `start`,
// respecting string literals and escapes. Returns -1 if unbalanced.
function findJsonEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Split `text` into alternating plain-text and valid-JSON segments.
function extractJsonSegments(text) {
  const segments = [];
  let i = 0;
  let textStart = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      const end = findJsonEnd(text, i);
      if (end !== -1) {
        const candidate = text.slice(i, end + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed !== null && typeof parsed === 'object') {
            if (i > textStart) segments.push({ type: 'text', value: text.slice(textStart, i) });
            segments.push({ type: 'json', value: JSON.stringify(parsed, null, 2) });
            i = end + 1;
            textStart = i;
            continue;
          }
        } catch { /* not valid JSON, treat as text */ }
      }
    }
    i++;
  }
  if (textStart < text.length) segments.push({ type: 'text', value: text.slice(textStart) });
  return segments;
}

// Pretty-print a string that is entirely a JSON object/array; else return it unchanged.
function prettyJson(str) {
  const trimmed = str.trim();
  if (!/^[{[]/.test(trimmed)) return str;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object') return JSON.stringify(parsed, null, 2);
  } catch { /* leave as-is */ }
  return str;
}

// Render text, pretty-printing any embedded valid JSON as a code block.
function renderJsonAware(text, highlight) {
  const segments = extractJsonSegments(text);
  if (!segments.some(s => s.type === 'json')) {
    return highlightText(escapeHtml(text), highlight);
  }
  return segments.map(s => {
    if (s.type === 'json') {
      return `<pre class="chat-json"><code>${highlightText(escapeHtml(s.value), highlight)}</code></pre>`;
    }
    return highlightText(escapeHtml(s.value), highlight);
  }).join('');
}

function renderIdeContext(text) {
  const ideBlocks = [];
  let remaining = text;

  remaining = remaining.replace(/<ide_opened_file>([\s\S]*?)<\/ide_opened_file>/g, (_, content) => {
    const match = content.match(/opened the file (.+?) in the IDE/);
    const filePath = match ? match[1].trim() : content.trim();
    ideBlocks.push(`<div class="ide-context"><span class="ide-badge">Opened File</span><span class="ide-path">${escapeHtml(filePath)}</span></div>`);
    return '';
  });

  remaining = remaining.replace(/<ide_selection>([\s\S]*?)<\/ide_selection>/g, (_, content) => {
    const lineMatch = content.match(/selected the lines (\d+) to (\d+) from (.+?):/);
    if (lineMatch) {
      const filePath = lineMatch[3].trim();
      const lines = `L${lineMatch[1]}-${lineMatch[2]}`;
      const selectedText = content.split('\n').slice(1).join('\n').replace(/\nThis may or may not be related to the current task\./, '').trim();
      ideBlocks.push(`<div class="ide-context"><span class="ide-badge">Selection</span><span class="ide-path">${escapeHtml(filePath)}:${lines}</span>${selectedText ? `<pre class="ide-code">${escapeHtml(selectedText)}</pre>` : ''}</div>`);
    } else {
      ideBlocks.push(`<div class="ide-context"><span class="ide-badge">Selection</span><pre class="ide-code">${escapeHtml(content.trim())}</pre></div>`);
    }
    return '';
  });

  remaining = remaining.replace(/This may or may not be related to the current task\.\s*/g, '').trim();
  return { ideHtml: ideBlocks.join(''), remaining };
}

function renderChatParts(parts, highlight) {
  return parts.map(p => {
    if (p.type === 'text') {
      const { ideHtml, remaining } = renderIdeContext(p.text);
      let html = '';
      if (ideHtml) html += ideHtml;
      if (remaining) html += `<div class="chat-msg-body">${renderJsonAware(remaining, highlight)}</div>`;
      return html;
    }
    if (p.type === 'tool_use') {
      if (p.tool === 'Agent') {
        const name = p.agentType || 'subagent';
        let modelChip;
        if (p.agentModel) {
          const family = (p.agentModel.match(/opus|sonnet|haiku/) || [''])[0];
          const srcLabel = p.agentModelSource === 'override' ? 'override' : 'agent default';
          modelChip = `<span class="model-badge model-${family}">${escapeHtml(shortModel(p.agentModel))}</span><span class="agent-model-src">${srcLabel}</span>`;
        } else {
          modelChip = `<span class="agent-model-src">inherits parent model</span>`;
        }
        return `<div class="chat-tool-call chat-agent-call">
          <div class="agent-call-head">
            <span class="tool-badge agent-badge">&#10551; Subagent</span>
            <span class="agent-name">${escapeHtml(name)}</span>
            ${modelChip}
          </div>
          <code class="tool-input">${highlightText(escapeHtml(prettyJson(p.input)), highlight)}</code>
        </div>`;
      }
      return `<div class="chat-tool-call">
        <span class="tool-badge">${escapeHtml(p.tool)}</span>
        <code class="tool-input">${highlightText(escapeHtml(prettyJson(p.input)), highlight)}</code>
      </div>`;
    }
    if (p.type === 'tool_result') {
      const cls = p.isError ? 'tool-result tool-error' : 'tool-result';
      const text = p.content.length > 2000 ? p.content.substring(0, 2000) + '\n...(truncated)' : p.content;
      let agentInfo = '';
      if (p.agentUsage) {
        const u = p.agentUsage;
        const dur = u.durationMs > 0 ? `${(u.durationMs / 1000).toFixed(1)}s` : '';
        agentInfo = `<div class="agent-usage-bar">Agent: ${formatNum(u.totalTokens)} tokens &middot; ${u.toolUses} tool calls${dur ? ` &middot; ${dur}` : ''}</div>`;
      }
      return `${agentInfo}<div class="${cls}">${highlightText(escapeHtml(text), highlight)}</div>`;
    }
    if (p.type === 'image') {
      const src = `data:${p.mediaType};base64,${p.data}`;
      return `<div class="chat-image"><img src="${src}" alt="Attached image" /></div>`;
    }
    return '';
  }).join('');
}

function shortModel(m) {
  const match = m.match(/(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/);
  if (!match) return m;
  const minor = match[3] ? `.${match[3]}` : '';
  return `${match[1]}-${match[2]}${minor}`;
}

function renderChatMessages(messages, highlight) {
  return messages.map(m => {
    const time = m.timestamp
      ? new Date(m.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : '';
    let metaHtml = '';
    if (m.role === 'assistant') {
      const parts = [];
      if (m.model) {
        const family = shortModel(m.model).split('-')[0];
        parts.push(`<span class="model-badge model-${family}">${shortModel(m.model)}</span>`);
      }
      if (m.usage) {
        const u = m.usage;
        const total = u.input + u.output + u.cacheCreate + u.cacheRead;
        parts.push(`<span class="chat-usage">in:${formatNum(u.input)} out:${formatNum(u.output)}${u.cacheRead ? ` cache:${formatNum(u.cacheRead)}` : ''} = ${formatNum(total)}</span>`);
      }
      if (parts.length) metaHtml = `<div class="chat-msg-meta">${parts.join(' ')}</div>`;
    }
    return `<div class="chat-msg chat-${m.role}">
      <div class="chat-msg-header">
        <span class="chat-role">${m.role === 'user' ? 'You' : m.role === 'tool' ? 'Tool Result' : 'Claude'}</span>
        <span class="chat-time">${time}</span>
      </div>
      ${metaHtml}
      ${renderChatParts(m.parts, highlight)}
    </div>`;
  }).join('');
}

export async function openSessionChat(folder, sessionId) {
  const messages = await window.api.getSessionChat(folder, sessionId);
  chatMessages = messages;
  const overlay = document.getElementById('chat-overlay');
  const body = document.getElementById('chat-body');
  const searchInput = document.getElementById('chat-search');
  const countEl = document.getElementById('chat-search-count');

  searchInput.value = '';
  countEl.textContent = '';
  body.innerHTML = messages.length === 0
    ? '<div class="empty-state">No messages found</div>'
    : renderChatMessages(messages);

  overlay.classList.remove('hidden');
  body.scrollTop = 0;

  body.querySelectorAll('.chat-image img').forEach(img => {
    img.addEventListener('click', () => {
      document.getElementById('lightbox-img').src = img.src;
      document.getElementById('image-lightbox').classList.remove('hidden');
    });
  });
}

export function initChatViewer() {
  document.getElementById('chat-search').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    const body = document.getElementById('chat-body');
    const countEl = document.getElementById('chat-search-count');

    if (!q) {
      body.innerHTML = renderChatMessages(chatMessages);
      countEl.textContent = '';
      return;
    }

    body.innerHTML = renderChatMessages(chatMessages, q);
    const marks = body.querySelectorAll('.chat-highlight');
    countEl.textContent = marks.length ? `${marks.length} found` : 'No matches';
    if (marks.length) marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  document.getElementById('btn-close-chat').addEventListener('click', () => {
    document.getElementById('chat-overlay').classList.add('hidden');
  });

  document.getElementById('image-lightbox').addEventListener('click', () => {
    document.getElementById('image-lightbox').classList.add('hidden');
  });
}
