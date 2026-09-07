# Agent thread tools

Agents can manage T3 Code threads in their current environment. A thread is a normal T3 Code
conversation. It appears in the sidebar and stays available after the agent turn ends.

## Available tools

- `list_models` lists models for currently selectable provider instances, optionally filtered by
  driver.
- `create_thread` creates a thread and sends its first message.
- `list_threads` lists active threads in the current environment.
- `read_thread` reads a thread and its recent history.
- `send_message_to_thread` sends a message to another active thread.
- `wait_threads` waits for threads to finish or need attention.

`read_thread` returns activity output only when the agent asks for it. It can use a cursor to read
older history.

## Providers, drivers, and models

A provider is one user-configured instance, such as a personal Codex account or a custom endpoint.
A driver is the supported coding harness behind that instance, such as Codex, Claude Code, Cursor,
Grok, or OpenCode. More than one provider can use the same driver.

`list_models` returns provider instances that are enabled, available in this build, and ready for
use. Its models match the choices in T3 Code, including legacy and custom entries. The optional
filter selects a driver kind rather than a provider instance ID. Provider settings can change while
the server is running, so call the tool again when current availability matters.

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

## Management API keys

For an external MCP client, create a durable credential in **Settings → Integrations → Management
API keys**. Select the environment that runs on the machine the client should control, give the key
a recognizable name, choose an expiration and access preset, then copy the secret from the
confirmation dialog. The secret is shown only once. Store it in a password manager or an
environment variable; it is not included when keys are listed later.

Each management key belongs to one environment and works only with that machine's MCP endpoint. A
different environment needs its own key. Keys can be limited to model discovery and thread reading,
or granted the thread orchestration tools. They do not grant access to terminals, files, previews,
settings, connections, or other management keys. Runtime permissions belong to threads, not keys:
new threads use T3 Code's normal default, and messages use the existing thread's current mode.

The endpoint shown after creating a key is the environment's `/mcp` endpoint. A generic JSON HTTP
MCP configuration can use an environment variable for the bearer token:

```json
{
  "mcpServers": {
    "t3": {
      "type": "http",
      "url": "https://your-t3-host.example/mcp",
      "headers": {
        "Authorization": "Bearer ${T3_MANAGEMENT_API_KEY}"
      }
    }
  }
}
```

Claude Code accepts the same HTTP entry in its project `.mcp.json` file. Keep the `${T3_MANAGEMENT_API_KEY}` placeholder in the file so Claude Code reads the bearer token from the process environment instead of storing it in project configuration.

For Codex, set the variable before starting Codex and add the HTTP server to its TOML
configuration:

```sh
export T3_MANAGEMENT_API_KEY='paste-the-secret-here'
```

```toml
[mcp_servers.t3]
url = "https://your-t3-host.example/mcp"
bearer_token_env_var = "T3_MANAGEMENT_API_KEY"
```

Rotate a key when its secret may have been exposed. Rotation immediately invalidates the old
secret and reveals a replacement once. Revoke a key to disable it immediately; existing MCP
connections will receive an authentication error on their next request.

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
