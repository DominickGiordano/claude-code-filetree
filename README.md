# filetree

Claude Code plugin (2.1.287+): a FileBlade-style file tree of the session cwd, docked beside the transcript.

- follows the cwd Claude is in; `/filetree <path>` pins another folder, `/filetree` follows again
- git status per file with FileBlade colors and badges (`A ? R C M T D U`, ignored dimmed); modified files show exact lines changed (`git diff HEAD`) as green `+N` and red `-N`; new files show no line count. Folders and the header show the summed lines of their modified files plus file counts `?:N M:N D:N`, as the Claude Code status line does; the header also has the branch with ahead/behind
- shimmers whatever Claude touches: Edit/Write/NotebookEdit paths, and files a Bash command changed (marker file + `find -newer`); collapsed folders open for it and shimmer dimmed
- `git`/`gh` commands show as one status on the footer row (bottom right, beside `selected:`), with its own icon and color (commit green, push teal, pull/fetch/checkout blue, merge/rebase/PR purple, reset/restore red); committed files shimmer green, the branch row shimmers on push, pull, checkout and similar
- no git calls outside a repo until `git init`/`clone` or a `.git` appears; inside one every git call is scoped to the cwd (`-- .`) and uses `--no-optional-locks`
- click a name to select or toggle, double-click to open (`gio open`) or to root the tree at a folder; the selected file goes with each prompt as context; `@path` mentions in a prompt reveal that file and move the row highlight onto it
- header icons: up, follow cwd, refresh, dotfiles, collapse, unselect; FileBlade Nerd Font icons fall back to plain Unicode when no Nerd Font is installed

Load it: `claude --plugin-dir ~/git/filetree`
