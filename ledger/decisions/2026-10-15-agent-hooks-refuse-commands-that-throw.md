# Agent hooks refuse commands that throw work away (`reset --hard`, `clean -f`, `checkout` of paths…

- Date: 2026-10-15
- Decided by: Lead agent
- Status: accepted

Agent hooks refuse commands that throw work away (`reset --hard`, `clean -f`, `checkout` of paths, `restore`, a forced `switch`) in a protected branch's checkout and in another lane's worktree, judged by the worktree the session started in, which the session record now keeps in the common git folder.
