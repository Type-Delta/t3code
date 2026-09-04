# Claude

This guide is for people who want to use more than one Claude setup in T3 Code. For Codex, see
[Codex](./providers-codex.md). For first-time setup, see [Install T3 Code](./install.md).

Common reasons:

- use separate work and personal Claude accounts
- try a different Claude Code configuration without disturbing your main setup
- run Claude through a router such as Claude Code Router
- use external providers exposed through a Claude-compatible workflow

## Subagent Transcripts

When Claude delegates work with its Task tool, the main chat shows a subagent tool call with a
prompt preview. Select it to open the subagent transcript in the right panel. The panel uses the
normal chat layout without a message box, and its first message contains the complete prompt sent
to the subagent. Subagent responses and tool activity stay out of the main transcript when Claude
supplies their parent Task identifier. Dynamic output without that identifier remains in the main
chat so it is not hidden.

## I Only Use One Claude Account

Use the default provider.

Log in with Claude Code normally:

```bash
claude auth login
```

In T3 Code Settings, your Claude provider can stay like this:

```text
Display name: Claude
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

An empty `CLAUDE_CONFIG_DIR path` means T3 Code uses Claude Code's normal config directory.

When you set this field, T3 Code points Claude Code at that directory with the
`CLAUDE_CONFIG_DIR` environment variable. It does not change `HOME`, so your system keychain and
the rest of your environment stay as they are.

## Resume After Usage Limits

T3 Code automatically sends scoped resume instructions when native Claude Code rejects a turn
because of a usage limit and reports an exact reset time. The pending continuation survives a T3
server restart and is discarded if the thread is no longer waiting on that failed turn. This is
sent three seconds after the reported reset and transient dispatch failures retry after another
three seconds. T3 Code checks that it has not already sent the resume message before each attempt.
This is enabled by default; turn it off under **Settings → General → Auto-resume after usage
limits**.

Compatible API gateways do not currently expose an authoritative usage-limit reset through Claude
Code. T3 Code therefore does not auto-resume generic gateway `429` errors.

## Reduce Context Usage

In Settings, open your Claude provider and set **Auto-compact after** to a token count between
`100000` and `1000000`. For example, `300000` compacts the conversation into a summary once it
reaches about 300,000 tokens, without changing the model's context window. Leave the field
empty to keep Claude Code's default behavior.

On web and desktop, when you return to an older Claude thread with a large context, T3 Code
offers to compact the conversation before you continue. You can also select **Compact context**
from the context meter. On every client, you can enter `/compact` in the message composer, and
Claude can show its own resume prompt when you continue an old session.

## Where Claude Skills Are Loaded

T3 Code looks for Claude skills in the Claude config directory's `skills` folder, then
`<workspace>/.agents/skills`, then `<workspace>/.claude/skills`.

If the same skill name exists in more than one folder, the later folder wins.

## I Want Work And Personal Claude Accounts

Use a different Claude config directory for each account.

Example:

```text
default config dir           work account
~/.claude_personal_home      personal account
```

### Set Up The First Account

Log in normally:

```bash
claude auth login
```

In T3 Code Settings:

```text
Display name: Claude Work
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

### Set Up The Second Account

Log in with a separate config directory:

```bash
mkdir -p ~/.claude_personal_home
CLAUDE_CONFIG_DIR=~/.claude_personal_home claude auth login
```

Use `CLAUDE_CONFIG_DIR`, not `HOME`. Setting `HOME` writes the login to
`~/.claude_personal_home/.claude`, which is not where T3 Code looks.

Then add another Claude provider in T3 Code:

```text
Display name: Claude Personal
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_personal_home
```

Use the email shown in Settings to confirm each provider is using the intended account. Emails are
blurred by default; click the blurred email to reveal it.

## Can I Switch Claude Accounts In An Existing Thread?

Usually, no.

T3 Code only offers Claude providers that use the same config directory for an existing thread. A
different config directory is treated as a different Claude environment.

This is different from the recommended Codex setup. Claude Code keeps account and local state across
multiple files under its config directory, so T3 Code keeps separate config directories isolated
instead of trying to share part of the state.

## Use a compatible API gateway

Claude provider instances can use an Anthropic-compatible API gateway such as CLIProxyAPI. When
you add a provider instance, open the third step, **Config**, and enable **Compatible API gateway**.
You can also expand an existing Claude provider in Settings and change the same fields there.

Set **Gateway base URL** to the inference URL that Claude Code should use. T3 sets
`ANTHROPIC_BASE_URL` and enables Claude Code's gateway model discovery for this provider instance.

T3 requests its own model catalog so the model picker can show gateway models and their metadata.
Leave **Model catalog URL** empty to derive `/v1/models` from the base URL, or enter the complete
catalog URL when the gateway uses another path. **Auto-detect** accepts Codex, Anthropic, and OpenAI
catalog shapes. Use an explicit format if auto-detection chooses the wrong one.

Enter the gateway credential in the **API key** password field. The key may use any format accepted
by the gateway. T3 stores it as a sensitive provider value and shows only a redacted placeholder
after saving. Bearer authentication maps the value to `ANTHROPIC_AUTH_TOKEN`; `x-api-key`
authentication maps it to `ANTHROPIC_API_KEY`. Leave the field empty only when the catalog and
inference endpoint need no authentication.

