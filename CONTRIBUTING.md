# Contributing

Thanks for helping improve AutoSocial Studio.

## Development Setup

```bash
npm ci
npx playwright install chromium
npm run doctor
npm run check
```

Start the local dashboard with:

```bash
npm run dashboard
```

Open http://localhost:3028.

## Before Opening a Pull Request

Run:

```bash
npm run check
npm audit --omit=dev
```

For changes that touch upload automation, also test the relevant platform flow
manually with a throwaway account or safe draft workflow. Platform selectors
change often, so include screenshots or logs when reporting upload breakage.

## What To Avoid Committing

Do not commit session data, queue media, downloaded videos, `.env`, debug
screenshots, yt-dlp metadata, or browser profiles. The `.gitignore` covers the
known runtime paths, but always check `git status --short` before committing.

## Code Style

- Keep changes small and tied to one behavior.
- Prefer existing CommonJS patterns used in the repo.
- Add tests for queue, scheduler, filesystem, config, and API behavior when the
  change can be tested without real social platform access.
- Avoid broad selector rewrites unless you have verified the current platform UI.

## Responsible Use

This project is for local automation workflows. Contributors should avoid
features that encourage spam, deceptive behavior, account abuse, or posting
content without rights.
