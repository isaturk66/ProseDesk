# ProseDesk

A Word-style editor with Claude Code built in, for writing where you want to stay in control of every sentence.

Most AI coding tools are built to take a task and run with it. Writing needs the opposite: you write, you highlight a sentence, you ask "fix this" or "what's weak here?", and you decide what goes in. ProseDesk does that. Claude edits your document, and every edit arrives as a **tracked change** (red strikethrough, green insertion) that you accept or reject, as in Google Docs or Word.

![ProseDesk: document with tracked changes on the left, Claude chat on the right](assets/screenshot.png)

## Features

- **A real editor.** Fonts, sizes, colors, highlight, headings, lists, alignment, line spacing, print / save as PDF.
- **Claude in a side panel.** Whatever you highlight is attached to your message automatically.
- **Ctrl+K inline requests.** Select text, press Ctrl+K, type what you want, done.
- **Edit mode and Ask mode.** Edit lets Claude change the document. Ask only answers and never touches your text.
- **Tracked-change review.** Accept or reject each change, or all at once. Nothing reaches your document without your approval.
- **Folder = workspace.** Run `prosedesk` in a folder and Claude works there, so it can read your notes, sources and PDFs.
- **Plain files.** Documents are `.html` files on disk. Claude edits them with its normal tools, and you can also edit them from a terminal Claude Code session.
- **Version history.** Every version is kept in a private git history: while you write, before Claude edits, and after each review. You can restore any version, all of it or just the parts you want.
- **Dictation.** A mic button in the chat and the Ctrl+K box: press, talk, press again. It uses OpenAI's transcription if you add a key, otherwise the browser's built-in speech recognition.
- **Runs on your Claude Code login.** No Anthropic API key. It uses your existing Claude Code subscription, settings and usage limits.

## Requirements

