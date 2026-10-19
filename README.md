# pi-kanban

[![npm version](https://img.shields.io/npm/v/pi-kanban.svg)](https://www.npmjs.com/package/pi-kanban)

Web dashboard for the [pi coding agent](https://pi.dev/packages/pi-kanban?name=kanban) — sessions, todos, subagents, observability.

![pi-kanban dashboard](https://raw.githubusercontent.com/NikiforovAll/pi-kanban/main/assets/pi-kanban-poster.png)

## Documentation

**[→ See the documentation](https://nikiforovall.github.io/pi-kanban/docs/)**

## Try it now

**[→ Open the live demo](https://nikiforovall.blog/pi-kanban/)**

Click around a fully interactive dashboard with synthesized sessions, tasks, and subagents — no install. Toggle the theme, browse projects, expand a subagent's review, open the storage manager. Everything works in-browser.

When you're ready to run it on your own pi sessions, install below.

## Installation

```sh
pi install npm:pi-kanban
```

Then use `/kanban start | stop | restart | status | open web|app` for global controls, and `/kanban session open | pin | sticky-pin | unpin | view-doc | link-doc` for session-scoped actions.

Or run standalone:

```sh
npx pi-kanban
```

### Companion pi extensions

pi-kanban surfaces data produced by two other pi extensions. Install them alongside for the full experience:

```sh
pi install npm:pi-subagents
pi install npm:@juicesharp/rpiv-todo
```

- [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) — spawns named subagent sessions; pi-kanban renders them under each parent session.
- [`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo) — task tracking that pi-kanban displays as kanban columns.
- [`@juicesharp/rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) — pi-kanban surfaces these as interactive Q&A cards.

## 本 fork 的差异（iranolly）

基于上游 v1.0.0，追加：

- **pi-agents-team 接入**：Agents 视图不依赖 `pi-subagents`，直接解析父会话里的 `pi-agent-team/state` 记录与 `delegate_task` 工具结果，展示 worker 的 profile、状态、任务、用量、摘要与文件改动（agents-team 不落转录文件，详情来自摘要与最终结果）。
- **任务（kanban-ext）**：主看板直接读写当前项目的 `.pi/todos/*.md`（拖拽改状态，卡片上认领 / 释放 / 完成 / 重开）。发布任务不填表，而是在看板内弹窗嵌入一次 pi-web 对话（`PI_WEB_URL`，默认 `http://127.0.0.1:30141`）：pi 先问清信息，确认后用 todo 工具写入。
- **解析回归自测**：`npm run test:team-parser`。

安装（替换 npm 版）：

```sh
pi remove npm:pi-kanban
pi install git:github.com/iranolly/pi-kanban@main
```

同步上游：

```sh
git remote add upstream https://github.com/NikiforovAll/pi-kanban.git
git fetch upstream && git merge upstream/main
```

## Demo


![pi-kanban demo](https://raw.githubusercontent.com/NikiforovAll/pi-kanban/main/assets/pi-kanban-demo.gif)
