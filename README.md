# Easy Apply Copilot (Chrome Extension)

Easy Apply Copilot is a Manifest V3 Chrome extension that helps with job applications by:

- Reading job context from supported job pages.
- Comparing role requirements to your real experience markdown.
- Generating a truthful, tailored resume in markdown with an LLM.
- Converting that markdown to a PDF in-browser.
- Assisting with resume upload and form filling for common Easy Apply flows.

AI access is routed through a local Node bridge that uses `@github/copilot-sdk`.

## Important Behavior And Limits

- This tool is intended to assist your own applications, not impersonate or fabricate credentials.
- It does not guarantee application success.
- It avoids inventing experience by prompting the model to stay grounded in your source markdown.
- Final review remains your responsibility before submission.

## Repository Layout

- `manifest.json`: extension manifest and permissions.
- `src/popup.html`, `src/popup.js`: step-by-step action panel.
- `src/options.html`, `src/options.js`: local settings (bridge URL, model, source markdown).
- `src/background.js`: AI orchestration and payload storage.
- `src/content.js`: page extraction, field fill, resume upload, optional button clicking.
- `src/lib/pdf.js`: lightweight markdown-to-PDF byte generator.
- `bridge/server.mjs`: local HTTP bridge to Copilot SDK.
- `package.json`: bridge dependency and run script.

## Install Locally

1. Install Node.js 20+.
2. Install dependencies:

```bash
npm install
```

3. Start the Copilot bridge:

```bash
npm run bridge
```

4. Open Chrome and go to `chrome://extensions`.
5. Enable **Developer mode**.
6. Click **Load unpacked**.
7. Select this project folder.

Keep the bridge running while using the extension.

## Copilot Authentication

Authorize GitHub for the extension in one of these ways:

1. In extension settings, paste a fine-grained PAT in **GitHub Token**.
2. Click **Verify GitHub Authorization**.

Required PAT permission:

- **Copilot Requests**

Create token page:

```text
https://github.com/settings/personal-access-tokens/new
```

Alternative: authenticate your local Copilot CLI environment and rely on that local auth context.

```bash
copilot
```

Then run `/login` in the CLI and complete auth. The SDK bridge uses your local Copilot auth context.

## Configure

1. Open extension settings from the popup (**Open Settings**) or from the extension details page.
2. Fill:
- **Copilot Bridge Endpoint** (default: `http://127.0.0.1:8787/ai/json`)
- **GitHub Token** (recommended)
- **Model**
- **Attach Experience Markdown Files** (.md, multiple files supported)
- **Additional Markdown Notes** (optional fallback)
- **Truthful Q&A Knowledge Base** (optional JSON map for recurring questions)
3. Save settings.

Example optional Q&A hints JSON:

```json
{
  "work authorization": "Authorized to work in the US, no sponsorship needed.",
  "salary": "Open to a market-competitive package based on role scope.",
  "notice period": "Two weeks notice."
}
```

## Usage Flow

1. Open a supported job page (currently LinkedIn and Indeed selectors are included).
2. Open popup and click **Analyze Current Job**.
3. Click **Generate Tailored Resume**.
4. Click **Assist Easy Apply Form**.
5. Review all fields and attachments before final submission.

If **Allow clicking final Submit buttons automatically** is turned off (recommended), the extension will avoid final submit clicks.

## Supported Sites

- LinkedIn job pages with Easy Apply-style flows.
- Indeed job pages (basic extraction and filling selectors).

Note: Job sites change DOM structure often. You may need to update selectors in `src/content.js` over time.

## Security Notes

- Resume source and bridge URL are stored in Chrome extension storage on your machine.
- The local bridge runs on your machine and forwards requests to Copilot SDK.
- Host permissions are scoped to LinkedIn, Indeed, and localhost bridge URLs.

## Development Notes

- No build step is required for the extension itself.
- Code is plain JavaScript modules compatible with MV3.
- Bridge server imports `@github/copilot-sdk`.

## Troubleshooting

- "Could not extract enough job details": open the job detail page itself and ensure description is visible.
- "Generate tailored resume PDF first": run analysis first, then generation.
- Resume not attached: verify page has a file input and rerun assist while that step is visible.
- "Copilot bridge call failed": ensure `npm run bridge` is running and URL matches extension settings.
- "Auth check failed": verify PAT has Copilot Requests permission and is not expired.
- "Could not import Copilot SDK module": install dependencies and verify package availability in your environment.
- "No such built-in module: node:sqlite" with Bun: the bridge now forces the native `@github/copilot-<platform>-<arch>` binary; restart bridge after pulling latest changes.

Quick connectivity test:

```bash
curl http://127.0.0.1:8787/health
```

Expected response:

```json
{"ok":true,"status":"up"}
```
