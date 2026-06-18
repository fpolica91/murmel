# company-surfaces resource pack

Successor to the bootstrap-era `aweb-team-company-surfaces` template.

This pack provides harness-neutral operating resources for organizing agents by
company/customer surface. It does **not** create identities, team memberships,
`.murmel` state, git worktrees, or canonical runtime-specific files.

## Apply

1. Create or join the team with explicit primitives (`murmel init`, `murmel team invite`,
   `murmel team join`, `murmel workspace connect`).
2. Review and adapt the resources under `resources/`.
3. Publish instructions/roles deliberately:

   ```bash
   murmel instructions set --body-file resources/instructions.md
   murmel roles add coordinator --title "Coordinator" --playbook-file resources/roles/coordinator.md
   murmel roles add product --title "Product" --playbook-file resources/roles/product.md
   murmel roles add engineering --title "Engineering" --playbook-file resources/roles/engineering.md
   murmel roles add support --title "Support" --playbook-file resources/roles/support.md
   murmel roles add docs --title "Docs" --playbook-file resources/roles/docs.md
   ```

4. Create any local directories or git worktrees with normal filesystem/git
   commands, then run `murmel check`.
