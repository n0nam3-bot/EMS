#!/usr/bin/env node
// =====================================================================
// DEVELOPMENT AND TESTING ONLY. NEVER USE THIS IN PRODUCTION.
//
// Mints a session token signed with a private key YOU generated, so you
// can exercise the API before an identity provider is connected. In
// production, tokens are issued by your identity provider and the API
// holds only its PUBLIC key; anyone holding the private key this script
// reads can become any user of any agency.
//
// The token carries only who is asking. It deliberately has no role:
// the database decides role, whether the user is active, and whether
// their agency is active. The user and agency must already exist
// (see bootstrap_example.sql).
//
//   openssl genrsa -out dev_private.pem 2048
//   openssl rsa -in dev_private.pem -pubout -out dev_public.pem
//   # put dev_public.pem's contents in JWT_PUBLIC_KEY, then:
//   node scripts/dev_token.js dev_private.pem <tenant-uuid> <user-uuid> [hours]
// =====================================================================
import fs from "fs";
import jwt from "jsonwebtoken";

const [, , keyPath, tenantId, userId, hours = "8"] = process.argv;
if (!keyPath || !tenantId || !userId) {
  console.error("usage: node scripts/dev_token.js <private-key.pem> <tenant-uuid> <user-uuid> [hours]");
  process.exit(1);
}
console.log(jwt.sign({ sub: userId, tenant_id: tenantId }, fs.readFileSync(keyPath, "utf8"), { algorithm: "RS256", expiresIn: `${Number(hours)}h` }));
