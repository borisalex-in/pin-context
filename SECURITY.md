# Security Policy

## Reporting a vulnerability

Please report suspected security vulnerabilities privately to **borisalex.in@yandex.com**. Include the affected Pin Context version, VS Code version, operating system, impact, and reproducible steps where possible. Please do not publish an exploit or open a public issue before the maintainer has had a reasonable opportunity to investigate.

Do not send real credentials, private source code, or an active MCP bridge configuration/token in a report. Redact tokens and workspace paths from logs unless they are essential to reproduce the issue.

## Security-sensitive components

Pin Context provides a local MCP bridge bound to `127.0.0.1`. It uses a random per-run bearer token and stores its configuration with restrictive file permissions. Agent file operations are intended to stay within the opened workspace, and state-changing operations require an explicit Pin Context confirmation unless the operation is an ordinary mutation approved by the in-editor MCP host. Destructive context deletion always requires Pin Context's own confirmation.

Please report issues involving authentication, workspace-boundary validation, confirmation bypasses, bridge lifecycle/cleanup, or untrusted workspace behavior as security-sensitive.

## Supported versions

Security fixes target the latest version published in the Visual Studio Marketplace and the current development branch. Users should update to the latest release before reporting issues that may already have been fixed.