The T3 server performs catalog discovery, so web and mobile clients do not receive the gateway
credential. T3 caches the last successful catalog for this provider instance. If a later request
fails, the cached models remain available. Without a cache, T3 falls back to its Claude model list
and any models you added manually.

### Check or override model information

Under **Models**, point to the information icon beside a model to see the detected model ID,
description, metadata source, usable and maximum context windows, maximum output, reasoning levels,
default reasoning level, and other reported capabilities. Unknown fields are omitted. If T3 only
knows the model ID, the tooltip says that no additional metadata was detected.

When you add a custom model, T3 opens a metadata form. You can set its display name, usable context
window, theoretical maximum context window, maximum output, supported reasoning efforts, and
default effort. Use the pencil beside any visible model to change those values. Manual values take
precedence over the gateway catalog and T3's built-in Claude metadata.

The usable context window should be the limit that this gateway and account can accept. The maximum
context window is the model's theoretical limit and may be larger. For example, enter `200000` as
usable and `1000000` as maximum when the model supports one million tokens but the account does not.
Leave unknown values empty instead of estimating them.

T3 passes detected or manually configured reasoning efforts to Claude Code. For context, Claude
Code exposes a normal model ID and a `[1m]` model selector rather than an arbitrary numeric window.
T3 uses the normal model ID for usable windows up to 200,000 tokens and appends `[1m]` for larger
usable windows. Maximum output and theoretical maximum context remain informational. A gateway may
still reject `[1m]` when the account lacks long-context access, so configure usable context from the
limit that the account can actually use.

## I Want To Use OpenRouter

Use this when you want Claude Code to talk to OpenRouter directly, without running a local router.
This is the simplest external-provider setup.

OpenRouter provides a Claude Code integration through Claude's Anthropic-compatible environment
variables.

### Configure A Claude OpenRouter Provider

Add or edit a Claude provider in T3 Code Settings:

```text
Display name: Claude OpenRouter
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_openrouter_home
```

In that provider's Environment variables section, add:

```text
ANTHROPIC_BASE_URL   https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN sk-or-...                Sensitive
ANTHROPIC_API_KEY                              Empty value
```

Mark `ANTHROPIC_AUTH_TOKEN` as sensitive. T3 Code stores the value as a server secret and does not
send it back to the app after saving.

If you want this setup isolated from your normal Claude account, create that home first:

```bash
mkdir -p ~/.claude_openrouter_home
```

If you previously used the same Claude home with a normal Anthropic login, run `/logout` in a Claude
Code session for that home before using OpenRouter. Otherwise Claude Code may keep using cached
Anthropic credentials instead of the OpenRouter token.

### Pick OpenRouter Models

OpenRouter can route Claude Code's default model roles to OpenRouter model IDs.

Example:

```text
ANTHROPIC_DEFAULT_OPUS_MODEL    anthropic/claude-opus-4.6
ANTHROPIC_DEFAULT_SONNET_MODEL  anthropic/claude-sonnet-4.6
ANTHROPIC_DEFAULT_HAIKU_MODEL   anthropic/claude-haiku-4.5
CLAUDE_CODE_SUBAGENT_MODEL      anthropic/claude-sonnet-4.6
```

Add those to the same provider's Environment variables section if you want stable model choices.

### Verify OpenRouter Is Being Used

Open a Claude session and run:

```text
/status
```

You should see the Anthropic base URL set to:

```text
https://openrouter.ai/api
```

You can also check the OpenRouter activity dashboard for requests from your API key.

### Common OpenRouter Mistakes

- Use `https://openrouter.ai/api`, not `https://openrouter.ai/api/v1`, for Claude Code.
- Set `ANTHROPIC_AUTH_TOKEN` to your OpenRouter API key.
- Set `ANTHROPIC_API_KEY` to an empty string so Claude Code does not try to use an Anthropic login.
- Put these variables on the Claude provider instance, not in global shell startup files.

OpenRouter's setup can change over time. Use its upstream Claude Code guide for the current details:
<https://openrouter.ai/docs/guides/guides/claude-code-integration>.

## I Want To Use Claude Code Router

Claude Code Router is useful when you want a local routing layer with more control than a direct
OpenRouter setup.

T3 Code does not need a special Claude Code Router provider. Treat the router as a Claude
environment: give a Claude provider its own `CLAUDE_CONFIG_DIR path`, and put whatever variables
the router tells you to export into that provider's Environment variables section. Mark tokens
and API keys as sensitive.

```text
Display name: Claude Router
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_router_home
```

Follow the upstream project's README for the router's own install, startup, and configuration
steps: <https://github.com/musistudio/claude-code-router>.

## I Want Different Claude Settings, Not A Different Account

Create another Claude provider with the same account if you want a named preset.

Examples:

- "Claude Default"
- "Claude Router"
- "Claude Experimental"

If the preset needs different Claude files, give it a different `CLAUDE_CONFIG_DIR path`. If it needs
different API keys, base URLs, or router settings, use Environment variables.

Do not put environment variable assignments in `Launch arguments`.
