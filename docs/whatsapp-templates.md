# WhatsApp message templates

Submit these in WhatsApp Manager (Meta Business Suite) before going live. Names, languages and the
order of `{{n}}` parameters must match `packages/integrations/src/whatsapp.ts` exactly. Approval
usually takes 24–48 hours. Hindi variants can be added later as extra languages of the same name.

Free-form replies (Sales Agent and staff) need no template, but WhatsApp only allows them within
24 hours of the customer's last message. Everything we start ourselves uses a template below.

| Key in code | Template name | Category | Parameters |
|---|---|---|---|
| `lead_received` | `lead_received_v1` | Utility | 1 first name |
| `stage_changed` | `project_update_v1` | Utility | 1 first name, 2 update phrase, 3 status link |
| `quote_sent` | `proposal_ready_v1` | Utility | 1 first name, 2 system kW, 3 subsidy, 4 proposal link |
| `bill_resubmit` | `bill_resubmit_v1` | Utility | 1 first name, 2 what was wrong |
| `payment_link` | `payment_link_v1` | Utility | 1 first name, 2 amount, 3 payment link |
| `payment_received` | `payment_received_v1` | Utility | 1 first name, 2 amount, 3 status link |
| `loan_status` | `loan_update_v1` | Utility | 1 first name, 2 status word, 3 status link |
| `otp` | `login_code_v1` | Authentication | 1 code (plus copy-code button) |

## Bodies (English)

**lead_received_v1**
> Namaste {{1}}! Thanks for your interest in rooftop solar. Please reply with a clear photo or PDF
> of your latest electricity bill and we will prepare your free proposal. Reply STOP to opt out.

**project_update_v1**
> Hi {{1}}, good news: {{2}}. Track your project here: {{3}}

**proposal_ready_v1**
> Hi {{1}}, your {{2}} kW rooftop solar proposal is ready, including an estimated subsidy of {{3}}.
> View and accept it here: {{4}}

**bill_resubmit_v1**
> Hi {{1}}, we could not read your electricity bill: {{2}}. Please send a clearer photo or the PDF.

**payment_link_v1**
> Hi {{1}}, to book your free site survey please pay the booking token of {{2}} here: {{3}}

**payment_received_v1**
> Thank you {{1}}! We have received {{2}}. We will call you to schedule your site survey. Track your
> project here: {{3}}

**loan_update_v1**
> Hi {{1}}, an update on your solar loan: {{2}}. Details: {{3}}

**login_code_v1** (Authentication; use Meta's standard OTP layout with a copy-code button)
> {{1}} is your verification code. For your security, do not share this code.

## Settings

- `WHATSAPP_PROVIDER=meta`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` (worker, sending)
- `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` (web, `/api/webhooks/whatsapp`)
- Optional `WHATSAPP_GRAPH_VERSION` (default `v21.0`)

The webhook URL to register with Meta is `https://<your domain>/api/webhooks/whatsapp`, subscribed to
the `messages` field.
