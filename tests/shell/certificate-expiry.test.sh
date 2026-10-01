#!/usr/bin/env bash
#
# Tests the certificate watch's thresholds by feeding it dates.
#
# Worth having because the real check is green for a year at a time: the Apple certificate
# expires once annually, so the scheduled workflow proves nothing about its own logic until
# the month it finally matters — which is the worst possible moment to find a bug in it.
#
#   bash tests/shell/certificate-expiry.test.sh

set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/../.." && pwd)/scripts/check-certificate-expiry.sh"

pass=0
fail=0

# A date N days from now, in the same shape toISOString() produces.
in_days() {
  local offset="$1"
  # GNU takes "+5 days" / "-5 days"; BSD takes "+5d" / "-5d" and rejects "+-5d", so the
  # sign has to be carried rather than prefixed.
  case "${offset}" in -*) ;; *) offset="+${offset}" ;; esac
  date -u -d "${offset} days" +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null ||
    date -u -v "${offset}d" +"%Y-%m-%dT%H:%M:%S.000Z"
}

check() {
  local name="$1" expected="$2" payload="$3"
  local output status
  output="$(printf '%s' "${payload}" | bash "${SCRIPT}" 2>&1)"
  status=$?

  if [ "${status}" -eq "${expected}" ]; then
    pass=$((pass + 1))
    printf '  ok    %-52s exit %s\n' "${name}" "${status}"
  else
    fail=$((fail + 1))
    printf '  FAIL  %-52s exit %s, wanted %s\n' "${name}" "${status}" "${expected}"
    printf '        %s\n' "${output}"
  fi
}

# Asserts on the message as well, for the cases where the message IS the deliverable:
# somebody reads it in a failure email and has to know what to do.
check_says() {
  local name="$1" expected="$2" needle="$3" payload="$4"
  local output status
  output="$(printf '%s' "${payload}" | bash "${SCRIPT}" 2>&1)"
  status=$?

  if [ "${status}" -eq "${expected}" ] && printf '%s' "${output}" | grep -q "${needle}"; then
    pass=$((pass + 1))
    printf '  ok    %-52s exit %s, says %s\n' "${name}" "${status}" "${needle}"
  else
    fail=$((fail + 1))
    printf '  FAIL  %-52s exit %s (wanted %s), output:\n' "${name}" "${status}" "${expected}"
    printf '        %s\n' "${output}"
  fi
}

payload() { printf '{"appleCertificateExpiresAt":"%s","appleEnabled":%s}' "$1" "$2"; }

echo "certificate expiry thresholds"

check "a year out is fine"                 0 "$(payload "$(in_days 365)" true)"
check "90 days is fine"                    0 "$(payload "$(in_days 90)" true)"
check "61 days is fine, just above notice" 0 "$(payload "$(in_days 61)" true)"
check_says "45 days passes with a notice"  0 "::notice" "$(payload "$(in_days 45)" true)"
check_says "31 days still passes"          0 "::notice" "$(payload "$(in_days 31)" true)"
check_says "29 days fails"                 1 "Renew now" "$(payload "$(in_days 29)" true)"
check_says "tomorrow fails"                1 "Renew now" "$(payload "$(in_days 1)" true)"
check_says "already expired fails"         1 "EXPIRED"   "$(payload "$(in_days -5)" true)"

echo
echo "the states a date comparison alone would miss"

# The reason this is not just a date check. "" means the certificate cannot be read —
# wiped variable, corrupt .p12, half-finished deploy — and a naive check reads the absence
# of an expiry as nothing expiring soon.
check_says "an EMPTY expiry fails rather than passing" 1 "no certificate expiry" "$(payload "" true)"
check_says "a missing field fails too"                 1 "no certificate expiry" '{"appleEnabled":true}'
check_says "disabled Apple Wallet fails"               1 "reports itself disabled" "$(payload "$(in_days 365)" false)"
check_says "an unparseable date fails"                 1 "Could not read"          "$(payload "not-a-date" true)"
check_says "an HTML error page says what to check"     1 "did not return JSON"     '<html>401</html>'
check_says "an empty body says the same"               1 "did not return JSON"     ''

echo
echo "  ${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
