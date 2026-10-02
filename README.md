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

## Features

- Interactive file tree for the working directory where you're using Claude Code

## Settings

Both settings are in `/config` under filetree.

- **Claude activity:** what shimmers: `reads and writes` (default), `writes`, `reads` or `none`. Git status, line counts and the git status at the bottom always show.
- **Glyphs:** `auto` (default) uses Nerd Font icons when a Nerd Font is installed and your terminal started after it was installed, plain Unicode in the desktop app, and Nerd Font over SSH. `nerd` or `plain` forces one.

## License

[MIT](LICENSE)
