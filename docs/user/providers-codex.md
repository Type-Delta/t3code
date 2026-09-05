# Codex

For one account, use the default Codex provider with your normal Codex login.
[Provider setup](./install.md#providers) covers installation, Settings > Providers,
and custom binaries or environment variables.

## Subagent transcripts

When Codex delegates work, select the subagent tool call in the main chat to open
its read-only transcript in the right panel. Subagent responses and tool activity
stay out of the main transcript. The Agents panel shows the model and reasoning
effort when Codex reports them; missing values are not inferred from the parent.

## Resume after usage limits

When native Codex rejects a turn because of a usage limit and reports an exact
reset time, T3 Code sends a scoped continuation three seconds after the reset.
The pending continuation survives a server restart and is discarded if the
thread is no longer waiting on that turn. Transient dispatch failures retry after
three seconds. Disable this under **Settings > General > Auto-resume after usage
limits**.

Compatible API gateways do not expose an authoritative reset through Codex, so
generic gateway `429` errors do not trigger automatic continuation.

## Use multiple accounts

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while
keeping separate logins and model access.

Keep your first account in `~/.codex`. On the environment's machine, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. T3 Code prepares shared
state in the shadow directory. Do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json`. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a separate **CODEX_HOME path**, with no shadow home, when you want separate
sessions and configuration. That instance cannot continue threads from the other
home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. T3 Code offers compatible
instances that share the thread's **CODEX_HOME path**.

If an account is missing, compare the home paths in provider settings, refresh
provider status, and confirm the second instance has its own shadow path and
login. A shadow-home conflict usually means the directory contains a copied
Codex setup. Use a fresh shadow directory and sign in again.

## Use a compatible API gateway

Add or edit a Codex instance, open **Config**, and enable **Compatible API
gateway**. Set **Gateway base URL** to the gateway origin or path prefix. T3 Code
adds `/v1` when Codex needs it and preserves an existing `/v1` suffix. The gateway
must support the Responses API.

T3 Code also requests a model catalog from the gateway. Leave **Model catalog
URL** empty to derive `/v1/models`, or enter the complete URL. Auto-detection
accepts Codex `models`, Anthropic `data`, and OpenAI `data` catalog shapes. Choose
an explicit format if detection selects the wrong one.

Enter the catalog credential in **API key** and choose bearer or `x-api-key`
authentication. Marked credentials stay in the provider's sensitive environment
storage and are not returned to web or mobile clients. A failed refresh keeps the
last successful cached catalog; without a cache, T3 Code uses Codex models and
manual custom models.

Under **Models**, you can inspect detected context, output, and reasoning metadata
or set manual overrides. Manual values take precedence over gateway and Codex
metadata. T3 Code passes the selected reasoning effort and the usable context
window to Codex. It does not substitute a model's larger theoretical maximum.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer reaches the active turn, or starts another turn if Codex has
finished. Unanswered questions survive reconnects. This requires a Codex version
that supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
on web, desktop, or mobile. Some tools offer access for one request, the current
session, or permanently. See [Permission modes](./permission-modes.md).

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. T3 Code uploads
the conversation and Codex logs. You can share the returned thread ID with OpenAI
support.
