# Roadmap

AutoSocial Studio is early-stage open source software. The roadmap focuses on
making local creator workflows safer, easier to maintain, and more useful for
builders shipping products with AI coding tools.

## Near Term

- Add a first-run onboarding checklist for local setup, platform login status,
  queue folders, FFmpeg, Playwright Chromium, and yt-dlp.
- Improve dashboard empty states so new users can understand the workflow
  without reading every setup step first.
- Add screenshot-based troubleshooting guides for TikTok, Instagram, and
  YouTube selector breakage.
- Expand local tests around dashboard settings, account state, queue migration,
  and downloader configuration.
- Add release notes and a lightweight changelog process.

## Responsible Automation

- Add scheduler guardrails such as per-platform cooldowns, daily caps, and
  clearer warnings before enabling frequent posting.
- Make platform limits and responsible-use notes visible near automation
  controls, not only in documentation.
- Add safer defaults for newly created accounts and queues.
- Explore official platform APIs where they are available and practical for
  user-consented posting workflows.

## Creator Workflow

- Add campaign templates for product launches, demos, updates, and build-in-
  public content.
- Add reusable caption templates and per-account content presets.
- Add a local review queue before scheduled posts are allowed to publish.
- Improve the video uniquifier controls with preview metadata and clearer
  recipe options.

## Maintainer Tooling

- Use AI coding tools for pull request review, selector-change triage, and test
  coverage suggestions.
- Add automated security and dependency review workflows.
- Build issue templates for platform breakage reports with required logs,
  screenshots, and local environment details.
- Create a small contributor guide for maintaining Playwright selectors across
  changing social media UIs.

## Long Term

- Plugin-style platform adapters so contributors can add or maintain platforms
  without touching unrelated queues and dashboard code.
- Optional API-backed publishing paths for platforms that support official
  upload APIs.
- Cross-platform packaging so non-technical users can run the local dashboard
  with less setup friction.
