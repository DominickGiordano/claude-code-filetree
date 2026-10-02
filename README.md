<h1 align="center">filetree</h1>

<p align="center">
  A FileBlade-style file tree for Claude Code that shows what Claude is doing to your files <br></br>
  <i>Git status, lines changed and a live shimmer on every file Claude reads, writes or commits</i>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Claude_Code-%E2%89%A5_2.1.287-D97757?logo=claude&logoColor=fff" alt="Claude Code 2.1.287 or newer">
  <img src="https://img.shields.io/badge/version-0.2.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/type-mod-6f42c1" alt="Claude Code mod">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
</p>

<p align="center">
  <img src="media/filetree-shimmer.gif" alt="filetree shimmering the file Claude is editing" width="900">
</p>

> [!NOTE]
> filetree is a Claude Code **mod**: a plugin of function hooks with its own pane. Mods need **Claude Code 2.1.287 or newer**, and the pane docks beside the transcript in fullscreen mode.

---

## Installation

The repo is its own plugin marketplace. Run this in the terminal:

```bash
claude plugin marketplace add data-goblin/filetree
claude plugin install filetree@filetree
```

Or inside a Claude Code session:

```text
/plugin marketplace add data-goblin/filetree
/plugin install filetree@filetree
```

The repo is private for now, so installing needs GitHub access through `gh` or your git credentials. Background auto-updates of a private marketplace need `GITHUB_TOKEN` in the environment.

To develop, load a checkout directly: `claude --plugin-dir ~/git/filetree`

## What it shows

- **The cwd Claude is in.** It follows Claude's working folder; `/filetree <path>` pins another folder and `/filetree` with no path goes back to the cwd.
- **Git status in FileBlade colors.** Each file shows its badge (`A ? R C M T D U`, ignored dimmed). Modified files show exact lines changed from `git diff HEAD` as green `+N` and red `-N`; folders and the header show the summed lines plus file counts `?:N M:N D:N`, like the Claude Code status line. The header also shows the branch with ahead/behind.
- **What Claude is doing.**
  - purple: files Claude reads or searches (the Read tool, and Bash `rg`, `grep`, `find`, `cat` and similar)
  - orange: files Claude writes, whether through Edit/Write or a Bash command; collapsed folders open for it and shimmer dimmed
  - green: files Claude commits
- **Git actions.** `git` and `gh` commands show as one status at the bottom right of the pane, with their own icon and color: commit green, push teal, pull/fetch/checkout blue, merge/rebase/PR purple, reset/restore red.
- **Interactive.** Search finds files anywhere under the cwd. Click a name to select it or open a folder, double-click to open a file, and arrow keys move through the tree. The selected file goes with each prompt as context, and `@path` mentions in a prompt reveal that file.

It stays light: no git calls outside a repo until `git init` or `clone`, and inside one every git call is scoped to the cwd and uses `--no-optional-locks`.

## Settings

Both settings are in `/config` under filetree.

- **Claude activity:** what shimmers: `reads and writes` (default), `writes`, `reads` or `none`. Git status, line counts and the git status at the bottom always show.
- **Glyphs:** `auto` (default) uses Nerd Font icons when a Nerd Font is installed and your terminal started after it was installed, plain Unicode in the desktop app, and Nerd Font over SSH. `nerd` or `plain` forces one.

## License

[MIT](LICENSE)
