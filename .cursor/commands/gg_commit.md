# gg_commit

`/gg_commit [message]` is a command to commit staged changes to the repository.

## Usage

```bash
/gg_commit [message]
```

## Behavior

1. **With message provided**: Commits the staged changes with the provided message.
   - Example: `/gg_commit Fix bug in debugger initialization`

2. **Without message**: Automatically generates a commit message by:
   - Running `git diff --cached` to analyze staged changes
   - Summarizing the changes into an appropriate commit message
   - Committing with the generated message

## Workflow

1. Stage your changes using `git add` (if not already staged)
2. Run `/gg_commit` with or without a message
3. The command will create a commit with the appropriate message

## Notes

- Only commits staged changes (files added via `git add`)
- Does not push changes to remote repository
- Automatically generates meaningful commit messages when none provided
- Follows conventional commit message format when possible

This command will be available in chat with `/gg_commit`
