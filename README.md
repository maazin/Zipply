# Zipply

**Zip through applications.** A Chrome extension that fills out job applications from one saved profile on any applicant tracking system (Workday, iCIMS, Greenhouse, Lever, Ashby, or a company's own form), tells you whether a job is worth your time before you start, and logs every submitted application to a Google Sheet automatically.

Built by [Maazin Shaikh](https://www.linkedin.com/in/maazin-shaikh).

- **One profile, one click.** Drop in your resume once. Press **Fill this page** (or `Alt+Shift+F`) on any application. Multi-page flows keep filling as you advance. Zipply never clicks Next or Submit.
- **Works on any form.** Dedicated adapters for the five big ATS platforms, plus a rule-based matcher that reads any unknown form. AI only fills the gaps, and it never sees your personal values.
- **Before you apply.** An Apply, Maybe or Skip verdict, a match score with the keywords you can add (and the real gaps you shouldn't fake), red flags, an already-applied warning, and an ATS readability grade for each resume.
- **A tracker that keeps itself current.** Confirmed submissions append a row to a sheet Zipply creates, with a Dashboard tab of plain formulas. Optional Gmail sync moves each application's status forward.
- **$0 to run.** On-device Gemini Nano handles anything private; Gemini's free API tier writes drafts. Rules run first, so most fills never call a model.

## How it works

```
 ┌──────────── job site tab ─────────────┐        ┌──────── service worker ────────┐
 │ content script                        │  msgs  │ Sheets API  ◄── retry queue    │
 │  adapter (Workday/iCIMS/GH/Lever/     │ ─────► │ Gmail API (read-only, 2 h)     │
 │  Ashby) or rule-based fallback        │        │ AI router: Flash → Flash-Lite  │
 │  fills fields, detects confirmation   │ ◄───── │            → Nano → you        │
 └───────────────────────────────────────┘ profile└──────────────┬─────────────────┘
 ┌──────── side panel ──────┐  ┌──── Profile page ────┐           │
 │ verdict, match, red flags│  │ entered once, autosave│   IndexedDB + chrome.storage
 │ Fill this page, review   │  │ resumes, answer bank  │   (AES-GCM encrypted)
 └──────────────────────────┘  └───────────────────────┘
```

No server. Your data stays in this browser and your own Google account.

### Filling a page

1. **Adapter mappings.** Each ATS module keys on stable markup (`data-automation-id` on Workday, `job_application[...]` on Greenhouse, `urls[LinkedIn]` on Lever, `_systemfield_*` on Ashby, `PersonProfileFields.*` on iCIMS).
2. **Repeating sections.** On Workday, one work-history and education block is added per entry, including month/year date inputs.
3. **Rules and the answer bank.** Every other input is scored against every profile field using weighted signals: `autocomplete` 1.00, `<label>` 0.97, `aria-label` 0.93, `name` 0.86, `id`/placeholder 0.80, nearby text 0.62, plus a synonym dictionary ("Surname" = "Last name"). Fields and profile values are paired across the whole form at once with the Hungarian algorithm, so two fields can't both claim "Phone". Questions you've answered before come from the answer bank.
4. **AI field mapper** for anything still below the confidence threshold. It gets field labels, option lists and the *names* of profile keys, and can only answer with a key from a fixed list. Values are filled locally.
5. **Drafts** for open-ended questions (optional). They're marked **Draft** in the panel, and a second pass flags any claim the profile doesn't support.

Values are set the way a person would: native setter, `input` and `change` events, then blur. That way React, Angular and Workday's live validation all register them. Sensitive answers (work authorization, sponsorship, salary, EEO) are never guessed: unset means left empty and flagged. Consent and attestation checkboxes are never ticked.

### The panel

Every field is listed as filled (green), to check (amber), or skipped (gray). Required fields still empty are red. Click a row to scroll to the field. The only visual Zipply adds to a job site is a brief outline when you click a row; otherwise there's just a small dot on the toolbar icon when a form is found.

## Setup

Requires Chrome 120+ and Node 20.19+.

```bash
npm install
```

```bash
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `dist` folder. The Profile page opens on install.

For development with hot reload, run `npm run dev` and load `dist` the same way.

### Google sign-in (Sheets and Gmail)

Chrome extensions use their own OAuth client. You'll need a free Google Cloud project with **no billing account**.

1. Load the extension once and copy its ID from `chrome://extensions`. To keep the ID stable across machines, pack it once (**Pack extension**), copy the `key` from the packed `manifest.json`, and put it in `.env` as `VITE_EXTENSION_KEY`.
2. In [Google Cloud Console](https://console.cloud.google.com/), create a project, enable the **Google Sheets API** and **Gmail API**, and set up the OAuth consent screen (External, Testing) with your own account as a test user.
3. Create credentials: **OAuth client ID → Chrome Extension**, with the extension ID from step 1.
4. Copy `.env.example` to `.env`, set `VITE_GOOGLE_CLIENT_ID`, and rebuild.
5. On the Profile page, under **Connections**, click **Sign in with Google**. Zipply creates one sheet and, with the `drive.file` scope, can only touch files it created.

`gmail.readonly` is a restricted scope. That's fine for personal use with your account as a test user; a public release would need Google's security review.

### Gemini (free)

Get a key from [Google AI Studio](https://aistudio.google.com/apikey) in a project with no billing account, so a paid call is impossible. Paste it under **Connections**. Model IDs default to `gemini-flash-latest` and `gemini-flash-lite-latest`, so newer free models are picked up automatically; change them there if you prefer. The settings page shows today's call count per model against the free limit. When Flash runs out, the router falls back to Flash-Lite, then Nano, then leaves the field for you.

Gemini Nano runs through Chrome's built-in Prompt API when your laptop supports it (22 GB free disk, and over 4 GB of GPU memory or 16 GB RAM). Without it, those jobs fall back to rules and your review. Zipply works with no AI at all.

## Before-you-apply checks

All rule-based, in the browser, with no AI calls.

| Check | How |
| --- | --- |
| Match score | `0.55 × keyword match + 0.25 × skills coverage + 0.20 × section completeness` (Resume-Matcher's weights). Required terms count double; matching is whole-word plus synonyms, so "JS" counts for "JavaScript" and "Java" never matches inside it. |
| Can add / Real gap | A missing keyword is **Can add** if it's in your profile or another resume, otherwise a **Real gap**. Only Can add terms become tips. |
| Verdict | Role fit, Level, Logistics, Pay. **Apply** at 70+ with nothing failing, **Maybe** at 50 to 69 or one warning, **Skip** below 50 or on a hard blocker (no sponsorship when you need it, a blocklisted company, a clearance you don't have). Thresholds are editable. Skip never blocks filling. |
| Red flags | Posted 30+ days ago, same title already in your sheet within 90 days, no salary range or one wider than 50% of its floor, a vague posting, contract wording when you want full-time. Shown as High confidence / Proceed with caution / Suspicious; never changes the score. |
| Already applied | Instant lookup by company and job ID or posting URL, plus a softer "Possibly applied" for the same company and a near-identical title within 60 days. |
| ATS readability | pdf.js text layer (200+ characters per page), email and phone as plain body text, under 1% broken or ligature characters, reading order across columns, Experience / Education / Skills headings, keyword coverage on the extracted text. Graded Good, Fix or Broken. |

## Tracking

Each confirmed submission appends a row: Application ID, Date applied, Company, Job title, Location / remote, Job ID, ATS, Posting URL, Resume used, Match score, Verdict, Red flags, Status, First reply, Last status change, Notes. Duplicates are skipped. Submissions are detected by the confirmation page, not the button click, so failed submits aren't logged. Failed writes wait in a local queue and retry on browser start and every 15 minutes. **Log this job** in the panel covers anything detection misses.

The **Dashboard** tab is built from formulas when the sheet is created: applications in the last 7 and 30 days, per week for 12 weeks (with a chart), a 7 × 12 activity calendar, status funnel, response and interview rates, median days to first reply, results by verdict, and applications going stale.

**Gmail sync** (optional, read-only) checks every 2 hours. It searches the last 30 days of mail from ATS senders and companies in your sheet, and matches each email to one application by sender domain, company and title or job ID. Status only moves forward (Applied → Received → Assessment → Interview → Offer); Rejected can follow any stage. A conflict with a final status goes to manual review, and an Offer is flagged for your decision, never acted on. Emails the rules can't place go to Nano on the device; anything still unclear is listed in the panel for you to assign. Each message is processed once. Nothing from Gmail is stored except the resulting status and date.

## Privacy and security

- Profile, resumes, answer bank and the Gemini key are encrypted with AES-GCM. Set a passphrase on the Profile page and the key is derived from it (PBKDF2, 310k iterations) and kept only in session memory. Without one, a random device key is used.
- OAuth tokens are managed by `chrome.identity` and never written to storage by Zipply.
- Content scripts run automatically only on the five ATS hosts. Anywhere else, they run only when you open the panel on that page (`activeTab`), or after you allow a site.
- **AI data rules.** Google's free API tier may use prompts to improve its products, so nothing personal goes to it. Field mapping sends labels only. Writing prompts carry a redacted profile with no name, contact details, address, EEO answers or salary. Resume text and email content go to Gemini Nano on the laptop only, unless you turn on the cloud fallback for unclear emails. Postings are treated as untrusted input and passed as quoted data.
- **Network lock.** The production content security policy only allows connections to Google's OAuth, Sheets, Gmail and Gemini endpoints.
- Export and delete-all buttons are on the Profile page.

## Development

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run test:e2e
```

- `src/core` holds pure logic (matcher, scores, Gmail rules, sheet layout, prompts), unit-tested with Vitest.
- `src/content` is the content script: the form reader, value setters and one adapter per ATS behind a shared `detect / explicit / posting / isConfirmation / fillRepeating` interface. Vitest runs it against saved ATS forms in `tests/fixtures`.
- `src/background` is the service worker: Google auth, Sheets, Gmail, the retry queue and the AI router.
- `src/sidepanel` and `src/options` are the React UIs (Tailwind, automatic light and dark mode).
- `e2e/` loads the built extension in Chromium with Playwright and fills fixture forms served at their real ATS hostnames.

Stack: Manifest V3, TypeScript, Vite + CRXJS, React, Tailwind, Dexie, pdf.js, mammoth, `@google/genai`, Vitest, Playwright.

## Credits

This project builds on the work of these open-source projects. Thank you to their authors.

- [Resume-Matcher](https://github.com/srbhr/Resume-Matcher) by srbhr (Apache-2.0): match score formula, whole-word keyword matching, and section completeness, ported from ats.py.
- [career-ops](https://github.com/santifer/career-ops) by santifer (MIT): fit dimensions, apply threshold, and posting-legitimacy signals, adapted from modes/oferta.md.
- [ai-job-search](https://github.com/MadsLorentzen/ai-job-search) by MadsLorentzen (MIT): ATS text-layer checks, Gmail status phrase rules, and stale-application flags.
- [Auto_job_applier_linkedIn](https://github.com/GodsScion/Auto_job_applier_linkedIn) by GodsScion (MIT): already-applied lookup, company blocklist, and word filters.
- [JobSync](https://github.com/Gsync/jobsync) by Gsync (MIT): dashboard metrics and activity calendar.

Ideas (no code) from FormFilla (Hungarian matching, abbreviation dictionary), job_app_filler (Workday commit-on-blur), OpenJobAutofill (labels-only AI), fillwright (weighted signals, network lock), dear-hiring-manager (readable profile file, voice samples) and OpenResume (in-browser parsing).

Full license texts are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE) © 2026 Maazin Shaikh
