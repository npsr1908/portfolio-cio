# Changelog

## [1.0.1] - 2026-11-11

### Fixed

- Restored Kite login with the current grouped-tool interface (`session`, `portfolio`, `market`, and `mutual_funds`). Authentication is verified through the session status tool when the older `login` tool is not advertised.
- Mapped existing portfolio, quote, instrument search, and historical-data requests to the current Kite MCP grouped tools while preserving compatibility with the older flat tool names.
- Updated the login handoff page to confirm a verified Kite connection instead of requiring a legacy authorization link.
- Updated historical-data, instrument-search, and quote tool discovery to recognize grouped Kite MCP tools.
