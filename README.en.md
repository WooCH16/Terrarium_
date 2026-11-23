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
- **One user only:** several people do not share one repository. A separate one per target project is best (reusing one makes the records look mixed up).
- **Two ways to create it:**
  - Yourself: `gh repo create <owner>/harness-issues --private`
  - During setup: `node harness/setup.mjs --run <run folder> --create-repo` (without `--repo`, it uses `harness-issues` under your logged-in account; from the second target project on, give `--repo` a different name). It creates a private repository only when none exists; an existing public repository is left unchanged and setup stops. The app's install screen asks before creating a missing repository.

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

`app/` holds a Windows desktop app (ADR 0010, 0011). The main window is the control-tower screen (`app/tower/`). The real Claude Code coordinator terminal runs inside the coordinator window in the middle, and only the sessions the coordinator actually calls appear around it: advisors on the right, one operator window per handoff (named by its team), and below it one worker window per issue that handoff started a worker for. Teams that were not handed work and issues not in a handoff do not appear. The screen only reads the run folder's records (`guard.log`, `advice-log.jsonl`, `handoffs/`; `app/lib/flow.mjs`, event shapes in [docs/app-screen.md](docs/app-screen.md)). Drag the background to pan, use the wheel to zoom, and double-click an operator window to see that handoff's workers and models. Usage in the top bar comes from the coordinator's statusline (Claude Pro or Max subscriptions, after the first response).

```bash
cd app
npm install
npm start            # run in development
npm test             # app logic tests (no Electron)
npm run smoke        # smoke test: the real app window + a fake coordinator (no models or network); screenshots in app/out/smoke/
npm run dist         # Windows installer: app/dist/Terrarium Setup <version>.exe
```

Press the gear at the tower's top right, then **[설정 열기]** (Open settings), to switch the main window to the settings screen (계정 관리 and 진행 기록 in the profile button open the same screen). The run folder choice, API keys, and designated repository take effect only after **[저장]** (Save) → **저장하기** (Save), which also returns you to the tower. **[돌아가기]** (Back) or Esc returns without saving.

First use:

1. **[설정] → 계정** (Accounts tab): log in to Claude Code, GitHub, and Pi with the login buttons. Enter API keys, type the designated repository (`<owner>/<name>`), and press **사전 점검** (preflight check). The coordinator terminal opens only after this check passes.
2. **[설정] → 설치** (Run folder setup tab): enter the designated repository, a run folder name, and the target project (a git folder with a `main` branch; leave empty for the sample memo program), then press **설치** (Install). If the designated repository does not exist, the app asks whether to create it as private (if the step 1 check failed because the repository was missing, press the preflight check again after it is created).
3. **Coordinator window** in the middle of the main window: when the terminal appears, talk to the coordinator. The first time, Claude Code asks whether you trust the folder. **The default selection is "No", so pressing Enter alone chooses No. Move down to "Yes, I trust this folder" and press Enter.** With No, the allow list does not apply and the harness hooks may not run.
   - Esc interrupts a turn, and Claude Code commands such as `/compact` work as usual. Pressing Esc while a handoff is running does not stop the handoff; on the next turn the coordinator picks it up again. To stop a handoff, ask the coordinator to stop it (`stop-operator`), not Esc.
   - When the coordinator exits, press Enter in the terminal to reopen the same conversation, or N for a new one.
   - When you restart the app, it reopens the previous conversation for that run folder.

The installer is not code-signed. If Windows shows "Windows protected your PC" on first launch, choose **More info → Run anyway**.

### 2. Claude CLI

Run the scripts in a terminal yourself, then start `claude` in the run folder and talk to the coordinator.

```bash
# 1. Keys: put them in .env at the repository root (not committed)
#    TYPESAFE_API_KEY=...      (required, reviewer and routing)
#    GEMINI_API_KEY=...        (when using the gemini worker)

# 2. Create a private designated repository and run the preflight check
gh repo create <owner>/harness-issues --private
node harness/preflight.mjs --repo <owner>/harness-issues
#    If you will create it with --create-repo in step 3, the repository does not exist yet, so check without --repo
#    node harness/preflight.mjs

# 3. Set up a run folder (without a target project, the sample memo program is used)
node harness/setup.mjs --run C:/Users/<you>/my-run --repo <owner>/harness-issues --project C:/path/to/your/git/project
#    If you did not create the repository in step 2, add --create-repo (it creates a private one only when none exists)

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
