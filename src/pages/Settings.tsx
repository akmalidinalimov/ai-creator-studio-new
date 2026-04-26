import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export default function Settings() {
  const { user, signOut } = useAuth();
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [goal, setGoal] = useState(5);
  const [pw, setPw] = useState("");

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase.from("profiles").select("name, timezone, weekly_goal_lessons").eq("id", user.id).maybeSingle();
      if (data) { setName(data.name || ""); setTimezone(data.timezone || "UTC"); setGoal(data.weekly_goal_lessons || 5); }
    })();
  }, [user]);

  const save = async () => {
    if (!user) return;
    const { error } = await supabase.from("profiles").update({ name, timezone, weekly_goal_lessons: goal }).eq("id", user.id);
    if (error) toast.error(error.message); else toast.success("Saved");
  };
  const updatePassword = async () => {
    if (pw.length < 6) { toast.error("Min 6 characters"); return; }
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) toast.error(error.message); else { toast.success("Password updated"); setPw(""); }
  };

  return (
    <PageShell>
      <div className="max-w-2xl space-y-6">
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <Card className="p-5 space-y-4 shadow-soft">
          <h2 className="font-semibold">Profile</h2>
          <div className="space-y-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Email</Label><Input value={user?.email || ""} disabled /></div>
          <div className="space-y-1.5"><Label>Timezone</Label><Input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Weekly study goal (lessons)</Label><Input type="number" value={goal} onChange={(e) => setGoal(parseInt(e.target.value) || 0)} /></div>
          <Button onClick={save}>Save profile</Button>
        </Card>
        <Card className="p-5 space-y-4 shadow-soft">
          <h2 className="font-semibold">Password</h2>
          <div className="space-y-1.5"><Label>New password</Label><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
          <Button onClick={updatePassword}>Update password</Button>
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
