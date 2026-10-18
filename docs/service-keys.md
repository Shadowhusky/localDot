# Saved keys

Keys are reusable service credentials. A model-provider key can serve its provider’s non-chat APIs as well as model selection. Custom services accept a documented HTTPS host, authentication header and bearer, raw or Basic format. Labels, service names and purpose descriptions help dot choose; they do not grant permission or change a key’s destination.

## General keys

Settings → Keys also supports a General key: an encrypted text value with no provider, website or HTTP authorization format. It accepts 1–8,192 UTF-8 bytes, including Unicode, spaces and line breaks; NUL and malformed UTF-8 are refused. Existing API key validation is unchanged. The browser checks keyd’s `generalSecrets` capability before saving, so an older helper gives an actionable update error.

General bindings use `{ id, kind: "secret" }` and cannot contain provider or HTTP routing fields. The value is sealed to keyd exactly as entered. The agent can discover its name and purpose and request it through the private save form using `kind: "secret"`. Only a verified saved marker enters the conversation. General keys currently provide storage: they cannot be minted into a cell, used by `api_request`, read into model context or passed to a program. Program delivery is a separate capability, not implied by storage.

Saved-key actions share the same row. Edit reveals its metadata form within the settings scroller without changing page position. On phones, Edit and Remove are labelled icon buttons; Remove still needs a second tap to confirm.

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
