# Google Wallet Notifications

All endpoints are mounted under `/api/v1` and require the server-side staff key plus session-derived headers:

- `x-voone-role`: `OWNER`, `MANAGER`, `STAFF`, or `VOONE_ADMIN`
- `x-voone-clinic-id`: required unless the role is `VOONE_ADMIN`
- `x-voone-user-id`: optional, stored on notification audit rows

`OWNER` and `MANAGER` may send and configure notifications. `STAFF` may read scoped history/quota/settings but may not send or configure. POST send endpoints accept `Idempotency-Key`.

## Broadcast

`POST /api/v1/clinics/:clinicId/notifications/broadcast`

```json
{
  "header": "Autumn rewards",
  "body": "Book this week and earn double points.",
  "actionUrl": "https://clinic.example/book",
  "notify": true,
  "scheduledAt": "2026-10-01T10:00:00.000Z"
}
```

Returns `202`:

```json
{ "notificationId": "uuid", "status": "QUEUED" }
```

This sends one Google class-level message. The API enforces at most 3 broadcasts per clinic per rolling 24 hours.

## Segment

`POST /api/v1/clinics/:clinicId/notifications/segment`

```json
{
  "segment": { "tier": "Gold", "inactiveDays": 60 },
  "header": "We miss you",
  "body": "Your Gold benefits are waiting.",
  "notify": true
}
```

Returns `202` with a `notificationId`. Members without a synced Google pass are marked `SKIPPED`. Marketing pushes that would consume the reserved transactional quota are downgraded to `TEXT` and marked `DOWNGRADED`.

## Single Member

`POST /api/v1/members/:memberId/notifications`

```json
{
  "header": "Reward unlocked",
  "body": "Ask reception about your reward.",
  "notify": true
}
```

Returns `202` with a `notificationId`.

## History And Status

`GET /api/v1/clinics/:clinicId/notifications?status=SENT&type=SEGMENT&cursor=uuid`

Returns paginated notifications: `{ "items": [...], "nextCursor": "uuid-or-null" }`.

`GET /api/v1/notifications/:id`

Returns `{ "notification": {...}, "counts": { "total": 10, "sent": 7, "downgraded": 1, "failed": 0, "skipped": 2 } }`.

`DELETE /api/v1/notifications/:id`

Marks the notification cancelled and best-effort removes Google messages from the class or objects.

## Quota

`GET /api/v1/members/:memberId/notification-quota`

Returns:

```json
{ "used": 2, "remaining": 1, "resetsAt": "2026-09-30T09:00:00.000Z" }
```

Google allows 3 notification-triggering sends per object per rolling 24 hours. Marketing sends may use at most 2 so one slot remains for points/tier updates.

## Settings

`GET /api/v1/clinics/:clinicId/notification-settings`

`PUT /api/v1/clinics/:clinicId/notification-settings`

```json
{ "notifyOnCredit": "MILESTONE_AND_TIER", "marketingEnabled": true }
```

`notifyOnCredit` is `NEVER`, `MILESTONE_AND_TIER`, or `ALWAYS`.

## Geo Locations

`GET /api/v1/clinics/:clinicId/geo-locations`

`PUT /api/v1/clinics/:clinicId/geo-locations`

```json
{
  "locations": [
    { "name": "Main clinic", "latitude": 40.4168, "longitude": -3.7038 }
  ]
}
```

Returns the stored locations plus:

```json
{ "note": "Nearby alerts are shown by Google Wallet; text and timing are not configurable." }
```

Google Wallet accepts up to 10 MerchantLocations per class.