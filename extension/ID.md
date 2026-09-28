# The Firefox add-on id

`opendub@opendub.app`, set in `src/manifest.firefox.json`.

On AMO the id **is** the add-on: it cannot be renamed later, and shipping a
different one makes a second add-on whose listing, ratings and users are
separate — existing users stay on the old one with no updates. So it is
worth being sure before the first submission, and trivial to change until
then.

Why this one:

- **It names a domain we own.** opendub.app is registered to DE JIAN KOH
  until 19 September 2027 (checked at the registrar, not assumed). An id
  naming a domain someone else could register later is worse than no id.
- **It names the product, not the platform.** The suite's rule is that a
  reader of opendub.app has never heard of OpenApps; `opendub@openapps.dev`
  would put that name in front of them in the add-on's own identity.
- **It is free.** `https://addons.mozilla.org/api/v5/addons/addon/opendub@opendub.app/`
  returns 404, so nothing holds it today.

Nothing has been submitted to AMO. Changing the id costs nothing until it is.
