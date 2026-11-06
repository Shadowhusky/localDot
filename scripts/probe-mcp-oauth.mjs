#!/usr/bin/env node
// Says which apps' sign-in services localDot can use without a registered client. It reads public
// metadata only: no account, no registration and no sign-in. node scripts/probe-mcp-oauth.mjs [url…]
import { CONNECTOR_CATALOG } from "../packages/protocol/src/connectors.ts";

const CATALOG = Object.fromEntries(
  CONNECTOR_CATALOG.flatMap((entry) =>
    entry.server.kind === "remote" && entry.server.auth.includes("oauth")
      ? [[entry.name, entry.server.url]]
      : [],
  ),
);

async function json(url) {
  try {
    const reply = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    return reply.ok ? await reply.json() : undefined;
  } catch {
    return undefined;
  }
}

async function probe(url) {
  const { origin, pathname } = new URL(url);
  const path = pathname === "/" ? "" : pathname;
  const resource =
    (await json(`${origin}/.well-known/oauth-protected-resource${path}`)) ??
    (await json(`${origin}/.well-known/oauth-protected-resource`));
  const server = new URL(resource?.authorization_servers?.[0] ?? origin);
  const serverPath = server.pathname === "/" ? "" : server.pathname;
  const metadata =
    (await json(`${server.origin}/.well-known/oauth-authorization-server${serverPath}`)) ??
    (await json(`${server.origin}${serverPath}/.well-known/openid-configuration`));
  if (!metadata) return "no sign-in metadata";
  const how = metadata.client_id_metadata_document_supported
    ? "client metadata document"
    : metadata.registration_endpoint
      ? "dynamic registration"
      : "needs a registered client";
  const refresh = metadata.grant_types_supported?.includes("refresh_token")
    ? "refreshes"
    : "no refresh";
  const pkce = metadata.code_challenge_methods_supported?.includes("S256") ? "PKCE" : "no PKCE";
  return `${how}, ${refresh}, ${pkce}`;
}

const asked = process.argv.slice(2);
const targets = asked.length ? Object.fromEntries(asked.map((url) => [url, url])) : CATALOG;
for (const [name, url] of Object.entries(targets)) console.log(`${name}: ${await probe(url)}`);
