Catalog push runs as a separate Workflow step after Publish succeeds. Its counts are returned on the run as `push` and persisted in `catalogPushes/{version}`. `sent` counts Expo acceptance, not delivery to the phone.

Set `CATALOG_PUSH_ENABLED=true` and `EXPO_ACCESS_TOKEN` on the deployment to enable sending. The default is disabled; enabled sends require `GCP_PROJECT_ID=license-plate-game-staging`. No configuration or credentials are read from the game repository.

The registration contract is `users/{uid}/devices/{installationId}` with a string `expoPushToken`. Only Expo token formats are accepted. The paired client issue #230 must use this field. Each request contains at most 100 messages. Immediate `DeviceNotRegistered` errors delete the matching device document only if its token has not changed.

The version marker is claimed transactionally before contacting Expo. Retries and concurrent runs cannot resend a claimed version. This deliberately chooses at-most-once attempts: crashes or ambiguous network responses may leave some devices unnotified. A marker left `claimed` means completion was not recorded. Expo receipt polling and delivery confirmation are not included; later receipt errors are not pruned. Push failures never roll back Publish.

Device registration, deployment configuration, and a staging TestFlight delivery check remain release prerequisites. Do not enable this sender against another Firebase project.
