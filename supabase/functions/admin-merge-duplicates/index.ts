// Admin-only: list & merge duplicate profiles created by pre-v3.14.2 CSV imports.
// Duplicate clusters are grouped by telegram_id (preferred) or telegram_username
// (fallback). Canonical = oldest created_at in cluster.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type Profile = {
  id: string;
  name: string | null;
  last_name: string | null;
  email: string;
  telegram_id: number | null;
  telegram_username: string | null;
  group_id: string | null;
  created_at: string;
};

type Cluster = {
  key: string;
  key_type: "telegram_id" | "telegram_username";
  canonical: Profile;
  duplicates: Profile[];
};

function buildClusters(rows: Profile[]): Cluster[] {
  const byTgId = new Map<string, Profile[]>();
  const byTgUser = new Map<string, Profile[]>();
  for (const r of rows) {
    if (r.telegram_id != null) {
      const k = String(r.telegram_id);
      const arr = byTgId.get(k) ?? [];
      arr.push(r);
      byTgId.set(k, arr);
    } else if (r.telegram_username) {
      const k = r.telegram_username.toLowerCase();
      const arr = byTgUser.get(k) ?? [];
      arr.push(r);
      byTgUser.set(k, arr);
    }
  }
  const clusters: Cluster[] = [];
  const claimed = new Set<string>();
  for (const [k, arr] of byTgId) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const [canonical, ...duplicates] = arr;
    duplicates.forEach((d) => claimed.add(d.id));
    claimed.add(canonical.id);
    clusters.push({ key: k, key_type: "telegram_id", canonical, duplicates });
  }
  for (const [k, arr] of byTgUser) {
    const filtered = arr.filter((r) => !claimed.has(r.id));
    if (filtered.length < 2) continue;
    filtered.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const [canonical, ...duplicates] = filtered;
    clusters.push({ key: k, key_type: "telegram_username", canonical, duplicates });
  }
  return clusters;
}

async function mergeCluster(admin: any, actorId: string, cluster: Cluster) {
  const { canonical, duplicates } = cluster;
  // Build merged updates from duplicates (last non-null wins for group_id)
  const update: Record<string, unknown> = {};
  let groupId: string | null = canonical.group_id;
  let name = canonical.name;
  let lastName = canonical.last_name;
  let email = canonical.email;
  let tgId = canonical.telegram_id;
  let tgUser = canonical.telegram_username;
  for (const d of duplicates) {
    if (d.group_id) groupId = d.group_id;
    if (!name && d.name) name = d.name;
    if (!lastName && d.last_name) lastName = d.last_name;
    if ((!email || email.endsWith("@telegram.local")) && d.email && !d.email.endsWith("@telegram.local")) {
      email = d.email;
    }
    if (tgId == null && d.telegram_id != null) tgId = d.telegram_id;
    if (!tgUser && d.telegram_username) tgUser = d.telegram_username;
  }
  if (groupId !== canonical.group_id) update.group_id = groupId;
  if (name !== canonical.name) update.name = name;
  if (lastName !== canonical.last_name) update.last_name = lastName;
  if (email !== canonical.email) update.email = email;
  if (tgId !== canonical.telegram_id) update.telegram_id = tgId;
  if (tgUser !== canonical.telegram_username) update.telegram_username = tgUser;

  if (Object.keys(update).length > 0) {
    await admin.from("profiles").update(update).eq("id", canonical.id);
  }

  const merged_ids: string[] = [];
  for (const d of duplicates) {
    // Delete auth user; this cascades the profile via FK or we delete profile manually
    try {
      await admin.auth.admin.deleteUser(d.id);
    } catch (e) {
      console.error("auth delete failed", d.id, e);
    }
    // Ensure profile row gone
    try {
      await admin.from("profiles").delete().eq("id", d.id);
    } catch (e) {
      console.error("profile delete failed", d.id, e);
    }
    merged_ids.push(d.id);
  }

  try {
    await admin.from("admin_actions").insert({
      actor_user_id: actorId,
      action: "merged_duplicates",
      target_user_id: canonical.id,
      target_resource_type: "profile",
      target_resource_id: canonical.id,
      details: {
        cluster_key: cluster.key,
        cluster_key_type: cluster.key_type,
        canonical_profile_id: canonical.id,
        merged_ids,
        applied_updates: update,
      },
    });
  } catch (e) {
    console.error("audit insert failed", e);
  }
  return { canonical_id: canonical.id, merged_ids };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const PUB_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, PUB_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: who } = await userClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!who?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: roleRow } = await admin
      .from("user_roles").select("role").eq("user_id", who.user.id).eq("role", "admin").maybeSingle();
    if (!roleRow) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const actorId = who.user.id;

    const body = await req.json().catch(() => ({}));
    const action = body.action ?? "list";

    // Fetch all profiles in pages (1000 default limit)
    const allRows: Profile[] = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await admin
        .from("profiles")
        .select("id,name,last_name,email,telegram_id,telegram_username,group_id,created_at")
        .order("created_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allRows.push(...(data as Profile[]));
      if (data.length < PAGE) break;
      from += PAGE;
    }

    const clusters = buildClusters(allRows);

    if (action === "list") {
      const totalDuplicates = clusters.reduce((s, c) => s + c.duplicates.length, 0);
      return new Response(JSON.stringify({
        ok: true,
        cluster_count: clusters.length,
        duplicate_row_count: totalDuplicates,
        clusters,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "merge_one") {
      const canonicalId: string | undefined = body.canonical_id;
      if (!canonicalId) {
        return new Response(JSON.stringify({ error: "canonical_id required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const cluster = clusters.find((c) => c.canonical.id === canonicalId);
      if (!cluster) {
        return new Response(JSON.stringify({ ok: true, skipped: true, reason: "cluster not found (already merged?)" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const result = await mergeCluster(admin, actorId, cluster);
      return new Response(JSON.stringify({ ok: true, ...result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "merge_all") {
      const results: any[] = [];
      for (const cluster of clusters) {
        try {
          const r = await mergeCluster(admin, actorId, cluster);
          results.push({ ok: true, ...r });
        } catch (e) {
          results.push({ ok: false, canonical_id: cluster.canonical.id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return new Response(JSON.stringify({
        ok: true,
        cluster_count: clusters.length,
        merged: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
