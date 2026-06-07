import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageShell } from "@/components/Layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NudgesPanel } from "./AdminNudges";
import { ReengagementPanel } from "./AdminReengagement";

/**
 * Merged engagement hub: combines Smart reminders (nudges) and Reactivation
 * (re-engagement) into one page with tabs, replacing the two separate nav items.
 */
export default function AdminEngagement() {
  const [params, setParams] = useSearchParams();
  const initial = params.get("tab") === "reengagement" ? "reengagement" : "nudges";
  const [tab, setTab] = useState(initial);

  return (
    <PageShell>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">🔔 Faollik va eslatmalar</h1>
        <p className="text-sm text-muted-foreground">Smart eslatmalar va reaktivatsiya kampaniyalari bir joyda.</p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v);
          setParams(v === "reengagement" ? { tab: "reengagement" } : {}, { replace: true });
        }}
      >
        <TabsList>
          <TabsTrigger value="nudges">Smart eslatmalar</TabsTrigger>
          <TabsTrigger value="reengagement">Reaktivatsiya</TabsTrigger>
        </TabsList>
        <TabsContent value="nudges" className="mt-6">
          <NudgesPanel />
        </TabsContent>
        <TabsContent value="reengagement" className="mt-6">
          <ReengagementPanel />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
