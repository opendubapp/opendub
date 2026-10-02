// Where the model weights come from.
//
// Whisper is 237 MB and the voice separator is 172 MB, and both used to be
// fetched from the HuggingFace CDN on the first dub. In an app whose
// installer otherwise carries everything, that is the last thing left that
// can fail on somebody else's connection — and it fails late, after they
// have already installed and pressed the button.
//
// So the installer carries them, and anything the app serves takes them from
// there: its own window, a tab on 127.0.0.1, and the extension once it has
// found the app. opendub.app keeps using the CDN. A gigabyte per visitor is
// not something that box can serve, and a visitor to the site has not
// installed anything to carry the weights anyway.
//
// The mirror is only ever consulted for an origin that is already known
// good — this page's own, or one a health check answered on. It never probes
// 127.0.0.1 on its own: that puts the browser's "reach devices on your local
// network" prompt in front of someone who never asked for it.

import { LOCAL_APP } from "./providers.js";

/** Set by a successful health check, so the extension and the site can use it too. */
let confirmedOrigin = null;
export function appIsAt(origin) {
  if (origin && origin !== confirmedOrigin) { confirmedOrigin = origin; probe = null; }
}

/** True when this page is itself served by the app. */
function servedByApp() {
  try {
    return location.protocol === "http:"
      && (location.hostname === "127.0.0.1" || location.hostname === "localhost")
      && location.origin === LOCAL_APP;
  } catch { return false; }
}

let probe = null;

/**
 * The base URL of the local mirror, or null to use the CDN.
 * Resolved once per origin; a miss is remembered so every dub does not re-ask.
 */
export function mirror() {
  return (probe ??= (async () => {
    const origin = servedByApp() ? location.origin : confirmedOrigin;
    if (!origin) return null;
    try {
      const r = await fetch(`${origin}/models/manifest.json`, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) return null;
      const m = await r.json();
      return m?.models ? `${origin}/models/` : null;
    } catch { return null; }      // an older install, or one without them
  })());
}
