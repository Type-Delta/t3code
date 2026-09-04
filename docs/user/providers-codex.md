# Codex

This guide is for people who want to use more than one Codex account in T3 Code. For Claude, see
[Claude](./providers-claude.md). For first-time setup, see [Install T3 Code](./install.md).

Common reasons:

- use a work account for work projects
- use a personal account for personal projects
- switch to another account when one account hits limits
- keep one shared Codex history instead of maintaining two separate Codex setups

## Subagent Transcripts

When Codex delegates work to a subagent, the main chat shows a subagent tool call with a prompt
preview. Select it to open the subagent transcript in the right panel. The panel uses the normal
chat layout without a message box, and its first message contains the complete prompt sent to the
subagent. Subagent responses and tool activity stay out of the main transcript.

## I Only Use One Codex Account

Use the default provider.

In Settings, your Codex provider can stay like this:

```text
Display name: Codex
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

Log in with Codex normally:

```bash
codex login
```

## Resume After Usage Limits

T3 Code automatically sends scoped resume instructions when native Codex rejects a turn because of
a usage limit and reports an exact reset time. The pending continuation survives a T3 server restart
and is discarded if the thread is no longer waiting on that failed turn. This is sent three seconds
after the reported reset and transient dispatch failures retry after another three seconds. T3 Code
checks that it has not already sent the resume message before each attempt. This is enabled by
default; turn it off under **Settings → General → Auto-resume after usage limits**.

Compatible API gateways do not currently expose an authoritative usage-limit reset through Codex.
T3 Code therefore does not auto-resume generic gateway `429` errors.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` or `/feedback` followed by a description of the
issue. T3 Code uploads the thread and Codex logs to OpenAI and shows a thread ID that you can copy
and share with OpenAI employees.

## Sub-agent models

The web and desktop Agents panel shows each sub-agent's model and reasoning effort when Codex
reports them. If Codex does not report either value, T3 Code leaves it out instead of using the
parent agent's settings.

## Approve access to other apps

When a Codex tool needs access to an app such as Safari, T3 Code shows the app name and asks for
approval. You can approve, decline, or cancel the request from the desktop app, web app, or mobile
app. Some tools also offer approval for the current session or permanent approval.

## I Want Work And Personal Codex Accounts

Use one real Codex home and one shadow home.

Recommended setup:

```text
~/.codex      shared Codex home
~/.codex_p    second account auth
```

The idea is:

- both accounts can see the same T3/Codex sessions
- each account keeps its own login
- existing threads can continue with either account

### Set Up The First Account

Log in normally:

```bash
codex login
```

This is the account used by `~/.codex`.

In T3 Code Settings, name it something obvious:

```text
Display name: Codex Work
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

### Set Up The Second Account

Log in with a separate Codex home:

```bash
mkdir -p ~/.codex_p
CODEX_HOME=~/.codex_p codex login
```

In T3 Code Settings, add another Codex provider:

```text
Display name: Codex Personal
CODEX_HOME path: ~/.codex
Shadow home path: ~/.codex_p
```

The important part is that both providers use the same `CODEX_HOME path`, but only the second one
has a `Shadow home path`.

## Which Account Am I Using?

Open Settings and look at the provider row.

T3 Code shows the authenticated email for providers that report one. Emails are blurred by default;
click the blurred email to reveal it.

Use display names and accent colors to make accounts easy to tell apart in the model picker.

## I Need A Different API Key Or Endpoint

Use the provider's Environment variables section in Settings.

This is useful when a Codex-compatible setup needs account-specific variables. Add the variables to
the provider instance that should receive them, and mark API keys or tokens as sensitive. Sensitive
values are stored as server secrets and are not sent back to the app after saving.

## Use a compatible API gateway

Codex provider instances can use an OpenAI-compatible API gateway such as CLIProxyAPI. When you
add a provider instance, open the third step, **Config**, and enable **Compatible API gateway**. You
can also expand an existing Codex provider in Settings and change the same fields there.

Set **Gateway base URL** to the gateway origin or path prefix. You do not need to add `/v1`; T3
adds it when Codex needs it and preserves an existing `/v1` suffix. Codex sends Responses API
requests to this gateway, which must support that API.

T3 also requests a model catalog from the gateway. Leave **Model catalog URL** empty to derive
`/v1/models` from the base URL, or enter the complete catalog URL when the gateway uses another
path. **Auto-detect** accepts these catalog shapes:

- Codex catalogs with a top-level `models` array
- Anthropic catalogs with a top-level `data` array and fields such as `max_input_tokens`
- OpenAI catalogs with a top-level `data` array

Use an explicit format if auto-detection chooses the wrong shape.

Enter the gateway credential in the **API key** password field. The key may use any format accepted
by the gateway. T3 stores it as a sensitive provider value and shows only a redacted placeholder
after saving. Choose whether the catalog request sends it as a bearer token or an `x-api-key`
header. Leave the field empty only when the catalog needs no authentication.

The T3 server performs discovery, so web and mobile clients do not receive the gateway credential.
T3 caches the last successful catalog for this provider instance. If a later request fails, the
cached models remain available. Without a cache, T3 falls back to the models reported by Codex and
any models you added manually.

### Check or override model information

Under **Models**, point to the information icon beside a model to see the detected model ID,
description, metadata source, usable and maximum context windows, maximum output, reasoning levels,
default reasoning level, and other reported capabilities. Unknown fields are omitted. If T3 only
knows the model ID, the tooltip says that no additional metadata was detected.

When you add a custom model, T3 opens a metadata form. You can set its display name, usable context
window, theoretical maximum context window, maximum output, supported reasoning efforts, and
default effort. Use the pencil beside any visible model to change those values. Manual values take
precedence over the gateway catalog and Codex metadata.

The usable context window should be the limit that this gateway and account can accept. The maximum
context window is the model's theoretical limit and may be larger. For example, enter `200000` as
usable and `1000000` as maximum when the model supports one million tokens but the account does not.
Leave unknown values empty instead of estimating them.

T3 passes the selected reasoning effort to Codex and sets `model_context_window` only when a usable
context value is known. It never substitutes the theoretical maximum. For a Codex-format catalog,
T3 also gives the original catalog to Codex through `model_catalog_json`. Descriptions and maximum
output values remain informational because Codex has no matching per-turn setting for them.

## Can I Switch Accounts In An Existing Thread?

Yes, when both Codex providers share the same `CODEX_HOME path`.

For example:

```text
Codex Work      CODEX_HOME path: ~/.codex
Codex Personal  CODEX_HOME path: ~/.codex, Shadow home path: ~/.codex_p
```

Those two providers are considered compatible for continuation, so the locked model picker can show
both.

If you add a third Codex provider with a completely different `CODEX_HOME path`, T3 Code treats it
as a different workspace. It will not be offered for existing threads created under `~/.codex`.

## If Both Accounts Look The Same

If two Codex providers show the same account or the same unexpected model list:

1. Check the email in Settings.
2. Refresh provider status.
3. Confirm the second provider has `Shadow home path` set.
4. Confirm the shadow directory has its own `auth.json`.
5. If you copied `~/.codex` into the shadow directory, remove everything except `auth.json`.

Example cleanup:

```bash
find ~/.codex_p -mindepth 1 ! -name auth.json -exec rm -rf {} +
```

## When To Use A Separate CODEX_HOME

Use a totally separate `CODEX_HOME path` only when you want a separate Codex workspace.

That means separate sessions and less account switching inside old threads. Most dual-account users
should use the shared-home plus shadow-home setup instead.
