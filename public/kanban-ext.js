/**
 * KANBAN-EXT 前端：任务对话窗
 * 顶栏按钮 → 弹窗内嵌 pi-web 会话；pi 先帮你整理任务信息，确认后用 todo 工具写入 .pi/todos。
 * 看板本身的读写（当前项目 .pi/todos：拖拽改状态、认领/完成）由 app.js 渲染。
 */
(function () {
  const css = `
  .kex-open svg{width:16px;height:16px}
  .kex-modal{position:fixed;inset:0;z-index:10000;background:rgba(3,7,18,.72);display:none}
  .kex-modal.open{display:flex;align-items:center;justify-content:center}
  .kex-modal-panel{width:min(1320px,95vw);height:min(880px,93vh);background:var(--bg-surface,#16181c);border:1px solid var(--border,#363840);border-radius:10px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .kex-modal-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border,#363840)}
  .kex-title{font-size:14px;font-weight:700;color:var(--text-primary,#f0f1f3)}
  .kex-hint{color:var(--text-muted,#7d808a);font-size:12px}
  .kex-spacer{flex:1}
  .kex-btn{background:var(--bg-elevated,#1e2025);color:var(--text-secondary,#c2c4c9);border:1px solid var(--border,#363840);border-radius:5px;padding:5px 10px;font-size:12px;cursor:pointer}
  .kex-btn:hover{border-color:var(--accent,#e86f33);color:var(--text-primary,#f0f1f3)}
  .kex-status{padding:6px 14px;color:var(--text-muted,#7d808a);font-size:12px;border-bottom:1px solid var(--border,#363840);display:none}
  .kex-status.visible{display:block}
  .kex-frame{flex:1;border:0;background:#fff}
  `;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  const modal = el("div", "kex-modal");
  const panel = el("div", "kex-modal-panel");
  const head = el("div", "kex-modal-head");
  head.appendChild(el("span", "kex-title", "发布任务：和 pi 对话"));
  head.appendChild(el("span", "kex-hint", "pi 先问清标题 / 背景 / 验收 / 标签 / 认领，确认后写入 .pi/todos"));
  head.appendChild(el("span", "kex-spacer"));
  const closeBtn = el("button", "kex-btn", "关闭");
  head.appendChild(closeBtn);
  panel.appendChild(head);

  const status = el("div", "kex-status");
  panel.appendChild(status);

  const frame = el("iframe", "kex-frame");
  frame.title = "pi-web 对话";
  panel.appendChild(frame);
  modal.appendChild(panel);

  function setStatus(text) {
    if (text) {
      status.textContent = text;
      status.classList.add("visible");
    } else {
      status.textContent = "";
      status.classList.remove("visible");
    }
  }

  let creating = false;
  async function openChat() {
    modal.classList.add("open");
    if (creating) return;
    if (frame.src && frame.src !== "about:blank") return; // keep the in-progress conversation
    creating = true;
    setStatus("正在创建 pi 对话…");
    try {
      const sid = new URLSearchParams(window.location.search).get("session");
      const res = await fetch("/api/kanban-todos/ask-pi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sid ? { sessionId: sid } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.url) throw new Error(data.error || `HTTP ${res.status}`);
      frame.src = data.url;
      setStatus("");
    } catch (err) {
      setStatus(`创建对话失败：${err && err.message ? err.message : err}（需要 pi-web 在运行）`);
    } finally {
      creating = false;
    }
  }

  function closeChat() {
    modal.classList.remove("open");
    frame.src = "about:blank"; // 停掉 iframe 里的流；下次打开重新开一个对话
    setStatus("");
  }

  function buildOpener() {
    const btn = el("button", "icon-btn kex-open");
    btn.id = "kex-open";
    btn.title = "和 pi 对话发布任务";
    btn.setAttribute("aria-label", "和 pi 对话发布任务");
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6M9 10h6"/></svg>';
    const actions = document.querySelector("#session-view .view-actions");
    if (actions) {
      const anchor = actions.querySelector("#message-toggle");
      actions.insertBefore(btn, anchor || actions.firstChild);
    } else {
      document.body.appendChild(btn);
    }
    return btn;
  }

  function build() {
    const style = el("style");
    style.textContent = css;
    document.head.appendChild(style);

    buildOpener().onclick = openChat;
    closeBtn.onclick = closeChat;
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeChat();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("open")) closeChat();
    });
    document.body.appendChild(modal);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
