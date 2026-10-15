# The ResaLedger terminal demo, recorded from a real run.
# Run from the repository root: vhs docs/assets/demo/demo.tape
# It builds a small bakery shop in /tmp/resaledger-demo; setup.sh and steps.sh do what the demo hides.
# Every command waits for the prompt to come back, so the recording does not depend on the machine's speed.

Output docs/assets/demo/demo.gif

Require git
Require node

Set Shell "bash"
Set FontSize 19
Set Width 1240
Set Height 740
Set Padding 28
Set TypingSpeed 30ms
Set WaitPattern /\$$/
Set WaitTimeout 120s
Set Theme { "name": "ResaLedger", "black": "#151515", "red": "#e07a66", "green": "#a9c79a", "yellow": "#dcc98a", "blue": "#9fb3c8", "magenta": "#bba8c6", "cyan": "#9cc7c7", "white": "#d9d5cc", "brightBlack": "#6b6b6b", "brightRed": "#ea9584", "brightGreen": "#bfd8b2", "brightYellow": "#e8d9a8", "brightBlue": "#b5c6d8", "brightMagenta": "#cbbcd5", "brightCyan": "#b3d6d6", "brightWhite": "#f4f1ea", "background": "#121212", "foreground": "#e9e5dd", "selection": "#333333", "cursor": "#e9e5dd" }

Hide
Type "source docs/assets/demo/steps.sh && source docs/assets/demo/setup.sh && clear"
Enter
Wait
Show

# Set up: init asks two questions, runs the project's checks once and keeps those that pass.
Type "npx resaledger init"
Sleep 400ms
Enter
Wait /\[solo\]$/
Sleep 800ms
Enter
Wait /marker\)$/
Sleep 400ms
Type "Orders for next-morning pickup."
Sleep 400ms
Enter
Wait /\[Y\/n\]$/
Sleep 1500ms
Enter
Wait
Sleep 4s
Hide
Type "demo_readme && clear"
Enter
Wait
Show
Type `git add -A && git commit -qm "chore: set up ResaLedger" -m "Task: maintenance"`
Sleep 300ms
Enter
Wait
Sleep 2s

# A commit with no task is refused.
Type "echo 'export const price = 4' >> src/shop.js"
Enter
Wait
Type `git commit -qam "feat: show prices"`
Sleep 300ms
Enter
Wait
Sleep 4s
Hide
Type "clear"
Enter
Wait
Show

# A task, claimed, committed and verified.
Type `npx resaledger new "Show prices"`
Enter
Wait
Sleep 1500ms
Hide
Type `demo_plan T1 "Show each loaf's price."`
Enter
Wait
Show
Type "npx resaledger claim T1"
Enter
Wait
Sleep 1500ms
Type `git add -A && git commit -qm "feat: show prices" -m "Task: T1"`
Sleep 300ms
Enter
Wait
Sleep 1500ms
Type "npx resaledger verify"
Enter
Wait
Sleep 3500ms
Hide
Type `demo_done T1 && git add -A && git commit -qm "docs: finish T1" -m "Task: T1" >/dev/null && npx resaledger new "Bake rye" >/dev/null && npx resaledger new "Take orders" >/dev/null && demo_plan T2 "Add rye bread." && demo_plan T3 "Take orders online." && git add -A && git commit -qm "docs: plan T2 and T3" && clear`
Enter
Wait
Show

# Two more lanes, each in its own worktree, then merged without a conflict.
Type "npx resaledger claim T2 --worktree ../rye"
Enter
Wait
Sleep 1s
Type "npx resaledger claim T3 --worktree ../orders"
Enter
Wait
Sleep 1s
Type "npx resaledger work"
Enter
Wait
Sleep 4s
Hide
Type `demo_lane rye T2 rye.js "export const rye = 4" "bake rye" >/dev/null 2>&1 && demo_lane orders T3 orders.js "export const orders = []" "take orders" >/dev/null 2>&1 && clear`
Enter
Wait
Show
Type "git merge -q t2-bake-rye t3-take-orders"
Enter
Wait
Sleep 1500ms
Type "npx resaledger verify"
Enter
Wait
Sleep 3s
Type `git add -A && git commit -qm "chore: stamp the merged code" -m "Task: maintenance"`
Sleep 300ms
Enter
Wait
Sleep 1s
Type "npx resaledger handoff"
Enter
Wait
Sleep 5s
