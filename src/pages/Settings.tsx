import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Monitor, LogOut } from "lucide-react";

interface AuthEvent {
  id: string;
  event: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

function parseBrowser(ua: string | null): string {
  if (!ua) return "Unknown";
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/chrome\//i.test(ua)) return "Chrome";
  if (/firefox\//i.test(ua)) return "Firefox";
  if (/safari\//i.test(ua)) return "Safari";
  return "Browser";
}

function parseOS(ua: string | null): string {
  if (!ua) return "";
  if (/windows/i.test(ua)) return "Windows";
  if (/mac os/i.test(ua)) return "macOS";
  if (/android/i.test(ua)) return "Android";
  if (/iphone|ipad|ios/i.test(ua)) return "iOS";
  if (/linux/i.test(ua)) return "Linux";
  return "";
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function Settings() {
  const { user, signOut } = useAuth();
  const [name, setName] = useState("");
  const [lastName, setLastName] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [goal, setGoal] = useState(5);
  const [pw, setPw] = useState("");
  const [events, setEvents] = useState<AuthEvent[]>([]);
  const [signingOutOthers, setSigningOutOthers] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("name, last_name, timezone, weekly_goal_lessons")
        .eq("id", user.id)
        .maybeSingle();
      if (data) {
        setName(data.name || "");
        setLastName((data as any).last_name || "");
        setTimezone(data.timezone || "UTC");
        setGoal(data.weekly_goal_lessons || 5);
      }
      const { data: ev } = await supabase
        .from("auth_events")
        .select("id, event, ip, user_agent, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(10);
      setEvents((ev || []) as AuthEvent[]);
    })();
  }, [user]);

  const currentUa = typeof navigator !== "undefined" ? navigator.userAgent : "";

  const save = async () => {
    if (!user) return;
    const { error } = await supabase
      .from("profiles")
      .update({ name, last_name: lastName || null, timezone, weekly_goal_lessons: goal } as any)
      .eq("id", user.id);
    if (error) toast.error(error.message); else toast.success("Saved");
  };

  const updatePassword = async () => {
    if (pw.length < 8) { toast.error("Min 8 characters"); return; }
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) toast.error(error.message); else { toast.success("Password updated"); setPw(""); }
  };

  const signOutOthers = async () => {
    setSigningOutOthers(true);
    const { error } = await supabase.auth.signOut({ scope: "others" });
    setSigningOutOthers(false);
    if (error) toast.error(error.message); else toast.success("Signed out of other sessions");
  };

  const mostRecentId = useMemo(() => events[0]?.id, [events]);

  return (
    <PageShell>
      <div className="max-w-2xl space-y-6">
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>

        <Card className="p-5 space-y-4 shadow-soft">
          <h2 className="font-semibold">Profile</h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>First name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Last name</Label><Input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Optional" /></div>
          </div>
          <div className="space-y-1.5"><Label>Email</Label><Input value={user?.email || ""} disabled /></div>
          <div className="space-y-1.5"><Label>Timezone</Label><Input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Weekly study goal (lessons)</Label><Input type="number" value={goal} onChange={(e) => setGoal(parseInt(e.target.value) || 0)} /></div>
          <Button onClick={save}>Save profile</Button>
        </Card>

        <Card className="p-5 space-y-4 shadow-soft">
          <h2 className="font-semibold">Password</h2>
          <div className="space-y-1.5"><Label>New password</Label><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Min 8 characters" /></div>
          <Button onClick={updatePassword}>Update password</Button>
        </Card>

        <Card className="p-5 space-y-4 shadow-soft">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold">Recent sign-ins</h2>
              <p className="text-xs text-muted-foreground mt-1">Last 10 sign-ins to your account.</p>
            </div>
            <Button variant="outline" size="sm" onClick={signOutOthers} disabled={signingOutOthers}>
              <LogOut className="h-3.5 w-3.5" />
              Sign out other devices
            </Button>
          </div>
          <div className="overflow-x-auto -mx-5">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="text-left px-5 py-2 font-medium">When</th>
                  <th className="text-left px-5 py-2 font-medium">Browser</th>
                  <th className="text-left px-5 py-2 font-medium">IP</th>
                  <th className="px-5 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {events.length === 0 && (
                  <tr><td colSpan={4} className="px-5 py-6 text-center text-muted-foreground">No sign-ins yet.</td></tr>
                )}
                {events.map((e) => {
                  const isCurrent = e.id === mostRecentId && e.user_agent && currentUa.startsWith((e.user_agent || "").slice(0, 30));
                  return (
                    <tr key={e.id} className="border-t">
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
                          <span title={new Date(e.created_at).toLocaleString()}>{timeAgo(e.created_at)}</span>
                        </div>
                      </td>
                      <td className="px-5 py-2.5">
                        <span>{parseBrowser(e.user_agent)}</span>
                        {parseOS(e.user_agent) && <span className="text-muted-foreground"> · {parseOS(e.user_agent)}</span>}
                      </td>
                      <td className="px-5 py-2.5 text-xs text-muted-foreground tabular-nums">{e.ip || "—"}</td>
                      <td className="px-5 py-2.5">{isCurrent && <Badge variant="secondary">Current session</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="p-5 space-y-3 border-destructive/30 shadow-soft">
          <h2 className="font-semibold text-destructive">Danger zone</h2>
          <p className="text-sm text-muted-foreground">Sign out of this device.</p>
          <Button variant="destructive" onClick={signOut}>Sign out</Button>
        </Card>
      </div>
    </PageShell>
  );
}
