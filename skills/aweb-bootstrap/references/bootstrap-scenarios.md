# aweb Bootstrap scenarios — RETIRED

This reference documented scenarios for the legacy `murmel agents`
bootstrap/provision/add lifecycle and BYOT team/namespace setup. **Those
commands were removed in the token-only auth pivot** and no longer exist, so
these scenarios are no longer runnable.

There is no replacement "bootstrap" reference because the layout-generator
concept itself was retired. Onboarding is now token-only and per-directory:

```bash
murmel login                                          # or: export AW_TOKEN=<jwt>
murmel init --aweb-url <server-url> --team <team-id>
murmel check
```

For current guidance see:

- `../SKILL.md` — the retirement notice and the token-only "what to do instead".
- `aweb-team-membership` — bearer-token onboarding, active-team selection, auth
  troubleshooting.
- `aweb-identity` — local E2E keys, addressability, inbound mode, contacts.
- `aweb-coordination` — day-to-day work coordination.
- `ai-completion/GETTING-STARTED.md` (aweb repo checkout) — the canonical
  end-to-end token-only walkthrough.
