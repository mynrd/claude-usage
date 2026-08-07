import { escapeHtml, highlightText, formatNum } from './utils.js';

let chatMessages = [];
let chatSessionId = null;
let searchMarks = [];
let searchIndex = -1;

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

// Render text. Only pretty-print as a JSON code block when the ENTIRE content
// is a JSON object/array; otherwise render the original text unchanged.
function renderJsonAware(text, highlight) {
  const trimmed = text.trim();
  if (/^[{[]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') {
        const pretty = JSON.stringify(parsed, null, 2);
        return `<pre class="chat-json"><code>${highlightText(escapeHtml(pretty), highlight)}</code></pre>`;
      }
    } catch { /* not whole-content JSON — render as plain text */ }
  }
  return highlightText(escapeHtml(text), highlight);
}

// Agent-teams palette: map a teammate's `color` attribute to a hue. Unknown
// colors fall back to a stable hue hashed from the teammate id.
const TEAMMATE_COLORS = {
  blue: '#4A90D9', green: '#22C55E', red: '#E74C3C', orange: '#F5A623',
  purple: '#9B59B6', cyan: '#06B6D4', yellow: '#EAB308', pink: '#EC4899',
  magenta: '#D946EF', teal: '#14B8A6', gray: '#8A8A8A', grey: '#8A8A8A',
};

function teammateColor(color, id) {
  if (color && TEAMMATE_COLORS[color.toLowerCase()]) return TEAMMATE_COLORS[color.toLowerCase()];
  let h = 0;
  for (const ch of (id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 55%, 52%)`;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : '';
}

// If the body is entirely a status JSON payload (e.g. idle_notification),
// return a one-line summary; otherwise null so the caller renders the body.
function teammateStatusLine(body) {
  const trimmed = body.trim();
  if (!/^\{/.test(trimmed)) return null;
  try {
    const o = JSON.parse(trimmed);
    if (o && typeof o === 'object' && o.type) {
      if (o.type === 'idle_notification') {
        const reason = o.idleReason ? ` — ${o.idleReason}` : '';
        return `💤 idle${reason}`;
      }
      return `• ${o.type.replace(/_/g, ' ')}`;
    }
  } catch { /* not status JSON */ }
  return null;
}

// Extract <teammate-message> blocks (Agent teams) into styled cards. Returns
// the card HTML plus whatever text remained outside the blocks.
function renderTeammateBlocks(text, highlight) {
  const cards = [];
  const remaining = text.replace(/<teammate-message\b([^>]*)>([\s\S]*?)<\/teammate-message>/g, (_, rawAttrs, body) => {
    const id = attr(rawAttrs, 'teammate_id') || 'teammate';
    const summary = attr(rawAttrs, 'summary');
    const color = teammateColor(attr(rawAttrs, 'color'), id);
    const status = teammateStatusLine(body);

    let head = `<div class="tm-head">
        <span class="tm-dot"></span>
        <span class="tm-name">${highlightText(escapeHtml(id), highlight)}</span>
        ${status ? `<span class="tm-status">${escapeHtml(status)}</span>` : ''}
      </div>`;
    const summaryHtml = summary ? `<div class="tm-summary">${highlightText(escapeHtml(summary), highlight)}</div>` : '';
    const bodyHtml = status ? '' : `<div class="tm-body">${renderJsonAware(body.trim(), highlight)}</div>`;

    cards.push(`<div class="tm-msg${status ? ' tm-status-only' : ''}" style="--tm-color:${color}">
      ${head}${summaryHtml}${bodyHtml}
    </div>`);
    return '';
  });

  return { teammateHtml: cards.join(''), remaining: remaining.trim() };
}

// Strip ANSI SGR escape codes (e.g. [2m … [22m) that wrap CLI stdout.
function stripAnsi(s) {
  return s.replace(/\[[0-9;]*m/g, '');
}

// Slash-command invocations and their local stdout are injected into the
// transcript as <command-*> / <local-command-*> tags. Render them as compact
// chips instead of leaking the raw markup into the chat body. The per-command
// caveat is boilerplate the CLI prepends to every local command — drop it.
function renderCommandBlocks(text, highlight) {
  const blocks = [];
  let remaining = text;

  remaining = remaining.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');

  remaining = remaining.replace(
    /<command-name>([\s\S]*?)<\/command-name>(?:\s*<command-message>([\s\S]*?)<\/command-message>)?(?:\s*<command-args>([\s\S]*?)<\/command-args>)?/g,
    (_, name, _msg, cmdArgs) => {
      const args = (cmdArgs || '').trim();
      blocks.push(`<div class="cmd-block"><span class="cmd-badge">Command</span><span class="cmd-name">${highlightText(escapeHtml(name.trim()), highlight)}</span>${args ? ` <span class="cmd-args">${highlightText(escapeHtml(args), highlight)}</span>` : ''}</div>`);
      return '';
    });

  remaining = remaining.replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g, (_, out) => {
    const clean = stripAnsi(out).trim();
    if (clean) blocks.push(`<div class="cmd-block"><span class="cmd-badge cmd-badge-out">Output</span><pre class="cmd-stdout">${highlightText(escapeHtml(clean), highlight)}</pre></div>`);
    return '';
  });

  return { commandHtml: blocks.join(''), remaining: remaining.trim() };
}

function innerTag(body, name) {
  const m = body.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`));
  return m ? m[1].trim() : '';
}

