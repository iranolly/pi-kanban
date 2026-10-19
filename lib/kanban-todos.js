/**
 * KANBAN-EXT：把 pi-agent-extensions 的 .pi/todos（含 claim 认领）接进 pi-kanban。
 *
 * 为什么要这层：pi-kanban 原本只认 rpiv-todo 的 details.tasks，而认领机制在
 * pi-agent-extensions 的 todos 里（.pi/todos/*.md + assigned_to_session + 锁）。
 * 本模块直接读写那批 markdown，提供：
 *   GET  /api/kanban-todos              列出所有项目的任务
 *   GET  /api/kanban-todos/for-session  当前会话所属项目的任务（供中心看板）
 *   POST /api/kanban-todos/status       改状态（拖拽落库）
 *   POST /api/kanban-todos/assign       认领 / 释放
 *   POST /api/kanban-todos/ask-pi       开一次 pi-web 对话来整理并发布任务
 * 顺带把任务镜像进 kanban 自己的任务库（伪会话 "todos"），让原生视图也能看到。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const chokidar = require("chokidar");

const CLOSED = new Set(["closed", "done"]);
const IN_PROGRESS = new Set(["in_progress", "doing", "wip", "active"]);
const MIRROR_SESSION = "todos"; // 伪会话 id：镜像进 kanban 任务库时用

function todosDirFor(root) {
  const custom = process.env.PI_TODO_PATH;
  if (custom && path.resolve(custom).startsWith(path.resolve(root))) return path.resolve(custom);
  return path.join(root, ".pi", "todos");
}

/** 拆出文件开头的 JSON front matter（一行 "{" ... 一行 "}"）和正文 */
function splitFrontMatter(content) {
  const text = content.replace(/^\uFEFF/, "");
  if (!text.trimStart().startsWith("{")) return { frontMatter: null, body: text };
  const lines = text.split(/\r?\n/);
  let depth = 0;
  let end = -1;
  for (let i = 0; i < lines.length; i += 1) {
    depth += (lines[i].match(/{/g) || []).length - (lines[i].match(/}/g) || []).length;
    if (depth <= 0) { end = i; break; }
  }
  if (end === -1) return { frontMatter: null, body: text };
  return {
    frontMatter: lines.slice(0, end + 1).join("\n"),
    body: lines.slice(end + 1).join("\n").replace(/^\s*\n/, ""),
  };
}

function parseTodoFile(filePath, id) {
  const raw = fs.readFileSync(filePath, "utf8");
  const { frontMatter, body } = splitFrontMatter(raw);
  let fm = {};
  if (frontMatter) { try { fm = JSON.parse(frontMatter); } catch { fm = {}; } }
  return {
    id,
    title: typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : `(未命名 ${id})`,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    status: typeof fm.status === "string" && fm.status.trim() ? fm.status.trim() : "open",
    created_at: typeof fm.created_at === "string" ? fm.created_at : null,
    assigned_to_session: typeof fm.assigned_to_session === "string" ? fm.assigned_to_session : null,
    body: body.replace(/\s+$/, ""),
  };
}

function serializeTodo(todo) {
  const fm = JSON.stringify({
    id: todo.id,
    title: todo.title,
    tags: todo.tags || [],
    status: todo.status,
    created_at: todo.created_at,
    assigned_to_session: todo.assigned_to_session || undefined,
  }, null, 2);
  const body = (todo.body || "").replace(/^\n+/, "").replace(/\s+$/, "");
  return body ? `${fm}\n\n${body}\n` : `${fm}\n`;
}

