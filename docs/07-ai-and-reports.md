# 07 — AI assistant & email reports

The dashboard has an "Assistant" tab on each device page. It lets the user:

1. Chat about the device's recent readings (last 7 days of data are sent to Claude as context).
2. Click **File a report** to save the conversation with an AI-generated summary.
3. Type an email address and **Email it** to anyone (community health officer, school principal, etc.).

This page shows you how to plug in the two external services this needs: an Anthropic API key (for the AI) and an SMTP account (for email).

## 1. Get an Anthropic API key

1. Go to <https://console.anthropic.com/> and sign in (or sign up).
2. Click **API Keys → Create Key**. Name it `weather-station`.
3. Copy the `sk-ant-...` value — you won't see it again.
4. Top up a small amount of credit (a few dollars is plenty for testing).
5. In `backend/.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
   ANTHROPIC_MODEL=claude-sonnet-4-6
   ```

## 2. Set up SMTP for email

The easiest free option is Gmail with an **App Password**. A normal Gmail password won't work — Google blocks it.

1. Turn on 2-step verification on your Google account: <https://myaccount.google.com/security>.
2. Once 2-step is on, go to <https://myaccount.google.com/apppasswords>.
3. Create an app password, name it `weather-station`. Google shows you a 16-character password (no spaces).
4. In `backend/.env`:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_SECURE=true
   SMTP_USER=your.email@gmail.com
   SMTP_PASS=the16charapppassword
   SMTP_FROM="Weather Station <your.email@gmail.com>"
   ```

If you'd rather not use Gmail, other easy options:

- **Resend** (<https://resend.com>): `SMTP_HOST=smtp.resend.com` `SMTP_PORT=465` `SMTP_USER=resend` `SMTP_PASS=<your API key>`. 100 emails/day free.
- **Brevo (formerly Sendinblue)**: similar, 300/day free.

## 3. Install the new packages

```
cd backend
npm install
```

`npm install` will pull in `@anthropic-ai/sdk` and `nodemailer`, which are now in `package.json`.

Restart the backend:
```
npm run dev
```

## 4. Try it out

1. Open the dashboard, go to any device → **Assistant** tab.
2. Ask something like *"What was the average humidity yesterday?"* — you should get a data-grounded answer within a couple of seconds.
3. Click **File a report from this conversation**, give it a title, **Save**.
4. Type any email address, click **Email it**. Check the inbox.

## 5. Deploying these env vars to Render

When you deploy in doc 05, don't forget to add the same env vars to Render:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`

Render dashboard → your service → **Environment → Add Environment Variable**.

## How it works under the hood

- `POST /api/ai/query` loads the last ~2000 readings from the last 7 days for that device, computes per-sensor min/max/avg, and injects them into a system prompt for Claude. Claude's answer is returned to the browser. The chat history is kept in the frontend state (not in the DB) until the user files a report.
- `POST /api/ai/reports` saves the conversation as a `Report` document and asks Claude for a one-paragraph executive summary which is saved too.
- `POST /api/ai/reports/:id/email` renders the report as HTML and sends it via SMTP using nodemailer. The recipient address is tracked on the report document.

## Cost & rate limit notes

- A single question costs maybe $0.005 on Claude Sonnet. A chatty user doing 100 queries/day is well under $1.
- Rate limiting: currently there's no per-user cap on AI calls. If you open the dashboard to the public, add an `express-rate-limit` on `/api/ai` similar to `/api/auth`.
