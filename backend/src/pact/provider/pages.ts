// Server-rendered consent and error pages. No scripts at all (script-src 'none'), no framing,
// and every dynamic value is escaped. The consent page is what makes a grant a decision by
// the User, so it names the agent's origin, the Brand, and each scope as an opt-out checkbox.

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function displayName(platformName: string): string {
  if (!/^[a-z0-9-]+$/.test(platformName)) return platformName;
  const words = platformName.replace(/-pa$/, ' personal agent').replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const CSS = `body{font-family:system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.4rem}.box{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1rem 0}
label{display:block;margin:.6rem 0}small{color:#555}button{font-size:1rem;padding:.6rem 1.2rem;margin-right:.5rem;cursor:pointer}
.warn{color:#8a4b00}`;

function html(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)}</title><style>${CSS}</style><body>${body}</body>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      },
    }
  );
}

export function errorPage(brandName: string, message: string, status = 400): Response {
  return html(`${brandName} sign-in error`, `<h1>${esc(brandName)}</h1><p>${esc(message)}</p>`, status);
}

export function consentPage(input: {
  brandName: string;
  platformName: string;
  platformOrigin: string;
  email: string;
  scopes: { id: string; description: string; detail: string; requested: boolean }[];
  action: string;
  session: string;
}): Response {
  const agent = displayName(input.platformName);
  const rows = input.scopes
    .map(
      (s) =>
        `<label><input type="checkbox" name="scope" value="${esc(s.id)}"${s.requested ? ' checked' : ''}> ` +
        `${esc(s.description)}<br><small>${esc(s.detail)}</small></label>`
    )
    .join('');
  return html(
    `Allow access to ${input.brandName}`,
    `<h1>Allow ${esc(agent)} to use your ${esc(input.brandName)} account?</h1>` +
      `<p>Signed in as <b>${esc(input.email)}</b>.</p>` +
      `<p class="box">The agent at <b>${esc(input.platformOrigin)}</b> is asking to act for you at ${esc(input.brandName)}. ` +
      `It never sees your password. You can uncheck anything you don't want it to do.</p>` +
      `<form method="post" action="${esc(input.action)}"><input type="hidden" name="session" value="${esc(input.session)}">` +
      `${rows}<p><button type="submit" name="decision" value="allow">Allow</button>` +
      `<button type="submit" name="decision" value="deny">Deny</button></p></form>`,
    200
  );
}
