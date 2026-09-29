# Family profiles, meals and photos

Sign in with an owner account and open **Family meals → Manage family profiles** on
the dashboard. Create named profiles, or edit the primary profile, and check the
existing parent/child accounts allowed to view and log their meals. Owners have access
to all profiles. Viewers and shared API keys cannot access meals or photos. Profile IDs
are permanent storage identifiers; changing a name does not move its records.

The primary profile (`patient`) uses the installation's single Nightscout instance.
Other family members have separate local meal journals; they do not inherit the primary
person's glucose/pump records, predictions or Nightscout treatment feed. Mark a profile
as **Test** when it is for practice. Its records remain separate. This is meal-profile
support, not multiple independent Nightscout dashboards.

## Logging

Choose the destination before entering a Meal, Snack or Quick sugar entry. Enter the
carbohydrates, time (any minute within the last 24 hours), reason and optional description.
Attach a camera/library image if useful. The iOS app exposes **Log meal or photo** after
signing in with an assigned username/password account; manage assignments on the web.

Manual entries represent carbohydrates **not already recorded on the pump**. Confirming
a primary-profile entry creates a separate Nightscout treatment with a stable retry ID;
retries do not create duplicate treatments. Pump prompt replies annotate episodes without
writing carbohydrate treatments. The web recent-meal list supports undo within 15 minutes.

iOS saves confirmed entries to a durable account/server-specific queue and retries transient
failures. Photos must finish uploading before they can be attached; a pending carb entry
is not proof it reached the server. The meal sheet displays pending/error state. Logging
without a photo remains available offline after the account's meal access was verified.

## Optional photo/text estimates

Set these environment variables and restart the server:

```dotenv
MEAL_VISION_URL=http://localhost:11434/v1
MEAL_VISION_API_KEY=
MEAL_VISION_MODEL=your-vision-model
```

The endpoint must support OpenAI-compatible chat completions and image data URLs. The URL
includes its API prefix; ClearSugar appends `/chat/completions`. An optional API key is sent
as a Bearer credential. Configure your own local or hosted provider; no provider is enabled
by default. In the web form, click **Estimate**; iOS attempts an estimate after uploading a
photo, and also supports description-only estimates. These actions send the image/description
to your configured provider. Choose a provider and retention policy appropriate for your data.

Estimates include a most-likely carbohydrate value, a range, model-reported confidence,
macronutrients and assumptions. Follow-up questions revise the estimate using the original
photo/description and previous estimate. Review or edit the grams, then confirm. Estimates
and revisions never create treatments automatically. Photos can be saved with manually
entered grams when no estimator is configured. No insulin dosing advice is generated.

## Privacy and retention

Photos are resized to a 1024-pixel longest edge and limited to 1.5 MB. Clients re-encode
JPEGs and the server strips metadata. Images are stored outside public assets, served only
to authorized profile members with `private, no-store`, and isolated by profile. The image
itself can still contain identifying content. Protect the data directory and its backups
with appropriate filesystem permissions and disk encryption; use HTTPS for remote access.

The meal detector prunes images after 90 days; structured logs and estimate revisions remain.
To run detection and pruning, schedule an authenticated `GET /api/meals/detect` every five
minutes with `X-API-Key: $CLEARSUGAR_API_KEY`. It uses the primary profile's existing pump
and glucose data, and prunes photos across all profiles. `?dry=1` performs no writes.
`MEAL_PROMPT_SHADOW=true` is the default: it records episodes but sends no pushes. After
reviewing behavior and assigning patient devices in alert settings, set it to `false` to
enable prompts. Empty recipient lists never broadcast. Native notification actions support
timing replies, text/dictation and opening the photo form; physical-device delivery still
requires validation with your APNs configuration.

README meal screenshots use a generated illustration and synthetic entries, with external
integrations disabled. They contain no real meal photos or patient records.