- [Node.js](https://nodejs.org) 20 or newer
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and logged in (the `claude` command works in your terminal)
- [git](https://git-scm.com), for version history (everything else works without it)
- Optional: an [OpenAI API key](https://platform.openai.com/api-keys) for high-quality dictation

## Install

```sh
git clone https://github.com/isaturk66/ProseDesk.git
cd ProseDesk
npm install
npm link        # makes the `prosedesk` command available everywhere
```

To uninstall the command later: `npm unlink -g prosedesk`.

## Usage

Go to the folder you're writing in and run:

```sh
prosedesk                 # open this folder and pick a document
prosedesk essay.html      # open (or create) essay.html in this folder
prosedesk week3/essay     # a document in a subfolder (the workspace stays here)
prosedesk ../other-project # open another folder
```

Your browser opens the editor. Stop it with Ctrl+C in the terminal, or from anywhere:

```sh
prosedesk list      # show running instances
prosedesk stop      # stop the one for the current folder
prosedesk stopall   # stop all of them
```

If ProseDesk is already running when you start it, it asks whether to open the running one, stop it and start fresh, or start another on a free port.

Try it on the bundled example: `npm run example`.

### The folder is the workspace

The editor works with the `.html` documents in the folder and its subfolders. The built-in Claude session starts **in that folder**, just like running `claude` there. Everything else in the folder is reference material Claude can read:

```
my-article/
├── draft.html          ← your document (shown in the editor)
├── brief.md            ← what the piece needs to do
├── sources/
│   ├── smith-2021.pdf
│   └── interview-notes.md
└── CLAUDE.md           ← optional: standing instructions for Claude
```

At the start of each conversation Claude gets a list of the folder's files. When a question depends on them ("does this cover the brief?", "what did Smith find?"), it reads them rather than guessing, and it tells you which file it used.

A `CLAUDE.md` in the folder is picked up automatically. It's a good place for things like the audience, the citation style, the word limit, or "British spelling".

### Version history

ProseDesk keeps versions of each document:

- every 30 seconds while you're writing (only when something changed)
- right before Claude edits, labelled with your request
- when you finish reviewing changes ("Accepted Claude's changes", "3 accepted, 1 rejected", and so on)
- before an edit from outside the editor, such as a terminal Claude Code session

Open the **History** tab next to the chat and click a version. It appears as tracked changes against your current document. **Restore all** brings the whole version back, or accept and reject individual differences to restore only some of it. Restoring is recorded too, so you can always go back.

The history lives in a hidden `.prosedesk/` folder inside your documents folder. It's a separate git repository, so it never interferes with a git repo of your own. It ignores itself, so it won't show up in your `git status`. Delete the folder to delete the history; your documents aren't affected. Change the interval with `PROSEDESK_AUTOSAVE_SECONDS`.

### Finding documents

Click the path at the top left (or press **Ctrl+P**) to open the file explorer:

- **Search.** Start typing to fuzzy-search every document in every subfolder (`dr2` finds `week2/drafts/draft2`).
- **Browse.** A folder tree with your recent documents at the top. Folders without documents are hidden unless you tick **Show all files**, which also lists reference files like PDFs.
- **Create.** Type a name that doesn't exist and press Enter. Use `/` for subfolders (`week4/intro`); missing folders are created. **+ New document** starts a name in the selected folder.
- **Keyboard.** ↑/↓ to move, Enter to open, ←/→ to collapse and expand folders, Esc to close.

When you run `prosedesk` without a file name, the explorer opens first. Nothing is created until you ask for it.

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+P | Open the file explorer |
| Ctrl+K | Inline request on the selection (or the current paragraph). Enter = edit, Ctrl+Enter = ask |
| Ctrl+L | Jump to the chat box |
| Ctrl+S | Save (it also autosaves) |
| j / k or ↓ / ↑ | While reviewing: next / previous change |
| y / n | While reviewing: accept / reject the focused change |

Click any change to get Accept / Reject buttons. The bar at the bottom has Accept all and Reject all.

### Dictation

Click the mic next to **Send** (or inside the Ctrl+K box), talk, and click it again to stop. The text is inserted where your cursor is, so you can edit it before sending. Pressing Enter while recording also stops it.

For the best results, add an OpenAI key. Copy `.env.example` to `.env` in the ProseDesk folder and fill it in:

```sh
OPENAI_API_KEY=sk-...
OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe   # or gpt-4o-mini-transcribe (cheaper)
OPENAI_PROXY=                               # optional: http://host:port if OpenAI isn't available in your region
```

The file is read on every request, so a new key works after a page reload. Without a key, the mic falls back to the browser's own speech recognition (Chrome and Edge), which is free but less accurate, especially with punctuation or mixed languages.

### Options

```
prosedesk [file.html | folder] [--no-open] [--port N] [--model NAME]
```

| Option | Meaning |
| --- | --- |
| `--model sonnet` | Model for the built-in chat (default: your Claude Code default). Also `PROSEDESK_MODEL` |
| `--port 5200` | Port (default 5178; the next free port is used if it's taken). Also `PORT` |
| `--no-open` | Don't open the browser |
| `--new` | Start another instance without asking, even if one is already running |

You can run several instances in different folders at the same time.

## Using Claude Code from a terminal as well

The editor watches the file, so edits from **any** source show up as tracked changes, including a normal `claude` session you run in the same folder.

To let that terminal session see what you've highlighted in the editor, add this hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "prosedesk --hook" }] }
    ]
  }
}
```

Now "rewrite this" in the terminal refers to your current selection. The hook only prints something when the editor is open on the same folder.

## How it works

```
 Claude Code (headless)             Browser editor (TipTap)
        │ edits the file                   ▲ shows tracked changes
        ▼                                  │
    essay.html ◄──── file watcher ────► local server (Node)
```

- **Server** (`server.mjs`). Serves the editor (built into `dist/` on first run and whenever the source changes), watches the folder, keeps the version history (`history.mjs`), and runs `claude -p` in streaming JSON mode as one ongoing conversation. Claude loads your normal Claude Code settings but gets file tools only (Read, Edit, Write, Glob, Grep). It has no shell and no MCP servers, and edits are auto-approved because you review them in the editor anyway.
- **Editor** (`src/`). Built on [TipTap](https://tiptap.dev) / ProseMirror. When the file changes on disk, the editor compares it with your last accepted version (`src/diff.js`). Unchanged paragraphs are matched and edited ones are paired by similarity, then diffed word by word. The result is rendered with insertion and deletion marks. Accepting or rejecting a change edits those marks, and once everything is resolved the result is saved back to the file.
- **Instructions** (`prompt.md`). Appended to Claude's system prompt: make small targeted edits, keep the user's voice, don't invent sources, and in Ask mode never edit.

## Limitations

- Documents are HTML. Export by printing to PDF. For `.docx`, open the PDF or HTML in Word, or convert with a tool like [pandoc](https://pandoc.org).
- The document is read-only while a review is pending.
- If Claude changes only formatting (no text), the change is applied without review.
- Line spacing is a view setting per document and isn't stored in the file.
- Tables and images aren't in the toolbar yet.
- Built and tested on Windows with Chrome. It should work elsewhere, but that's untested.


## License

[MIT](LICENSE)