// Background-task / workflow completion notices arrive in string content as
// <task-notification> wrappers. Render them as a status chip.
function renderTaskNotifications(text, highlight) {
  const blocks = [];
  const remaining = text.replace(/<task-notification>([\s\S]*?)<\/task-notification>/g, (_, body) => {
    const status = innerTag(body, 'status') || 'done';
    const summary = innerTag(body, 'summary');
    const taskId = innerTag(body, 'task-id');
    blocks.push(`<div class="cmd-block"><span class="cmd-badge cmd-badge-task">Task ${escapeHtml(status)}</span>${summary ? `<span class="cmd-name">${highlightText(escapeHtml(summary), highlight)}</span>` : ''}${taskId ? ` <span class="cmd-args">#${escapeHtml(taskId)}</span>` : ''}</div>`);
    return '';
  });
  return { taskHtml: blocks.join(''), remaining: remaining.trim() };
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
      const { teammateHtml, remaining: afterTeammate } = renderTeammateBlocks(p.text, highlight);
      const { commandHtml, remaining: afterCmd } = renderCommandBlocks(afterTeammate, highlight);
      const { taskHtml, remaining: afterTask } = renderTaskNotifications(afterCmd, highlight);
      const { ideHtml, remaining } = renderIdeContext(afterTask);
      let html = '';
      if (teammateHtml) html += teammateHtml;
      if (commandHtml) html += commandHtml;
      if (taskHtml) html += taskHtml;
      if (ideHtml) html += ideHtml;
      if (remaining) html += `<div class="chat-msg-body">${renderJsonAware(remaining, highlight)}</div>`;
      return html;
    }
    if (p.type === 'tool_use') {
      if (p.tool === 'Agent') {
        const name = p.agentType || 'subagent';
        let modelChip;
        if (p.agentModel) {
          const family = (p.agentModel.match(/fable|mythos|opus|sonnet|haiku/) || [''])[0];
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
      const text = p.content;
      let agentInfo = '';
      if (p.agentUsage) {
        const u = p.agentUsage;
        const dur = u.durationMs > 0 ? `${(u.durationMs / 1000).toFixed(1)}s` : '';
        agentInfo = `<div class="agent-usage-bar">Agent: ${formatNum(u.totalTokens)} tokens &middot; ${u.toolUses} tool calls${dur ? ` &middot; ${dur}` : ''}</div>`;
      }
      return `${agentInfo}<div class="${cls}">${renderJsonAware(text, highlight)}</div>`;
    }
    if (p.type === 'attachment') {
      if (p.kind === 'unknown') {
        let raw = '';
        try { raw = JSON.stringify(p.raw, null, 2); } catch { raw = String(p.raw); }
        if (raw.length > 4000) raw = raw.slice(0, 4000) + '\n… (truncated)';
        const scope = p.isRecord ? 'record' : 'attachment';
        return `<details class="ctx-raw"><summary><span class="ctx-verb ctx-verb-raw">${scope}: ${escapeHtml(p.attachType)}</span></summary><pre class="cmd-stdout">${highlightText(escapeHtml(raw), highlight)}</pre></details>`;
      }
      if (p.kind === 'event') {
        let text = p.text || '';
        if (text.length > 300) text = text.slice(0, 300) + '…';
        const textHtml = text ? `<span class="ctx-path">${highlightText(escapeHtml(text), highlight)}</span>` : '';
        if (p.raw) {
          let raw = '';
          try { raw = JSON.stringify(p.raw, null, 2); } catch { raw = String(p.raw); }
          if (raw.length > 4000) raw = raw.slice(0, 4000) + '\n… (truncated)';
          return `<details class="ctx-raw"><summary><span class="ctx-verb">${escapeHtml(p.label)}</span>${textHtml}</summary><pre class="cmd-stdout">${highlightText(escapeHtml(raw), highlight)}</pre></details>`;
        }
        return `<div class="ctx-row"><span class="ctx-verb">${escapeHtml(p.label)}</span>${textHtml}</div>`;
      }
      if (p.kind === 'queued' || p.kind === 'date') {
        const verb = p.kind === 'queued' ? 'Queued' : 'Date';
        return `<div class="ctx-row"><span class="ctx-verb">${verb}</span><span class="ctx-path">${highlightText(escapeHtml(p.text), highlight)}</span></div>`;
      }
      const VERB = { file: 'Read', reference: 'Referenced file', edited: 'Edited', memory: 'Loaded memory' };
      const verb = VERB[p.kind] || 'Context';
      const lines = p.numLines != null ? `<span class="ctx-lines">(${formatNum(p.numLines)} lines)</span>` : '';
      return `<div class="ctx-row"><span class="ctx-verb">${verb}</span><span class="ctx-path">${escapeHtml(p.displayPath)}</span>${lines}</div>`;
    }
    if (p.type === 'image') {
      const src = `data:${p.mediaType};base64,${p.data}`;
      return `<div class="chat-image"><img src="${src}" alt="Attached image" /></div>`;
    }
    return '';
  }).join('');
}

