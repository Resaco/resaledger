# Sourced by demo.tape: the steps the demo hides, so that it shows only what a person types.
demo_readme() {
  printf '# Bakery\n\n## Goal\n\nOrders for next-morning pickup.\n\n## Environments\n\nLocal only.\n\n## Manual checks\n\nNone.\n' > ledger/README.md
}
demo_plan() {
  printf '\n## Plan\n\n%s Check: npm test.\n' "$2" >> "$(ls ledger/tasks/"$1"-*.md)"
}
demo_done() {
  node -e '
    const fs = require("fs")
    const file = fs.readdirSync("ledger/tasks").find((name) => name.startsWith(process.argv[1] + "-"))
    const path = "ledger/tasks/" + file
    const text = fs.readFileSync(path, "utf8").replace(/^- Evidence:.*\n/m, "")
    fs.writeFileSync(path, text.replace("- Status: doing", "- Status: done\n- Evidence: `npm test` passed"))
  ' "$1"
}
demo_lane() {
  ( cd "../$1" && echo "$4" >> "src/$3" && git add -A && git commit -qm "feat: $5" -m "Task: $2" && demo_done "$2" && git add -A && git commit -qm "docs: finish $2" )
}
