// Mint a real Supabase session server-side for a KNOWN user, by email — no email is ever sent.
//
// Same proven technique as magic-link-redeem's mintSessionForUser: the admin API generates a magic-link
// token (server-side, no delivery), then an anon client verifies that token to produce a session. Works
// with the platform's synthetic `@telegram.local` emails (they only need to MATCH an auth.users row).
//
// (Copied here rather than imported from magic-link-redeem to keep this Mini App branch additive — the
// live magic-link-redeem function is intentionally left untouched. A later DRY pass can dedupe.)

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export interface MintedSession {
  access_token: string;
  refresh_token: string;
}

export async function mintSessionForUser(admin: SupabaseClient, email: string): Promise<MintedSession> {
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr) throw linkErr;
  const tokenHash = (linkData as { properties?: { hashed_token?: string } })?.properties?.hashed_token;
  if (!tokenHash) throw new Error("No hashed_token returned");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data, error } = await anonClient.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (error) throw error;
  if (!data?.session) throw new Error("verifyOtp returned no session");
  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  };
}