function shortModel(m) {
  const match = m.match(/(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/);
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
    // A user message whose text parts are entirely teammate-message blocks is a
    // teammate reply, not your own input — relabel and left-align it.
    const teammateOnly = m.role === 'user'
      && m.parts.some(p => p.type === 'text' && /<teammate-message\b/.test(p.text))
      && m.parts.every(p => p.type !== 'text'
        || !p.text.replace(/<teammate-message\b[^>]*>[\s\S]*?<\/teammate-message>/g, '').trim());
    const isCompact = !!m.isCompactSummary;
    const isAttach = m.role === 'attachment';
    const roleClass = isCompact ? 'chat-compact' : isAttach ? 'chat-context' : teammateOnly ? 'chat-teammates' : `chat-${m.role}`;
    const roleLabel = isCompact ? 'Compacted Summary'
      : isAttach ? 'Context'
      : teammateOnly ? 'Teammates'
      : m.role === 'user' ? 'You' : m.role === 'tool' ? 'Tool Result' : 'Claude';
    const partsHtml = renderChatParts(m.parts, highlight);
    // A message whose content fully collapses to nothing (e.g. a dropped
    // command caveat) would render as an empty bubble — skip it entirely.
    if (!partsHtml.trim() && !metaHtml) return '';
    return `<div class="chat-msg ${roleClass}">
      <div class="chat-msg-header">
        <span class="chat-role">${roleLabel}</span>
        <span class="chat-time">${time}</span>
      </div>
      ${metaHtml}
      ${partsHtml}
    </div>`;
  }).join('');
}

