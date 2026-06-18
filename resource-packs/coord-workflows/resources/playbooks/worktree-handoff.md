# Worktree handoff

Use explicit git/filesystem operations for parallel work:

```bash
git worktree add ../project-review -b review/<task-id>
cd ../project-review
murmel init
# or: murmel team join <invite-token>
# or: murmel workspace connect --service <service-url>
murmel check
```

Record the path, branch, role, and task in aweb before handing off.
