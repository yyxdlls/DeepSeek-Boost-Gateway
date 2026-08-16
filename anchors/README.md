# Anchor artifacts

This directory stores immutable, versioned trajectory artifacts selected by the
Anchor Builder. An artifact is accepted only when one assistant trajectory:

1. calls `bash` exactly once;
2. receives the deterministic synthetic repository listing;
3. calls `str_replace_editor` exactly once in a later assistant turn, using
   read-only `view` on `/repo/README.md`;
4. receives the deterministic README contents; and
5. returns a final answer.

Trajectory wording (`We need`, `Let me`, and related classifications), block
lengths, and token usage are recorded as observations only. They do not make a
candidate pass or fail; the user decides whether a generated trajectory is a
useful anchor.

The builder never executes model-generated shell or editor actions on the host.
Each tool result comes from an in-memory fixture. A frozen artifact is written
with create-only semantics and cannot be overwritten by another run.

Passing this gate proves protocol shape and reproducibility only. It does not
prove that replaying the artifact improves downstream coding quality; that
requires a separate held-out Anchor-versus-control evaluation.
