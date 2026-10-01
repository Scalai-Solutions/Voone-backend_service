#!/usr/bin/env bash
#
# Decides whether the Apple pass certificate needs renewing, from the JSON that
# GET /api/v1/admin/wallet returns on stdin.
#
# Separate from the workflow that calls it so the decision can be tested. The failure this
# guards against is measured in months, so the scheduled run is green for a year at a
# time — which means the only way to know the thresholds work is to feed it dates
# directly. See tests/certificate-expiry.test.sh.
#
#   echo '{"appleCertificateExpiresAt":"...","appleEnabled":true}' | \
#     scripts/check-certificate-expiry.sh
#
# Exit 0 when there is time left, 1 when something needs doing.

set -euo pipefail

# Renewal is not instant: a new CSR, a certificate from Apple, a re-export of the .p12 and
# a Railway variable update, each of which can wait on somebody.
FAIL_UNDER_DAYS="${FAIL_UNDER_DAYS:-30}"
# A heads-up for anyone reading the run. GitHub only emails on failure, so this is not an
# alert — it is a note for whoever is already looking.
NOTICE_UNDER_DAYS="${NOTICE_UNDER_DAYS:-60}"

# GNU date on the runner, BSD date on a developer's Mac. toISOString() gives
# 2027-10-24T12:34:56.789Z; BSD date cannot parse the fractional seconds, hence the trim.
iso_to_epoch() {
  date -u -d "$1" +%s 2>/dev/null ||
    date -u -j -f "%Y-%m-%dT%H:%M:%S" "${1%%.*}" +%s 2>/dev/null
}

payload="$(cat)"

# Checked before jq is asked for a field. Without this, a 401 HTML page or an empty body
# kills the script with jq's own parse error and exit code 5 — which still fails the run,
# but reports "Invalid numeric literal" to whoever opens the email instead of telling them
# the staff key or the URL is wrong.
if ! printf '%s' "${payload}" | jq -e . >/dev/null 2>&1; then
  echo "::error::The API did not return JSON, so the certificate could not be checked. Verify STAFF_API_KEY and VOONE_API_BASE."
  exit 1
fi

expires_at="$(printf '%s' "${payload}" | jq -r '.appleCertificateExpiresAt // ""')"
enabled="$(printf '%s' "${payload}" | jq -r '.appleEnabled // false')"

# THE case this script exists for, and the one a date comparison alone would miss. The
# field is "" when the certificate cannot be read at all — a wiped variable, a corrupted
# .p12, a half-finished deploy. A check that only compared dates would read that as
# "nothing expiring soon" and stay green straight through an outage.
if [ -z "${expires_at}" ]; then
  echo "::error::The API reports no certificate expiry at all. Apple signing is already broken or misconfigured."
  exit 1
fi

if [ "${enabled}" != "true" ]; then
  echo "::error::The certificate expires ${expires_at} but Apple Wallet reports itself disabled."
  exit 1
fi

expires_epoch="$(iso_to_epoch "${expires_at}")" || true

if [ -z "${expires_epoch:-}" ]; then
  echo "::error::Could not read '${expires_at}' as a date, so the certificate's age is unknown."
  exit 1
fi

days_left="$(( ($(printf '%s' "${expires_epoch}") - $(date -u +%s)) / 86400 ))"

echo "Apple pass certificate expires ${expires_at} (${days_left} days left)."

if [ "${days_left}" -lt 0 ]; then
  echo "::error::The certificate EXPIRED ${days_left#-} days ago. No pass can be signed or updated."
  exit 1
fi

if [ "${days_left}" -lt "${FAIL_UNDER_DAYS}" ]; then
  echo "::error::Only ${days_left} days left. Renew now: a lapse stops every pass updating, silently."
  exit 1
fi

if [ "${days_left}" -lt "${NOTICE_UNDER_DAYS}" ]; then
  echo "::notice::${days_left} days left. Worth booking the renewal."
fi