export async function openSessionChat(folder, sessionId) {
  const messages = await window.api.getSessionChat(folder, sessionId);
  chatMessages = messages;
  chatSessionId = sessionId;
  const overlay = document.getElementById('chat-overlay');
  const body = document.getElementById('chat-body');
  const searchInput = document.getElementById('chat-search');
  const countEl = document.getElementById('chat-search-count');

  searchInput.value = '';
  countEl.textContent = '';
  searchMarks = [];
  searchIndex = -1;
  document.getElementById('btn-search-prev').classList.add('hidden');
  document.getElementById('btn-search-next').classList.add('hidden');
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

// ── Markdown export ───────────────────────────────────────────────────────────

// Fence that cannot collide with fences inside the content.
function fence(text) {
  const ticks = (text.match(/`{3,}/g) || []).reduce((m, t) => Math.max(m, t.length), 2);
  return '`'.repeat(ticks + 1);
}

function chatToMarkdown(messages) {
  const lines = [`# Session ${chatSessionId || ''}`, ''];
  for (const m of messages) {
    const time = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
    const who = m.isCompactSummary ? 'Compacted Summary'
      : m.role === 'attachment' ? 'Context'
      : m.role === 'user' ? 'You'
      : m.role === 'tool' ? 'Tool Result'
      : `Claude${m.model ? ` (${m.model})` : ''}`;
    lines.push(`### ${who}${time ? ` — ${time}` : ''}`, '');
    for (const p of m.parts) {
      if (p.type === 'text') {
        lines.push(p.text.trim(), '');
      } else if (p.type === 'tool_use') {
        const f = fence(p.input);
        lines.push(`**Tool: ${p.tool}**`, '', f, p.input, f, '');
      } else if (p.type === 'tool_result') {
        const f = fence(p.content);
        lines.push(`**Result${p.isError ? ' (error)' : ''}**`, '', f, p.content, f, '');
      } else if (p.type === 'attachment') {
        if (p.displayPath) lines.push(`> ${p.kind}: ${p.displayPath}`, '');
        else if (p.text) lines.push(`> ${p.label || p.kind}: ${p.text}`, '');
        else lines.push(`> ${p.label || p.attachType || p.kind}`, '');
      } else if (p.type === 'image') {
        lines.push('*(image attached)*', '');
      }
    }
  }
  return lines.join('\n');
}

// ── Search navigation ─────────────────────────────────────────────────────────

function updateSearchCount() {
  const countEl = document.getElementById('chat-search-count');
  const prevBtn = document.getElementById('btn-search-prev');
  const nextBtn = document.getElementById('btn-search-next');
  const hasNav = searchMarks.length > 1;
  prevBtn.classList.toggle('hidden', !hasNav);
  nextBtn.classList.toggle('hidden', !hasNav);
  if (!searchMarks.length) {
    countEl.textContent = 'No matches';
    return;
  }
  countEl.textContent = `${searchIndex + 1}/${searchMarks.length}`;
}

function gotoMatch(idx) {
  if (!searchMarks.length) return;
  // Wrap around at both ends.
  const n = searchMarks.length;
  searchIndex = ((idx % n) + n) % n;
  searchMarks.forEach((m, i) => m.classList.toggle('active', i === searchIndex));
  searchMarks[searchIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
  updateSearchCount();
}

function runChatSearch(q) {
  const body = document.getElementById('chat-body');
  const countEl = document.getElementById('chat-search-count');

  if (!q) {
    body.innerHTML = renderChatMessages(chatMessages);
    countEl.textContent = '';
    searchMarks = [];
    searchIndex = -1;
    document.getElementById('btn-search-prev').classList.add('hidden');
    document.getElementById('btn-search-next').classList.add('hidden');
    return;
  }

  body.innerHTML = renderChatMessages(chatMessages, q);
  searchMarks = Array.from(body.querySelectorAll('.chat-highlight'));
  searchIndex = -1;
  if (searchMarks.length) {
    gotoMatch(0);
  } else {
    updateSearchCount();
  }
}

export function initChatViewer() {
  document.getElementById('btn-export-chat').addEventListener('click', () => {
    if (!chatMessages.length) return;
    const name = `chat-${(chatSessionId || 'session').substring(0, 8)}.md`;
    window.api.exportFile(name, chatToMarkdown(chatMessages));
  });

  const searchInput = document.getElementById('chat-search');
  searchInput.addEventListener('input', (e) => runChatSearch(e.target.value.trim()));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    gotoMatch(searchIndex + (e.shiftKey ? -1 : 1));
  });
  document.getElementById('btn-search-prev').addEventListener('click', () => gotoMatch(searchIndex - 1));
  document.getElementById('btn-search-next').addEventListener('click', () => gotoMatch(searchIndex + 1));

  document.getElementById('btn-close-chat').addEventListener('click', () => {
    document.getElementById('chat-overlay').classList.add('hidden');
  });

  document.getElementById('image-lightbox').addEventListener('click', () => {
    document.getElementById('image-lightbox').classList.add('hidden');
  });
}
