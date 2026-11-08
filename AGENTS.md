# Repository work

Read README.md and docs/development.md before edits.

- web/: browser UI; server/: deployed FastAPI; knowledge/: chatbot reference documents.
- tests/web/ and tests/server/: automated checks; ops/: port 8501 service; docs/: project documentation.
- Preserve the public URLs, the runtime database/media under /data/Documents/Codex/.runtime/fieldnote/data, and the local API secrets at frontend/dispatch/.env. The old frontend folder is ignored local configuration only.
- Use synthetic data for tests. Do not commit secrets, user records, photos, signatures, caches, or generated reports.
- Test changes, commit and push main; verify the port 8501 deployment.
- docs/archive/ and docs/development-plan.md contain historical material. Current code and README take precedence.
- Installed development skills are under .agents/skills; read a relevant skill before using it.
