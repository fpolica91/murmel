# Hermes Aweb platform plugin

Prototype Hermes gateway platform for Aweb agent mail/chat.

This is a real Hermes platform adapter, not a docs-only `murmel init` recipe. It registers `ctx.register_platform(name="aweb", ...)`, starts `murmel events stream --json`, fetches actionable message bodies through the `murmel` CLI, injects them into Hermes as `MessageEvent`s, replies with `murmel mail reply` / exact `murmel chat send --session-id`, and only then marks the triggering message read with `murmel mail ack` / `murmel chat read`.

## Current install shape

For local testing, copy or symlink this directory into Hermes' user plugin directory:

```bash
mkdir -p ~/.hermes/plugins/platforms
ln -s /path/to/aweb/packages/hermes-aweb-platform ~/.hermes/plugins/platforms/aweb
hermes plugins enable platforms/aweb
```

Then configure an Aweb workspace for the Hermes gateway identity:

```bash
cd /path/to/hermes-aweb-workspace
murmel workspace status
```

Set env in `~/.hermes/.env` or via `hermes gateway setup`:

```bash
AWEB_PLATFORM_ENABLED=true
AWEB_PLATFORM_WORKDIR=/path/to/hermes-aweb-workspace
AWEB_PLATFORM_AW_BIN=murmel
AWEB_ALLOW_ALL_USERS=true        # dev only; prefer AWEB_ALLOWED_USERS in real use
# AWEB_ALLOWED_USERS=example.aweb.ai/alice,example.aweb.ai/bob
# AWEB_HOME_CHANNEL=example.aweb.ai/alice
```

Start Hermes gateway:

```bash
hermes gateway restart
hermes gateway status
```

## Requires murmel CLI support

The adapter needs machine-safe read acknowledgement commands:

- `murmel mail ack <message-id> --json`
- `murmel chat send --session-id <session-id> --body-file <path> --leave --json`
- `murmel chat read --session-id <session-id> --message-id <message-id> --json`

Those are added in this same change because existing `murmel mail inbox` / `murmel chat open` acknowledge by side effect and are not precise enough for a gateway adapter.

## MVP scope

- Inbound Aweb actionable mail and chat.
- Outbound plaintext replies through current murmel defaults (`--plaintext` is explicit in the adapter).
- No media attachments.
- No Hermes-side Aweb identity creation; create/bootstrap the murmel workspace first.
- No server-side Aweb changes.

## Main blocker resolved here

Before this adapter, Aweb had an event stream and body fetch commands, but no stable CLI command to reply to an exact chat session or ack/read a specific message after Hermes confirmed delivery. The new `murmel chat send --session-id`, `murmel mail ack`, and `murmel chat read` commands close that adapter contract gap.
