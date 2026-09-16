# Google Wallet Loyalty Provider

This folder contains the Google Wallet Loyalty Card integration. `client.ts` owns the service-account OAuth2 client used for Wallet REST calls and typed REST error handling. `types.ts` defines the narrow backend-facing loyalty class/object inputs. `classService.ts` creates or patches LoyaltyClass resources, while `objectService.ts` creates, reads, and patches LoyaltyObject resources for member cards and future scan-to-credit updates. `jwt.ts` builds the separate signed Save to Google Wallet JWT link, and `index.ts` exposes the five public functions other backend modules should import.

## Environment Variables

- `GOOGLE_WALLET_SERVICE_ACCOUNT_KEY`: Either an absolute path to the downloaded Google service account JSON key file, or the service account private key value itself. When using the private key value directly, also set `GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL`. The code reads only the email and private key and never logs the key contents.
- `GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL`: Required only when `GOOGLE_WALLET_SERVICE_ACCOUNT_KEY` contains the private key value directly instead of a JSON key file path.
- `GOOGLE_WALLET_ISSUER_ID`: Numeric Google Wallet issuer ID string. Class and object IDs passed into this provider must start with this issuer ID followed by a dot.
- `GOOGLE_WALLET_ALLOWED_ORIGIN`: Origin where the Save to Google Wallet button or link is served. This value is placed in the Save-to-Wallet JWT `origins` claim and must match the serving domain.
