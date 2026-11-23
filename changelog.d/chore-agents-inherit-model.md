### Changed

- The `code-reviewer` agent definition now sets `model: inherit`, so it runs on the model of the
  session that launched it. The Codex mirror is unchanged, because the generator drops `model:`.
  No site behavior changes.
