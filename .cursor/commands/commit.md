# commit

`/commit [message]` is a command to commit the changes to the repo. 

It will commit the changes to the repo with the message "commit message".
If no message is provided, it will call `git diff --cached` to get the changes, then summarize them into a message.

This command will be available in chat with /commit
