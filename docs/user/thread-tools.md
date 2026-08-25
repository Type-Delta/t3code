# Agent thread tools

Agents can manage T3 Code threads in their current environment. A thread is a normal T3 Code
conversation. It appears in the sidebar and stays available after the agent turn ends.

## Available tools

- `create_thread` creates a thread and sends its first message.
- `list_threads` lists active threads in the current environment.
- `read_thread` reads a thread and its recent history.
- `send_message_to_thread` sends a message to another active thread.
- `wait_threads` waits for threads to finish or need attention.

`read_thread` returns activity output only when the agent asks for it. It can use a cursor to read
older history.

## Threads and subagents

These tools create durable threads that you can open, manage, and continue. Each thread has its
own conversation, project, model selection, permission mode, and workspace.

Native subagents are internal helper agents. T3 Code shows their task and transcript, but they do
not create a new editable thread. Agents use native subagents for short, private fan-out work.

## Scope and permissions

The tools can access only the calling thread's environment. They cannot read or control threads in
another saved environment. A thread cannot send a message to itself.

Creating a thread or sending it a message can start agent work. A new thread inherits the calling
thread's permission mode. A message sent to an existing thread uses that thread's current mode.
Review [Permission modes](./permission-modes.md) before you let agents create work in a shared
checkout.

Thread tools use the same product MCP access as agent browser tools. In **Settings**,
**Integrations**, turn on **Agent browser access** before you start a new agent session. A running
agent keeps the tools it received when its session started.

## Worktrees

An agent can create a thread in the current checkout or in a new Git worktree. A worktree uses a
new branch and does not change the project's main checkout. T3 Code runs the project's configured
new-worktree setup script there.

The agent can select a base branch. It can also ask T3 Code to start from the latest `origin`
revision when the repository has that remote.

## Limits

- A prompt or message can contain up to 120,000 characters.
- `list_threads` returns 50 threads by default and at most 200.
- `read_thread` reads 10 turns by default and at most 50 at a time.
- `read_thread` hides activity output by default. `maxOutputCharsPerItem` defaults to 8,000
  characters per item and is limited to 20,000. It truncates returned message text.
  Activity payloads use the same limit but appear only when `includeOutputs` is `true`.
- `wait_threads` accepts at most eight threads and waits up to five minutes. Its returned
  `latestAssistantMessage` is capped at 8,000 characters.

Set `timeoutMs` to `0` when an agent only needs the current thread state.

## Provider availability

Thread tools are available in Codex, Claude Code, Cursor, Grok, and OpenCode sessions when T3
Code gives the session product MCP access.
