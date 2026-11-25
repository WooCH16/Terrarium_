# Terrarium

[한국어](README.md)

Terrarium is a personal harness that splits work across layered Claude Code agents. You talk to one agent only: the coordinator.

| Role | What it does | Runs as |
|---|---|---|
| Coordinator | Talks with you, clarifies the request, splits work into GitHub issues, hands them off, checks results against the completion criteria, and reports back | A Claude Code session (the run folder's `CLAUDE.md`) |
| Advisor | Reads the target project and writes a proposal for how to split the work. Advises only | A subagent of the coordinator |
| Operator | Takes issues, hands them to workers, merges results, writes the result report | A separate Claude Code session |
| Worker | Does the actual change, one git worktree per task | Pi (claude, gemini, or muse models) |
| Reviewer | Allows or rejects proposals and result reports. Also routes each issue to a worker model, type, and difficulty | Jev (TypeSafe System One API). Jev judges; the scripts decide |

Results flow upward: operator report → reviewer verdict → coordinator check against the criteria → report to you. The target project's `main` changes only after you decide to apply the results. If the target project has a GitHub remote and the harness workflows, its GitHub Actions run the issue PRs, handoff PRs, CI, and the merge train (the harness only pushes branches and reads the results, and starts the train only after you approve); without a remote the harness keeps the local flow (`run-reflect`) (decision 8-32, [docs/adr/workflow.md](docs/adr/workflow.md), Korean). See [docs/00-definition.md](docs/00-definition.md) (Korean) for the full definition.

## Scope (v0)

- **The protocol is Korean.** Role documents, issue templates, and verdict comments are in Korean, and the scripts parse that text (`harness/operator/protocol.mjs`). The coordinator answers in Korean.
- **Tested on Windows only.** Other operating systems are untested.
- **Accounts you need:** GitHub (`gh` logged in, a private designated repository), Claude Code (logged in), at least one worker model provider (for example Pi's Anthropic login or a Gemini API key), and a TypeSafe Jev key (`TYPESAFE_API_KEY`).
- Read the [known limitations](docs/known-limitations.md) (Korean) first. Workers have no OS sandbox, and anyone using the same `gh` account can forge a verdict.

## What you need first: a private designated repository

To use this harness, **each user needs their own private GitHub repository (the designated repository).** The harness does not run without it.

- **What it holds:** work issues, advisor proposals, reviewer verdicts, operator result reports, and record documents (`records/`).
- **Why it must be private:** your instructions and the target project's content pile up there as written. If the repository is public, `setup`, `preflight`, and the coordinator stop and write nothing.
- **One user only:** several people do not share one repository.
- **You do not need to create it:** when setup runs without `--repo`, it creates `<your login>/harness-issues-<target project folder name>` as a private repository and prints the name. The second project works the same way. Reinstalling the same folder reuses its repository; an existing public repository is left unchanged and setup stops.
- **To choose the name yourself:** pass `--repo <owner/name>` (add `--create-repo` if it does not exist). The app's install screen currently asks for a repository name and asks before creating a missing one.

## Two ways to use it: the app and the Claude CLI

There are two ways to use the harness. Either way, the coordinator is the same interactive Claude Code session running in a run folder. It uses the same rules (`CLAUDE.md`) and the same hooks, so it does the same work. Only the window and the setup steps differ.

| | App | Claude CLI |
|---|---|---|
| Where you talk to the coordinator | The coordinator window in the middle of the app's control-tower screen | `claude` started in your own terminal |
| Preflight check, run folder setup | The gear at the tower's top right → [설정 열기] (Open settings) | Run `preflight.mjs` and `setup.mjs` yourself |
| API keys (`TYPESAFE_API_KEY`, `GEMINI_API_KEY`) | Kept in this computer's encrypted storage and passed to the coordinator as environment variables | `.env` at the repository root |
| Checking progress | [설정 > 진행 기록] (issues, handoffs, verdicts; read-only) | GitHub issues and the record files in the run folder |
| Good for | Installing and using it without a terminal | Changing or testing the harness, or not installing the app |

Both need Node 22 or later, git, [GitHub CLI](https://cli.github.com/) (`gh auth login`), [Claude Code](https://claude.com/claude-code) (logged in), and Pi (`npm install -g @earendil-works/pi-coding-agent`, then `pi auth login anthropic`, and `pi auth login meta` for the muse worker). The designated repository must be private.

You can open the same run folder from either one. To open a run folder made in the terminal, use **다른 폴더 열기…** (Open another folder) in the run folder button at the tower's top left (or **열기…** at the top of the settings window). Do not run two coordinators on one run folder at once: opening it in the app and the terminal together makes handoffs collide.

### 1. App

`app/` holds a Windows desktop app (ADR 0010, 0011, 0013). The main window is the control-tower screen (`app/tower/`). The real Claude Code coordinator terminal runs inside the coordinator window in the middle, and only the sessions the coordinator actually calls appear around it: advisors on the right, one operator window per handoff (named by its team), and below it one worker window per issue that handoff started a worker for. Teams that were not handed work and issues not in a handoff do not appear. The screen only reads the run folder's records (`guard.log`, `advice-log.jsonl`, `handoffs/`; `app/lib/flow.mjs`, event shapes in [docs/app-screen.md](docs/app-screen.md)). Drag the background to pan, use the wheel to zoom, and double-click an operator window to see that handoff's workers and models. Usage in the top bar comes from the coordinator's statusline (Claude Pro or Max subscriptions, after the first response). Clicking it opens per-account limits: Claude (5-hour, weekly, context) and GitHub (API calls left) as bars, and Pi, Gemini, and Jev as connection status only, because those providers do not report remaining limits. The top-left and top-right panels can be dragged, and they stay on screen when the window size or resolution changes. Operator windows are named by their team (`개발 Operator` dev, `디자인 Operator` design, `테스터 Operator` tester, `기획 Operator` plan, `보안 Operator` security). A session that finished its work (an advisor whose advice passed, a finished worker, an operator whose handoff ended) shows ✓ briefly and then disappears; calling it again brings up a new window. Sessions that ended in an error stay. A new instruction does not redraw the screen from scratch: the remaining windows stay and new sessions are added. The JEV marks light up while Jev is judging (the advisor side for advice verdicts, the operator side for reviewer verdicts and worker model routing). Closing the window while sessions are running shows a "진행중인 세션이 있습니다." (sessions are running) warning with [확인] (OK) and [돌아가기] (Back); operators and workers already handed off keep running to the end even if the app closes.

```bash
cd app
npm install
npm start            # run in development
npm test             # app logic tests (no Electron)
npm run smoke        # smoke test: the real app window + a fake coordinator (no models or network); screenshots in app/out/smoke/
npm run dist         # Windows installer: app/dist/Terrarium Setup <version>.exe
```

Screen test `/testgo`: type `/testgo` in the coordinator terminal and press Enter to run a 3-minute test of the screen layout. Three advisors and operators for all five teams appear, workers are added one every 4 seconds (n workers under the n-th team, 15 in all), and the JEV marks light up every 12 seconds, alternating between the advisor and operator sides. After 3 minutes the screen returns to what it showed before. The line is not sent to the coordinator, no model or GitHub call is made, and nothing is written to the run folder. It also works while the coordinator is not running. See "화면 시험 `/testgo`" in [docs/app-screen.md](docs/app-screen.md).

Press the gear at the tower's top right, then **[설정 열기]** (Open settings), to switch the main window to the settings screen. The run folder choice, API keys, and designated repository take effect only after **[저장]** (Save) → **저장하기** (Save), which also returns you to the tower. **[돌아가기]** (Back) or Esc returns without saving.

First use:

1. **[설정] → 계정** (Accounts tab): log in to Claude Code, GitHub, and Pi with the login buttons. Enter API keys, type the designated repository (`<owner>/<name>`), and press **사전 점검** (preflight check). The coordinator terminal opens only after this check passes.
2. **[설정] → 설치** (Run folder setup tab): enter the designated repository, a run folder name, and the target project (a git folder with a `main` branch; leave empty for the sample memo program), then press **설치** (Install). If the designated repository does not exist, the app asks whether to create it as private (if the step 1 check failed because the repository was missing, press the preflight check again after it is created).
3. **Coordinator window** in the middle of the main window: when the terminal appears, talk to the coordinator. The first time, Claude Code asks whether you trust the folder. **The default selection is "No", so pressing Enter alone chooses No. Move down to "Yes, I trust this folder" and press Enter.** With No, the allow list does not apply and the harness hooks may not run.
   - Esc interrupts a turn, and Claude Code commands such as `/compact` work as usual. Pressing Esc while a handoff is running does not stop the handoff; on the next turn the coordinator picks it up again. To stop a handoff, ask the coordinator to stop it (`stop-operator`), not Esc.
   - When the coordinator exits, press Enter in the terminal to reopen the same conversation, or N for a new one.
   - When you restart the app, it reopens the previous conversation for that run folder.

Download the latest `Terrarium-Setup-<version>.exe` from [GitHub releases](https://github.com/WooCH16/Terrarium_/releases). The installer is not code-signed. If Windows shows "Windows protected your PC" on first launch, choose **More info → Run anyway**.

Updates (installed app, from 0.2.0-beta.4): 10 seconds after launch and every 6 hours, the app checks GitHub releases for a new version. If one exists, it downloads it in the background and shows a notice at the top of the tower. Once downloaded, **[지금 재시작]** (Restart now) installs it and reopens the app; **[나중에]** (Later) installs it the next time you close the app. You don't reinstall, and your settings (`%APPDATA%\Terrarium`) stay. Pressing Restart now while sessions are running shows the same "진행중인 세션이 있습니다." (sessions in progress) warning as closing the window. Harness scripts (hooks and run scripts) update with the app, because a run folder points to the harness inside the app's install folder (`resources/harness`). The rules, agents, and settings copied into a run folder (`CLAUDE.md`, `.claude/`) do not change; to use the new version's rules, rewrite them with `node <app install folder>/resources/harness/setup.mjs --run <run folder> --repo <designated repo> --refresh`. 0.2.0-beta.3 and earlier lack this feature, so install beta.4 by hand once.

### 2. Claude CLI

Run the scripts in a terminal yourself, then start `claude` in the run folder and talk to the coordinator.

```bash
# 1. Keys: put them in .env at the repository root (not committed)
#    TYPESAFE_API_KEY=...      (required, reviewer and routing)
#    GEMINI_API_KEY=...        (when using the gemini worker)

# 2. Preflight check (the designated repository is created in step 3)
node harness/preflight.mjs

# 3. Set up a run folder (without a target project, the sample memo program is used)
node harness/setup.mjs --run C:/Users/<you>/my-run --project C:/path/to/your/git/project
#    To choose the repository name yourself: --repo <owner/name> [--create-repo]

# 4. Run: start the coordinator in the run folder (same settings the app uses)
cd C:/Users/<you>/my-run
claude --setting-sources project,local --allowedTools "Bash Write Edit Read Glob Grep Agent TodoWrite Skill"
#    To pick up where you left off, add --continue or --resume <session id> to the same command

# 5. Check (after the run finishes)
node harness/e2e/verify.mjs --run C:/Users/<you>/my-run --since <start time ISO>
```

`--project` clones your repository into the run folder and cuts its `origin`, so the harness never writes to your original repository. Use a separate designated repository for each target project. Details (folder trust prompt, the Muse public-content gate, tests) are in [harness/README.md](harness/README.md) (Korean).

## Folders

| Path | Contents |
|---|---|
| `harness/` | Harness code and role documents. Each role (coordinator, advisor, operator, worker, reviewer) has `harness/<role>/AGENT.md` and a design document `docs/<role>.md` (Korean). The coordinator document becomes the run folder's `CLAUDE.md` |
| `app/` | Desktop app (Electron). The control-tower screen is `app/tower/`, the settings screen `app/renderer/` |
| `docs/` | Definition, designs, ADRs, checks and run records (`docs/checks/`) |
| `scripts/` | Test runner (`test.mjs`) and CI checks (`check.js`) |

## Tests

```bash
node scripts/test.mjs --fast   # fast tests
node scripts/test.mjs          # everything (a few minutes)
node scripts/check.js          # CI checks
```

## Contributing and security

- How to send issues and PRs: [CONTRIBUTING.md](CONTRIBUTING.md)
- Report security problems privately, not in public issues: [SECURITY.md](SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md) (Korean)

## License

[MIT](LICENSE).
