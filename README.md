# Jira App: my personal Jira tracker

A dark-mode desktop app for tracking **my own** Jira work (`https://axismaxlife.atlassian.net`). Clicking **Jira App** on the Desktop opens only the **floating side widget**. It does not start with Windows (you can turn that on in the tray menu).

## 📱 Side widget (opens on click)
- A phone-style glass card that floats on top. Drag its header or footer to place it **anywhere on your screen** (it automatically clamps within your display boundaries so it never cuts off or goes off-screen).
- **Ring:** a colour ring with the number of pending tasks: overdue = red, due soon = amber, focus = gold, in progress = blue, to do = indigo. Tap a stat to filter.
- **Timer and follow-ups:** a live timer bar (■ stops it) and the next follow-up (✓ done, +1h snooze).
- **Task groups:** tasks are grouped ⚠ Overdue → 📅 Due soon → 🎯 Focus → 🚀 In progress → 🗂 To do, with tabs All / Urgent / Focus / Doing / To do.
- **Each task card:** a glowing accent colour, due chip, priority, your #tags, checklist progress, and quick actions: change status, ☆ focus, ▶ timer, ↗ open.
- **Buttons:**
  - **›** collapses the widget into a slim edge tab with the pending count. A red **!** shows when something is overdue.
  - **⤢** opens the full app.
  - **✕** hides it to the tray.
- **Ctrl+Shift+J** shows or hides the widget. Click the tray icon for the widget, double-click it for the full app.
- **First launch:** the widget connects automatically using the Jira login Kiro already has (`~/.kiro/settings/mcp.json`), so there's no e-mail or token to type. Windows environment variables `JIRA_EMAIL`/`JIRA_USERNAME` + `JIRA_API_TOKEN` also work. A one-time "Connect your Jira" card appears only if neither is found.

## 🏠 Tracker (home page)
- **Colour-coded tiles:** Open, In progress, To do, ⚠ Overdue, 📅 Due this week, 💤 No update for 7+ days, 🔥 High priority, ✅ Done this week. Click a tile to filter the list.
- **🎯 Today's focus:** click ☆ on any issue to plan your day. Reorder with ↑ ↓, or add an issue by typing its key.
- **⏰ Follow-ups:** your personal reminders, with +1h, +1d and ✓ done buttons. When a reminder is due, a banner appears at the top and Windows shows a notification.
- **⏱ My time this week:** a chart by day. Time you haven't logged yet can be sent to the Jira work log with one click.
- **📊 My workload:** charts by status and by priority.
- **My open issues:** filter by text or by your own **#tags**.

## ★ Mine tab (on every issue)
- **Today's focus:** add or remove the issue.
- **Timer:** ▶ start / ■ stop. When you stop, choose **Stop & log to Jira** (it creates a work log) or **keep private**.
- **Personal tags:** #follow-up, #waiting, #blocked, #review, #urgent, #idea, or your own.
- **Checklist:** with a progress bar.
- **Follow-up reminder:** quick +1 hour / tomorrow / next week buttons.
- **Private notes:** saved automatically.

All personal data stays on this laptop in `%APPDATA%\jira-app\personal.json`. Nothing goes to Jira unless you choose to log work.

## Colours and highlights
- **Status:** to do = indigo, in progress = blue, review/QA = purple, blocked/on hold = red, done = green.
- **Priority:** each row and card has a coloured left edge (red, orange, yellow, cyan or grey).
- **Overdue:** red. **Due today:** amber. **Due soon:** yellow. **No update for a week:** pink 💤.
- **Focus items:** glow gold on the board. A running timer pulses red.
- **Theme:** the ☀/🌙 button switches dark and light.

## Other screens
- **Lists:** assigned, reported, watching, done recently, viewed.
- **Board:** drag a card to change its status (allowed columns light up). Keyboard: `M` to move a card.
- **Filters:** JQL search, saved searches, CSV export.
- **Create:** creates a Jira issue.

Click any issue to open it in a side panel. Click its status to move it.

**Keyboard shortcuts:** `/` search · `h` tracker · `w` lists · `b` board · `f` filters · `c` create · `Esc` closes the panel.

## Floating window
- **📌** keeps the window on top. **⤡/⤢** switches between the compact widget and the full window.
- **Ctrl+Shift+J** shows or hides it. **✕** hides it to the system tray. Quit from the tray menu.
- **Tray menu:** compact widget, always on top, transparency, notifications, start with Windows (off), settings.

## Setup (Zero-config for colleagues)
1. **Download & Run**: Run `npm start` (or double-click `start-jira-app.cmd`).
2. **Automatic Connection**:
   - If you already use **Kiro** (with Jira MCP), the app connects **instantly with 0 setup**!
   - Or if you have `JIRA_API_TOKEN` / `JIRA_EMAIL` in environment variables, it auto-connects.
   - If first time: the browser opens a clean setup screen with your company site (`https://axismaxlife.atlassian.net`) and email pre-filled. Just paste your [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens) and click **Connect & save** — no config files to edit!

## 🤖 Kiro CLI Integration
- Open any ticket and click **🤖 Kiro Summary** (in the issue action header) or **🤖 Post to Kiro CLI** (in the **Analysis** tab).
- It generates a structured analysis (objective, acceptance criteria, business rules, open questions, test scenarios) and sends it directly to your Kiro CLI (`kiro ask`).
- If Kiro CLI isn't installed in your terminal PATH, it copies the summary to your clipboard with command guidance.

## Commands
| Task | Command |
|---|---|
| Run the desktop app | `npm run desktop` |
| Try it with sample data (no token needed) | `npm run desktop:mock` |
| Re-create Desktop/Start Menu shortcuts | `powershell -ExecutionPolicy Bypass -File install-desktop.ps1` |
| Re-download Electron (if `npm install` can't reach GitHub) | `powershell -ExecutionPolicy Bypass -File fetch-electron.ps1` |
| Browser mode (http://127.0.0.1:4777/) | `start-jira-app.cmd` |
| Development server (port 4787) | `npm run dev` |
| Test the Jira connection | `node server.js --check` |
| Run tests | `npm test` |

## Security notes
- **Local server:** it listens only on `127.0.0.1`. It blocks requests from other websites using Host/Origin checks and a custom request header. Attachment links use a random per-session token.
- **Desktop window:** it is sandboxed with context isolation and has no Node.js access. External links open in your browser.
- **Content:** Jira HTML is sanitised before it's shown, and a strict Content-Security-Policy is applied.
- **Token:** it never reaches the web page and is never logged. Revoke it at id.atlassian.com if the laptop is lost.
