# Security Policy

AutoSocial Studio is designed as a local workstation tool. It is not a hosted
multi-user web application.

## Local Dashboard

The dashboard binds to `127.0.0.1:3028` only and has no authentication layer.
Keep it on localhost unless you add your own network controls.

Mutating dashboard requests reject cross-origin browser requests using Origin,
Referer, and Fetch Metadata headers. This reduces accidental local CSRF
exposure, but it is not a replacement for authentication or network isolation.

Binding to a non-local address is not supported. Requests with a non-local socket, unapproved Host header, or non-matching Origin are rejected.

## Sensitive Local Data

The following paths can contain credentials, session cookies, downloaded media,
runtime state, or debug artifacts and should not be committed:

- `.env`
- `.profile/`
- `.profile-instagram/`
- `.profile-youtube/`
- `.profiles/`
- `.scheduler-state/`
- `.runtime/`
- `flow-config/` (Gemini API keys and generated phrase history)
- `accounts-state.json`
- `account-vault.json` and `account-vault.json.bak` (DPAPI-encrypted email recovery data and passwords)
- `*-state.json`
- `queue/`
- `downloads/`
- `user-assets/`
- `autodownload/downloads/`
- `autodownload/profile_downloads/`
- `autodownload/info.json`
- `autodownload/*.info.json`
- `last-*.png`

Before publishing a fork, run a local secret/runtime scan and inspect
`git status --ignored` for surprises.

## Reporting Vulnerabilities

Please do not open public issues for vulnerabilities that expose secrets,
credentials, or session data. If the repository owner has not published a
private reporting channel yet, open a minimal issue asking for a security
contact without including exploit details.

## Responsible Use

Users are responsible for complying with platform terms, local law, rate limits,
account policies, and content rights. This project does not grant permission to
post content you do not own or have permission to use.