function writeTodo(dir, todo) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${todo.id}.md`);
  fs.writeFileSync(file, serializeTodo(todo), { encoding: "utf8", mode: 0o600 });
  return file;
}

function readDirTodos(dir, projectPath) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const id = name.slice(0, -3);
    try {
      const todo = parseTodoFile(path.join(dir, name), id);
      out.push({ ...todo, project: projectPath, dir });
    } catch { /* 读不到就跳过 */ }
  }
  return out;
}

function bucketOf(todo) {
  const status = String(todo.status || "open").toLowerCase();
  if (CLOSED.has(status)) return "completed";
  if (todo.assigned_to_session || IN_PROGRESS.has(status)) return "in_progress";
  return "pending";
}

/** 项目根目录候选：已登录会话的 cwd + 显式配置 */
async function listProjectRoots(serverDir) {
  const roots = new Set();
  for (const key of ["PI_KANBAN_PROJECTS", "PI_TODO_ROOTS"]) {
    const raw = process.env[key];
    if (raw) for (const p of raw.split(path.delimiter)) if (p.trim()) roots.add(path.resolve(p.trim()));
  }
  try {
    const parsers = require("./pi-parsers.js");
    const sessions = await parsers.listSessions();
    for (const s of sessions) if (s && typeof s.cwd === "string" && s.cwd) roots.add(path.resolve(s.cwd));
  } catch { /* 解析器不可用就用显式配置 */ }
  if (process.env.PI_TODO_PATH) {
    const d = path.resolve(process.env.PI_TODO_PATH);
    roots.add(path.dirname(path.dirname(d))); // <root>/.pi/todos -> <root>
  }
  if (roots.size === 0) roots.add(process.cwd());
  const existing = [...roots].filter((r) => {
    try { return fs.existsSync(todosDirFor(r)); } catch { return false; }
  });
  return existing.length ? existing : [...roots];
}

function findTodo(project, id) {
  const dir = todosDirFor(project);
  const file = path.join(dir, `${id}.md`);
  if (!fs.existsSync(file)) return null;
  return { todo: parseTodoFile(file, id), dir, file };
}

/** 镜像到 kanban 原生任务库：~/.pi/agent/kanban/tasks/<伪会话>/<id>.json */
function mirrorToKanbanStore(todos) {
  const store = path.join(os.homedir(), ".pi", "agent", "kanban", "tasks", MIRROR_SESSION);
  try {
    fs.mkdirSync(store, { recursive: true });
    const keep = new Set();
    for (const t of todos) {
      const id = `${t.project.replace(/[^a-zA-Z0-9]+/g, "_")}_${t.id}`;
      keep.add(`${id}.json`);
      const payload = {
        id,
        subject: `[${path.basename(t.project)}] ${t.title}`,
        description: t.assigned_to_session ? `认领：${t.assigned_to_session}` : (t.body ? t.body.split("\n")[0] : null),
        activeForm: null,
        status: bucketOf(t),
        blocks: [],
        blockedBy: [],
      };
      fs.writeFileSync(path.join(store, `${id}.json`), JSON.stringify(payload, null, 2));
    }
    for (const name of fs.readdirSync(store)) {
      if (name.endsWith(".json") && !keep.has(name)) { try { fs.unlinkSync(path.join(store, name)); } catch {} }
    }
  } catch { /* 镜像失败不影响主流程 */ }
}

function install(app, hooks = {}) {
  const serverDir = __dirname;

  // 监听各项目的 .pi/todos 目录，文件变化时通知前端刷新中心看板。
  const watchedDirs = new Set();
  const pendingProjects = new Set();
  let todosWatcher = null;
  let flushTimer = null;

  function projectRootFor(file) {
    // <root>/.pi/todos/<id>.md -> <root>
    return path.dirname(path.dirname(path.dirname(file)));
  }

  function scheduleBroadcast(project) {
    if (!hooks.broadcast) return;
    pendingProjects.add(project);
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const batch = [...pendingProjects];
      pendingProjects.clear();
      for (const p of batch) {
        try { hooks.broadcast({ type: "todos:update", project: p }); } catch { /* ignore */ }
      }
    }, 150);
  }

  function watchTodosDir(dir) {
    if (!hooks.broadcast) return;
    if (!todosWatcher) {
      todosWatcher = chokidar.watch([], { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 } });
      for (const ev of ["add", "change", "unlink"]) {
        todosWatcher.on(ev, (file) => {
          if (String(file).endsWith(".md")) scheduleBroadcast(projectRootFor(file));
        });
      }
    }
    const key = path.resolve(dir);
    if (!watchedDirs.has(key)) {
      watchedDirs.add(key);
      todosWatcher.add(key);
    }
  }

  const PI_WEB_URL = (process.env.PI_WEB_URL || "http://127.0.0.1:30141").replace(/\/+$/, "");

  function buildAskPiMessage(project) {
    const name = path.basename(project);
    return [
      `我要发布一个新任务到当前项目（${name}）的 .pi/todos 任务板。`,
      "请先向我提问，把任务信息整理清楚：任务标题、背景与目标、验收标准、标签、是否需要我认领（claim）。",
      "不要在我确认之前创建任务；信息确认后再用 todo 工具 create 发布，并告诉我任务编号和标题。",
    ].join("\n");
  }

  app.get("/api/kanban-todos", async (req, res) => {
    try {
      const roots = await listProjectRoots(serverDir);
      const projects = [];
      const all = [];
      for (const root of roots) {
        const dir = todosDirFor(root);
        watchTodosDir(dir);
        const todos = readDirTodos(dir, root);
        for (const t of todos) all.push(t);
        projects.push({
          path: root,
          name: path.basename(root),
          todos: todos.map((t) => ({ ...t, bucket: bucketOf(t) })),
        });
      }
      mirrorToKanbanStore(all);
      const counts = { pending: 0, in_progress: 0, completed: 0 };
      for (const t of all) counts[bucketOf(t)] += 1;
      res.json({ ok: true, counts, total: all.length, projects, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  app.get("/api/kanban-todos/for-session", async (req, res) => {
    try {
      const id = String(req.query.id || "");
      if (!id) return res.status(400).json({ ok: false, error: "id required" });
      const parsers = require("./pi-parsers.js");
      const meta = await parsers.findSessionFileById(id);
      if (!meta) return res.status(404).json({ ok: false, error: "session not found" });
      // meta.cwd is decoded from the folder name and loses dashes; the summary has the real cwd.
      let cwd = meta.cwd;
      try {
        const summary = await parsers.buildSessionSummary(meta);
        if (summary && typeof summary.cwd === "string" && summary.cwd) cwd = summary.cwd;
      } catch { /* fall back to meta.cwd */ }
      const root = path.resolve(cwd || "");
      if (!root) return res.status(400).json({ ok: false, error: "session has no cwd" });
      const dir = todosDirFor(root);
      watchTodosDir(dir);
      const todos = readDirTodos(dir, root).map((t) => ({ ...t, bucket: bucketOf(t) }));
      res.json({ ok: true, project: root, todos });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  // 发布不再由用户直接写文件，而是开一次 pi-web 对话：由 pi 整理信息后用 todo 工具发布。
  // 接收 project 绝对路径，或 sessionId（由服务端解析该会话的 cwd）。
  app.post("/api/kanban-todos/ask-pi", async (req, res) => {
    try {
      let project = String((req.body && req.body.project) || "").trim();
      const sessionId = String((req.body && req.body.sessionId) || "").trim();
      if (!project && sessionId) {
        const parsers = require("./pi-parsers.js");
        const meta = await parsers.findSessionFileById(sessionId);
        if (!meta) return res.status(404).json({ ok: false, error: "session not found" });
        try {
          const summary = await parsers.buildSessionSummary(meta);
          if (summary && summary.cwd) project = summary.cwd;
        } catch { /* fall back to meta.cwd */ }
        if (!project) project = meta.cwd || "";
      }
      if (!project || !fs.existsSync(project)) {
        return res.status(400).json({ ok: false, error: "缺少有效的项目路径" });
      }
      const response = await fetch(`${PI_WEB_URL}/api/agent/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: project, type: "prompt", message: buildAskPiMessage(project) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.sessionId) {
        return res.status(502).json({ ok: false, error: data.error || `pi-web HTTP ${response.status}` });
      }
      res.json({
        ok: true,
        sessionId: data.sessionId,
        url: `${PI_WEB_URL}/?session=${encodeURIComponent(data.sessionId)}`,
      });
    } catch (err) {
      res.status(502).json({ ok: false, error: `pi-web 不可用：${err && err.message ? err.message : err}` });
    }
  });

  app.post("/api/kanban-todos/create", (req, res) => {
    try {
      const { project, title, body, tags } = req.body || {};
      if (!project || !title || !String(title).trim()) {
        return res.status(400).json({ ok: false, error: "project 和 title 必填" });
      }
      const dir = todosDirFor(project);
      fs.mkdirSync(dir, { recursive: true });
      const id = crypto.randomBytes(4).toString("hex");
      const todo = {
        id,
        title: String(title).trim().slice(0, 200),
        tags: Array.isArray(tags) ? tags.map(String) : [],
        status: "open",
        created_at: new Date().toISOString(),
        assigned_to_session: null,
        body: typeof body === "string" ? body : "",
      };
      writeTodo(dir, todo);
      res.json({ ok: true, id, todo: { ...todo, project, bucket: bucketOf(todo) } });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  app.post("/api/kanban-todos/status", (req, res) => {
    try {
      const { project, id, bucket } = req.body || {};
      const found = findTodo(project, String(id || ""));
      if (!found) return res.status(404).json({ ok: false, error: "任务不存在" });
      const todo = found.todo;
      if (bucket === "pending") { todo.status = "open"; todo.assigned_to_session = null; }
      else if (bucket === "in_progress") { todo.status = "in_progress"; }
      else if (bucket === "completed") { todo.status = "closed"; }
      else return res.status(400).json({ ok: false, error: "bucket 只能是 pending / in_progress / completed" });
      writeTodo(found.dir, todo);
      res.json({ ok: true, todo: { ...todo, project, bucket: bucketOf(todo) } });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  app.post("/api/kanban-todos/assign", (req, res) => {
    try {
      const { project, id, mode } = req.body || {};
      const found = findTodo(project, String(id || ""));
      if (!found) return res.status(404).json({ ok: false, error: "任务不存在" });
      const todo = found.todo;
      if (mode === "release") {
        todo.assigned_to_session = null;
        if (String(todo.status).toLowerCase() === "in_progress") todo.status = "open";
      } else {
        todo.assigned_to_session = `web@${os.hostname()}`;
        if (String(todo.status).toLowerCase() === "open") todo.status = "in_progress";
      }
      writeTodo(found.dir, todo);
      res.json({ ok: true, todo: { ...todo, project, bucket: bucketOf(todo) } });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
}

module.exports = { install, todosDirFor, bucketOf };
