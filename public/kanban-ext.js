/**
 * KANBAN-EXT 前端：任务板（发布 / 拖拽改状态 / 认领）
 * 数据来自 /api/kanban-todos（读写 .pi/todos/*.md）
 */
(function () {
  const BUCKETS = [
    { key: "pending", label: "待办" },
    { key: "in_progress", label: "进行中" },
    { key: "completed", label: "已完成" },
  ];
  let data = null;
  let currentProject = null;
  let pollTimer = null;
  let draggingId = null;

  const css = `
  .kex-fab{position:fixed;right:18px;bottom:18px;z-index:9999;background:#0284c7;color:#fff;border:none;border-radius:22px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)}
  .kex-fab:hover{background:#0369a1}
  .kex-drawer{position:fixed;inset:0;z-index:10000;background:rgba(3,7,18,.72);display:none}
  .kex-drawer.open{display:block}
  .kex-panel{position:absolute;inset:24px;background:var(--panel-bg,#111827);border:1px solid var(--border,#374151);border-radius:10px;display:flex;flex-direction:column;overflow:hidden}
  .kex-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border,#374151)}
  .kex-title{font-size:14px;font-weight:700}
  .kex-spacer{flex:1}
  .kex-btn{background:var(--card-bg,#1f2937);color:var(--text,#e5e7eb);border:1px solid var(--border,#374151);border-radius:5px;padding:5px 9px;font-size:12px;cursor:pointer}
  .kex-btn:hover{border-color:#0284c7}
  .kex-btn.primary{background:#0284c7;border-color:#0284c7;color:#fff}
  .kex-create{display:flex;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border,#374151);flex-wrap:wrap}
  .kex-create input,.kex-create textarea,.kex-create select{background:var(--card-bg,#1f2937);border:1px solid var(--border,#374151);border-radius:5px;color:var(--text,#e5e7eb);padding:7px;font-size:12px;font-family:inherit}
  .kex-create input{flex:1;min-width:220px}
  .kex-create textarea{width:100%;height:52px;resize:vertical}
  .kex-cols{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:12px;overflow:auto;flex:1}
  .kex-col{background:var(--card-bg,#1f2937);border:1px solid var(--border,#374151);border-radius:8px;padding:8px;min-height:120px}
  .kex-col.over{border-color:#0284c7;background:#0b3a52}
  .kex-col h4{margin:2px 4px 8px;font-size:12px;font-weight:700;color:var(--text-muted,#9ca3af)}
  .kex-card{background:var(--panel-bg,#111827);border:1px solid var(--border,#374151);border-radius:6px;padding:8px;margin-bottom:8px;cursor:grab;font-size:12px}
  .kex-card.done{opacity:.6}
  .kex-card-t{font-weight:600;margin-bottom:4px;line-height:1.35}
  .kex-meta{color:var(--text-muted,#9ca3af);font-size:11px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  .kex-tag{background:#374151;border-radius:4px;padding:1px 5px}
  .kex-own{color:#fbbf24}
  .kex-actions{margin-top:6px;display:flex;gap:6px}
  .kex-empty{color:var(--text-muted,#9ca3af);font-size:12px;padding:8px 4px}
  .kex-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:70px;z-index:10001;background:#064e3b;color:#a7f3d0;border-radius:6px;padding:8px 14px;font-size:12px;display:none}
  `;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function toast(msg, bad) {
    const t = document.getElementById("kex-toast");
    t.textContent = msg;
    t.style.background = bad ? "#7f1d1d" : "#064e3b";
    t.style.color = bad ? "#fecaca" : "#a7f3d0";
    t.style.display = "block";
    setTimeout(() => { t.style.display = "none"; }, 2000);
  }

  async function api(url, body) {
    const res = await fetch(url, body ? {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    } : undefined);
    return res.json();
  }

  async function load(keepScroll) {
    const scroller = document.querySelector(".kex-cols");
    const pos = keepScroll && scroller ? scroller.scrollTop : null;
    const out = await api("/api/kanban-todos");
    data = out;
    if (!currentProject && out.projects && out.projects.length) {
      const has = out.projects.find((p) => p.todos.length > 0);
      currentProject = (has || out.projects[0]).path;
    }
    render();
    if (pos !== null) { const s = document.querySelector(".kex-cols"); if (s) s.scrollTop = pos; }
  }

  function render() {
    if (!data) return;
    const sel = document.getElementById("kex-project");
    sel.innerHTML = "";
    for (const p of data.projects) {
      const opt = el("option", null, `${p.name}（${p.todos.length}）`);
      opt.value = p.path;
      if (p.path === currentProject) opt.selected = true;
      sel.appendChild(opt);
    }
    const project = data.projects.find((p) => p.path === currentProject) || data.projects[0];
    const counts = document.getElementById("kex-counts");
    counts.textContent = `待办 ${data.counts.pending} · 进行中 ${data.counts.in_progress} · 完成 ${data.counts.completed}`;

    const cols = document.getElementById("kex-cols");
    cols.innerHTML = "";
    for (const b of BUCKETS) {
      const col = el("div", "kex-col");
      col.dataset.bucket = b.key;
      col.appendChild(el("h4", null, `${b.label} ${project ? project.todos.filter((t) => t.bucket === b.key).length : 0}`));
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
      col.addEventListener("dragleave", () => col.classList.remove("over"));
      col.addEventListener("drop", async (e) => {
        e.preventDefault();
        col.classList.remove("over");
        if (!draggingId) return;
        const [pid, tid] = draggingId.split("::");
        draggingId = null;
        const r = await api("/api/kanban-todos/status", { project: pid, id: tid, bucket: b.key });
        if (r.ok) toast("已移动到「" + b.label + "」"); else toast(r.error || "移动失败", true);
        load();
      });

      const list = project ? project.todos.filter((t) => t.bucket === b.key) : [];
      if (!list.length) col.appendChild(el("div", "kex-empty", "空"));
      for (const t of list) {
        const card = el("div", "kex-card" + (b.key === "completed" ? " done" : ""));
        card.draggable = true;
        card.addEventListener("dragstart", () => { draggingId = `${t.project}::${t.id}`; });
        card.appendChild(el("div", "kex-card-t", t.title));
        const meta = el("div", "kex-meta");
        meta.appendChild(el("span", null, `#${t.id}`));
        for (const tag of t.tags.slice(0, 3)) meta.appendChild(el("span", "kex-tag", tag));
        if (t.assigned_to_session) meta.appendChild(el("span", "kex-own", `认领：${t.assigned_to_session}`));
        if (t.created_at) meta.appendChild(el("span", null, new Date(t.created_at).toLocaleString("zh-CN", { hour12: false })));
        card.appendChild(meta);
        if (t.body) card.appendChild(el("div", "kex-meta", t.body.split("\n")[0].slice(0, 120)));

        const acts = el("div", "kex-actions");
        if (b.key !== "completed") {
          const claimBtn = el("button", "kex-btn", t.assigned_to_session ? "释放" : "认领");
          claimBtn.onclick = async (ev) => {
            ev.stopPropagation();
            const r = await api("/api/kanban-todos/assign", { project: t.project, id: t.id, mode: t.assigned_to_session ? "release" : "claim" });
            if (r.ok) { toast(r.todo.assigned_to_session ? "已认领" : "已释放"); load(); } else toast(r.error || "失败", true);
          };
          acts.appendChild(claimBtn);
        }
        if (b.key !== "completed") {
          const doneBtn = el("button", "kex-btn", "完成");
          doneBtn.onclick = async (ev) => {
            ev.stopPropagation();
            const r = await api("/api/kanban-todos/status", { project: t.project, id: t.id, bucket: "completed" });
            if (r.ok) { toast("已完成"); load(); } else toast(r.error || "失败", true);
          };
          acts.appendChild(doneBtn);
        }
        if (b.key === "completed") {
          const reopen = el("button", "kex-btn", "重开");
          reopen.onclick = async (ev) => {
            ev.stopPropagation();
            const r = await api("/api/kanban-todos/status", { project: t.project, id: t.id, bucket: "pending" });
            if (r.ok) { toast("已重开"); load(); } else toast(r.error || "失败", true);
          };
          acts.appendChild(reopen);
        }
        card.appendChild(acts);
        col.appendChild(card);
      }
      cols.appendChild(col);
    }
  }

  function build() {
    const style = el("style");
    style.textContent = css;
    document.head.appendChild(style);

    const fab = el("button", "kex-fab", "任务板");
    fab.onclick = () => { drawer.classList.add("open"); load(); pollTimer = setInterval(() => load(true), 5000); };

    const drawer = el("div", "kex-drawer");
    const panel = el("div", "kex-panel");
    const head = el("div", "kex-head");
    head.appendChild(el("span", "kex-title", "任务板（.pi/todos）"));
    const projectSel = el("select", "kex-btn");
    projectSel.id = "kex-project";
    projectSel.onchange = () => { currentProject = projectSel.value; render(); };
    head.appendChild(projectSel);
    head.appendChild(el("span", "kex-spacer"));
    const counts = el("span", "kex-meta");
    counts.id = "kex-counts";
    head.appendChild(counts);
    const refresh = el("button", "kex-btn", "刷新");
    refresh.onclick = () => load(true);
    head.appendChild(refresh);
    const close = el("button", "kex-btn", "关闭");
    close.onclick = () => { drawer.classList.remove("open"); clearInterval(pollTimer); };
    head.appendChild(close);
    panel.appendChild(head);

    const create = el("div", "kex-create");
    const titleInput = el("input");
    titleInput.id = "kex-new-title";
    titleInput.placeholder = "新任务标题：写完回车即发布，agent 会在 /todo list-all 里看到";
    const tagInput = el("input");
    tagInput.id = "kex-new-tags";
    tagInput.placeholder = "标签（逗号分隔，可空）";
    tagInput.style.flex = "0 0 180px";
    const addBtn = el("button", "kex-btn primary", "发布任务");
    const submit = async () => {
      const title = titleInput.value.trim();
      if (!title) { toast("标题不能为空", true); return; }
      const tags = tagInput.value.split(",").map((s) => s.trim()).filter(Boolean);
      const r = await api("/api/kanban-todos/create", { project: currentProject, title, tags });
      if (r.ok) { titleInput.value = ""; tagInput.value = ""; toast("已发布 #" + r.id); load(); } else toast(r.error || "发布失败", true);
    };
    addBtn.onclick = submit;
    titleInput.onkeydown = (e) => { if (e.key === "Enter") submit(); };
    create.append(titleInput, tagInput, addBtn);
    panel.appendChild(create);

    const cols = el("div", "kex-cols");
    cols.id = "kex-cols";
    panel.appendChild(cols);

    drawer.appendChild(panel);
    const toastEl = el("div", "kex-toast");
    toastEl.id = "kex-toast";
    document.body.append(fab, drawer, toastEl);
    drawer.addEventListener("click", (e) => {
      if (e.target === drawer) { drawer.classList.remove("open"); clearInterval(pollTimer); }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
