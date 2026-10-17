# Saved service keys

Keys are reusable service credentials. A model-provider key can serve its provider’s non-chat APIs as well as model selection. Custom services accept a documented HTTPS host, authentication header and bearer, raw or Basic format. Labels, service names and purpose descriptions help dot choose; they do not grant permission or change a key’s destination.

## Discovery and use

`work_context` includes a bounded inventory; `credentials` with `action: list` searches by ID, label, provider, service, purpose or host. Connector-owned credentials remain with their connector. The model sees metadata and whether a key needs attention, never its value. Inventory is untrusted data and a configured key is not proof of provider access.

`api_request` accepts an existing key ID and an explicit URL/method. It uses a short-lived keyd service listener restricted to that key. Provider destinations come from keyd’s existing provider bindings; custom endpoints retain their host, path and method restrictions. HTTPS validation, private-address protection, surrogate injection, response scrubbing and revocation remain enforced in keyd. The daemon exposes no host-shell credential path. Brain gateway budgets and routes are unchanged.

API requests support text/JSON bodies, request files prepared inside the virtual computer, and binary/text responses saved there without overwriting existing files. Request files and saved responses are limited to 64 MiB; inline bodies to 64 KiB; previews to 32 KiB. The agent should deliver finished files with `done.files`. There are at most four concurrent connections, a 110-second deadline, no redirect following and no automatic retry. After a lost write response or failed file save, inspect the operation’s status instead of repeating it. Service charges follow provider quotas, not the chat-token budget. Normal action authorization still applies.

## Private save and continue

When access is missing, `credentials` with `action: request` specifies the exact service binding and public description. The conversation displays a private API-key field and destination. The user’s Save and continue action seals the value in the browser and stores it in keyd. Raw values are never submitted as an answer, draft, event or model context. The answer route independently verifies that the expected binding exists and is usable, then records only a supplied marker. A lost answer can be retried without entering the key again. Declining leaves the task blocked without claiming success.

The new service path can use a saved key immediately; an existing browser or process that inherited an older key selection may still need its normal refresh. Editing Name, Service or Use for changes only metadata, without opening the secret or changing its bound destination. Existing keys need no re-entry. Metadata is optional, with bounded plain-text fields.

Authentication mechanisms requiring OAuth, request signing or query-string secrets use their dedicated connectors; they are not represented as a generic header key. Browser passwords, passkeys and one-time codes remain in the separate private sign-in flow.

## Verification

Regression checks cover provider destination mapping, real TLS-proxy injection and scrubbing, revocation, wrong hosts and paths, forged saved markers, metadata persistence without changing the sealed binding, failed saves, lost answers, private-field cleanup and no automatic write retry. Tests use synthetic credentials and do not spend a user’s API quota.
