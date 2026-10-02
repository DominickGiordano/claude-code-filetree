# filetree

Claude Code plugin (2.1.287+): a FileBlade-style file tree of the session cwd, docked beside the transcript.

- follows the cwd Claude is in; `/filetree <path>` pins another folder, `/filetree` follows again
- git status per file with FileBlade colors and badges (`A ? R C M T D U`, ignored dimmed), lines changed as green `+N` and red `-N`, rolled up into folders, branch with ahead/behind and a repo total in the header
- shimmers whatever Claude touches: Edit/Write/NotebookEdit paths, and files a Bash command changed (marker file + `find -newer`); collapsed folders open for it and shimmer dimmed
- `git`/`gh` commands show as activity rows with their own icon and color while they run (commit green, push teal, pull/fetch/checkout blue, merge/rebase/PR purple, reset/restore red); committed files shimmer green, the branch row shimmers on push, pull, checkout and similar
- no git calls outside a repo until `git init`/`clone` or a `.git` appears; inside one every git call is scoped to the cwd (`-- .`), uses `--no-optional-locks`, and line counts of untracked files are capped
- click a name to select or toggle, double-click to open (`gio open`) or to root the tree at a folder; the selected file goes with each prompt as context, and `@path` mentions in a prompt shimmer cyan
- header icons: up, follow cwd, refresh, dotfiles, collapse, unselect; FileBlade Nerd Font icons fall back to plain Unicode when no Nerd Font is installed

Load it: `claude --plugin-dir ~/git/filetree`
