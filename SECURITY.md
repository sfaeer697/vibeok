# Security

## Reporting a vulnerability

Please don't open a public issue. Email **hello@tryvibeok.site** with the details and steps to reproduce. You'll get a reply within 3 working days.

## What VibeOK does and doesn't do

- It runs entirely on your machine. The CLI and MCP server make no requests to VibeOK servers.
- With `--ai`, your findings (URLs, status codes, short response snippets) are sent to the AI provider whose key you set, and nowhere else.
- It clicks buttons and can submit forms. It refuses non-local URLs unless you confirm you own the app, and skips buttons that look destructive. Point it at a development or test environment.
