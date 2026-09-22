# PeerMate landing page

A standalone, responsive landing page for the PeerMate WhatsApp learning companion.

## Preview locally

From the repository root:

```bash
cd landing_page
python3 -m http.server 4173
```

Then open <http://localhost:4173>.

## Files

- `index.html` — semantic page structure and product copy
- `styles.css` — responsive layout, brand system and interface illustrations
- `script.js` — navigation, signup flow, reveal effects, FAQ behaviour and interactive chat demo
- `assets/peermate-logo.webp` — optimized website logo
- `assets/peermate-logo.png` — high-resolution PeerMate logo master

## Brand palette

- Primary Green: `#16B875`
- Deep Green: `#075E54`
- Dark Navy: `#08263A`
- Soft Mint: `#E9FAF3`
- Light Green: `#CFF5E5`
- White: `#FFFFFF`
- Soft Grey: `#667085`

No frontend build step is required. The signup form expects the PeerMate app to be
available under `/api/signup/` on the same origin.

Before signup, every WhatsApp call to action opens the signup dialog. A successful
email signup is stored in MongoDB and changes those links to a direct chat with
`+1 507 604 6411` in that browser. Google signup is intentionally disabled for now.

## Production signup setup

Set these values in the app `.env`:

```ini
LANDING_WHATSAPP_NUMBER=15076046411
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USERNAME=your-smtp-username
SMTP_PASSWORD=your-smtp-password
SMTP_USE_TLS=true
SMTP_USE_SSL=false
MAIL_FROM=PeerMate <hello@example.com>
ADMIN_WAITLIST_EMAIL=admin@example.com
```

Each successful signup is stored before email delivery is attempted. `MAIL_FROM`
sends an operator notification containing the submitted name and email to
`ADMIN_WAITLIST_EMAIL`, then sends the new signup a welcome message. When no name
was supplied, the welcome message uses `Sir/Ma`.

The static-site Nginx server must proxy only the public signup API to the local app:

```nginx
location /api/signup/ {
    proxy_pass http://127.0.0.1:3011;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Review signups through an authorised server shell rather than a public endpoint:

```bash
docker compose -f compose.prod.yml exec app npm run signups:prod
```
