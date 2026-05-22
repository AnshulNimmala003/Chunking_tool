# CLAUDE.md — Standing Instructions for AI Sessions

These rules apply to every coding session in this project. Follow them exactly.

---

## Mandatory: Document Every Code Change in CHANGES.md

**Every change to any file — no matter how small — must be appended to `CHANGES.md` at the time it is made.**

### Required format for each entry

```
## YYYY-MM-DD HH:MM

### <Short title describing what changed>

**File:** `path/to/file.ext`
**Lines affected:** 42–57

**Previous code:**
```language
42 | <exact previous code with line numbers>
```

**New code:**
```language
42 | <exact new code with line numbers>
```

**Reason:** One sentence stating why this change was necessary.

**Explanation:**
1. **The problem.** What was wrong and why it mattered — written so anyone on the team can understand it without looking at the code.
2. **What changed.** Exactly what was modified, added, or removed, and why that approach was chosen.
3. **Result.** What the app does now as a result — the observable difference from the user's or system's perspective.
```

### Rules

- **Date/time** uses local time, 24-hour format (`YYYY-MM-DD HH:MM`).
- **Previous code** must be the exact lines before the edit, with line numbers prefixed (`42 |`). For new files, write "File did not exist."
- **New code** must be the exact lines after the edit, with line numbers. For deleted files, write "File deleted."
- If a change touches multiple files, repeat the File/Lines/Previous/New block for each file under the same dated entry.
- **New entries go at the bottom** — chronological order, oldest first.
- The three explanation paragraphs must use plain language — no jargon, no unexplained abbreviations. A non-technical team member must be able to read them and immediately understand the issue and the fix without needing to look at the code.
- Do not summarise multiple changes into one entry unless they were made atomically as part of a single logical operation.

---

## General Coding Rules

- Never modify the original `human in loop chunkng ` project when working in `hitl-chunking-hifi`, and vice versa.
- Before modifying any file, read it first to get accurate current line numbers for the changelog.
- Do not add features, refactors, or abstractions beyond what the task requires.
- Do not add comments that explain what the code does — only add comments for non-obvious constraints or workarounds.
- Default to writing no new files unless explicitly required. Prefer editing existing ones.
- Run `node -e "require('./routes/...')"` to verify any new backend module loads without errors before reporting the task complete.
