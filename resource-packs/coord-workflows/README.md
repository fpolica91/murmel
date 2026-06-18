# coord-workflows resource pack

Successor to the bootstrap-era `aweb-team-coord-worktrees` template.

This pack provides harness-neutral resources for a coordinator/developer/reviewer
team. It does **not** create identities, teams, `.murmel` state, git worktrees, or
runtime-specific canonical files.

## Apply

1. Create or join the team explicitly:

   ```bash
   murmel init
   murmel team invite
   murmel team join <invite-token>
   murmel workspace connect --service <service-url>
   murmel check
   ```

2. Copy/adapt the resources under `resources/` into your repo for review.
3. Publish shared operating context explicitly:

   ```bash
   murmel instructions set --body-file resources/instructions.md
   murmel roles add coordinator --title "Coordinator" --playbook-file resources/roles/coordinator.md
   murmel roles add developer --title "Developer" --playbook-file resources/roles/developer.md
   murmel roles add reviewer --title "Reviewer" --playbook-file resources/roles/reviewer.md
   ```

4. Use normal `git worktree` commands when you want separate working copies;
   then initialize/connect each workspace with `murmel init`, `murmel team join`, or
   `murmel workspace connect`.

See `docs/resource-pack-template-contract.md` in the aweb repo for the contract.
