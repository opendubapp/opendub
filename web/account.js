// The account page. Its own document, never a panel over the app: the Google
// button navigates the whole window away and back, which would throw away
// whatever the app page was holding. It is path-routed (/account), so the
// code the provider sends back in the fragment lands on a page that mounts
// <openapps-login>, whose connectedCallback completes the exchange.
import { ensureConfigured, isSignedIn, onSessionChange, OPENAPPS_BASE_URL } from "./openapps.js";

const status = document.getElementById("account-status");
const panel = document.getElementById("account-panel");
const signedInBlock = document.getElementById("signed-in");

async function sync() {
  const yes = await isSignedIn();
  // Balance, buying and history each render their own "sign in to…" when
  // signed out; mounted unconditionally they would repeat the panel's ask.
  signedInBlock.hidden = !yes;
  document.querySelector(".account-btn")?.classList.toggle("is-signed-in", yes);
}

try {
  await ensureConfigured();
  status.hidden = true;
  panel.hidden = false;
  await sync();
  onSessionChange(sync);
} catch {
  // Almost always CORS (this origin missing from the server's allow-list),
  // which a browser reports exactly like a dead server — so say both.
  status.textContent = `Could not reach the account server (${OPENAPPS_BASE_URL}). It may be down, or this page's address is not yet allowed.`;
}
