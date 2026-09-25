/**
 * The account integration: where it talks to, and what it does not do.
 *
 * IT GATES NOTHING. Every dub runs on the visitor's own machine, so there is
 * nothing here to meter or withhold. Signing in carries one balance across
 * our apps, and that is all. There is no app key, no charge and no
 * entitlement check anywhere in OpenDub; a paid feature would belong behind
 * the gateway, and the page copy would have to change with it.
 *
 * ONE PLACE FOR EVERY URL. The two hostnames are defined here and nowhere
 * else; tests/site.mjs asserts that no other file names the backend.
 */

/** The shared account server, under OpenDub's own name. */
export const OPENAPPS_BASE_URL = "https://auth.opendub.app";

/** The gateway for paid features. Unused today, named so it never has to be pasted in later. */
export const OPENAPPS_GATEWAY_URL = "https://gateway.opendub.app";

const BUNDLE = "/vendor/openapps/openapps-ui.js";
let ui = null;

/** Load and configure the elements once. ~360 KB, so only the account page calls this. */
export async function ensureConfigured() {
  if (!ui) {
    ui = await import(BUNDLE);
    ui.configure({ baseUrl: OPENAPPS_BASE_URL });
  }
  return ui;
}

export async function isSignedIn() {
  const { getClient } = await ensureConfigured();
  return getClient()?.isLoggedIn ?? false;
}

export async function onSessionChange(fn) {
  const { onChange } = await ensureConfigured();
  return onChange(fn);
}

/**
 * Signed-in state for the header control, read from the SDK's local session
 * rather than the server: it decides a tooltip, and is not worth a network
 * round trip on every page load, most of them signed out.
 */
export function looksSignedIn() {
  try {
    return Boolean(localStorage.getItem("openapps.session"));
  } catch {
    return false;
  }
}
