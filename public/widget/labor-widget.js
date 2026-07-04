/*
 * labor.fun web chat widget — self-contained, no build step, no framework, no
 * external dependencies. Drop it on any page with one <script> tag:
 *
 *   <script src=".../widget/labor-widget.js"
 *           data-site-key="YOUR_SITE_KEY"
 *           data-endpoint="https://your-host.example.com:3100"></script>
 *
 * SECURITY: all visitor input and all assistant replies are rendered with
 * textContent (never innerHTML), so untrusted text can never inject markup.
 */
(function () {
  'use strict';

  // Capture the script element NOW — document.currentScript is null once this
  // function returns / inside any later callback.
  var script = document.currentScript;
  if (!script) {
    return;
  }
  var SITE_KEY = script.getAttribute('data-site-key') || '';
  var ENDPOINT = (script.getAttribute('data-endpoint') || '').replace(
    /\/+$/,
    '',
  );
  var SESSION_STORAGE_KEY = 'labor_widget_session';

  if (!ENDPOINT) {
    console.warn('[labor-widget] missing data-endpoint; widget disabled');
    return;
  }

  // The session id is server-authoritative. We do NOT send a client-generated
  // id on the very first message — we let the server mint one and return it,
  // then persist THAT. On subsequent messages we send the persisted id.
  var sessionId = null;
  try {
    sessionId = window.localStorage.getItem(SESSION_STORAGE_KEY) || null;
  } catch (e) {
    sessionId = null;
  }

  var eventSource = null;
  var els = {};

  // --- styles (injected once) ---
  function injectStyles() {
    var css = [
      '.labor-widget-bubble{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;background:#1f2937;color:#fff;border:none;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.25);font-size:24px;z-index:2147483000;display:flex;align-items:center;justify-content:center}',
      '.labor-widget-panel{position:fixed;bottom:88px;right:20px;width:340px;max-width:calc(100vw - 40px);height:460px;max-height:calc(100vh - 120px);background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
      '.labor-widget-panel.open{display:flex}',
      '.labor-widget-header{background:#1f2937;color:#fff;padding:12px 16px;font-weight:600;font-size:15px}',
      '.labor-widget-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f9fafb}',
      '.labor-widget-msg{max-width:80%;padding:8px 12px;border-radius:12px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}',
      '.labor-widget-msg.user{align-self:flex-end;background:#2563eb;color:#fff;border-bottom-right-radius:4px}',
      '.labor-widget-msg.bot{align-self:flex-start;background:#e5e7eb;color:#111827;border-bottom-left-radius:4px}',
      '.labor-widget-msg.error{align-self:center;background:transparent;color:#b91c1c;font-size:12px}',
      '.labor-widget-input-row{display:flex;border-top:1px solid #e5e7eb;padding:8px;gap:8px;background:#fff}',
      '.labor-widget-input{flex:1;border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font-size:14px;outline:none;resize:none}',
      '.labor-widget-send{background:#2563eb;color:#fff;border:none;border-radius:8px;padding:0 14px;cursor:pointer;font-size:14px}',
      '.labor-widget-send:disabled{opacity:.5;cursor:default}',
    ].join('\n');
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // --- DOM construction (no innerHTML with dynamic data anywhere) ---
  function buildUI() {
    var bubble = document.createElement('button');
    bubble.className = 'labor-widget-bubble';
    bubble.setAttribute('aria-label', 'Open chat');
    bubble.textContent = '💬'; // speech balloon emoji

    var panel = document.createElement('div');
    panel.className = 'labor-widget-panel';

    var header = document.createElement('div');
    header.className = 'labor-widget-header';
    header.textContent = 'Chat with us';

    var messages = document.createElement('div');
    messages.className = 'labor-widget-messages';

    var inputRow = document.createElement('div');
    inputRow.className = 'labor-widget-input-row';

    var input = document.createElement('textarea');
    input.className = 'labor-widget-input';
    input.rows = 1;
    input.placeholder = 'Type a message...';

    var send = document.createElement('button');
    send.className = 'labor-widget-send';
    send.textContent = 'Send';

    inputRow.appendChild(input);
    inputRow.appendChild(send);
    panel.appendChild(header);
    panel.appendChild(messages);
    panel.appendChild(inputRow);
    document.body.appendChild(bubble);
    document.body.appendChild(panel);

    els = {
      bubble: bubble,
      panel: panel,
      messages: messages,
      input: input,
      send: send,
    };

    bubble.addEventListener('click', function () {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        input.focus();
      }
    });
    send.addEventListener('click', sendMessage);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  // --- rendering (textContent only) ---
  function appendMessage(text, kind) {
    var div = document.createElement('div');
    div.className = 'labor-widget-msg ' + kind;
    div.textContent = text; // never innerHTML — safe against injection
    els.messages.appendChild(div);
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function appendError(text) {
    appendMessage(text, 'error');
  }

  // --- networking ---
  function openStream() {
    if (!sessionId || eventSource) {
      return;
    }
    try {
      // EventSource cannot set request headers, so the site key travels as a
      // query param on the stream URL (the server accepts it there for the GET
      // stream). The site key is a shared PUBLIC widget key, not a per-user
      // secret, so this is acceptable — it's the same value already embedded in
      // this script's data-site-key attribute.
      eventSource = new EventSource(
        ENDPOINT +
          '/api/stream?sessionId=' +
          encodeURIComponent(sessionId) +
          '&siteKey=' +
          encodeURIComponent(SITE_KEY),
        { withCredentials: false },
      );
      eventSource.onmessage = function (evt) {
        var data;
        try {
          data = JSON.parse(evt.data);
        } catch (e) {
          return;
        }
        if (data && data.type === 'message' && typeof data.text === 'string') {
          appendMessage(data.text, 'bot');
        }
      };
      eventSource.onerror = function () {
        // Browser auto-reconnects EventSource; nothing to do.
      };
    } catch (e) {
      // EventSource unsupported or blocked — messages still send, replies just
      // won't stream in. Non-fatal.
      eventSource = null;
    }
  }

  function setBusy(busy) {
    els.send.disabled = busy;
  }

  function sendMessage() {
    var text = els.input.value.trim();
    if (!text) {
      return;
    }
    els.input.value = '';
    appendMessage(text, 'user');
    setBusy(true);

    var payload = { text: text };
    // Only send sessionId once the server has minted one for us.
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    fetch(ENDPOINT + '/api/message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Site-Key': SITE_KEY,
      },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        if (!res.ok) {
          var msg = 'Message failed.';
          if (res.status === 401 || res.status === 403) {
            msg = 'Chat unavailable (auth).';
          } else if (res.status === 429) {
            msg = 'Slow down — too many messages.';
          } else if (res.status === 400 || res.status === 413) {
            msg = 'Message rejected.';
          }
          appendError(msg);
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) {
          return;
        }
        // Adopt the server's session id (source of truth) and persist it.
        if (data.sessionId && data.sessionId !== sessionId) {
          sessionId = data.sessionId;
          try {
            window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
          } catch (e) {
            /* storage unavailable — session stays in memory only */
          }
        }
        openStream();
      })
      .catch(function () {
        appendError('Network error.');
      })
      .then(function () {
        setBusy(false);
      });
  }

  // --- boot ---
  function init() {
    injectStyles();
    buildUI();
    // If we already have a persisted session, open the stream eagerly so
    // proactive/agent-initiated replies can arrive before the first message.
    if (sessionId) {
      openStream();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
