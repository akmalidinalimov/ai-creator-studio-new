import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Github, Copy, ExternalLink, Server, Cloud, Globe } from "lucide-react";
import { toast } from "sonner";

const Code = ({ children }: { children: string }) => {
  const { t } = useTranslation();
  return (
    <div className="relative group">
      <pre className="bg-muted/40 border rounded-md p-3 text-xs overflow-x-auto leading-relaxed font-mono">{children}</pre>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="absolute top-1.5 right-1.5 h-7 w-7 opacity-0 group-hover:opacity-100"
        onClick={() => { navigator.clipboard.writeText(children); toast.success(t("admin.deploy.copied")); }}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
};

const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
  <div className="space-y-2">
    <div className="flex items-center gap-2">
      <span className="h-6 w-6 rounded-full bg-foreground text-background text-xs font-semibold flex items-center justify-center">{n}</span>
      <h4 className="font-medium">{title}</h4>
    </div>
    <div className="pl-8 space-y-2 text-sm text-muted-foreground">{children}</div>
  </div>
);

export default function AdminDeploy() {
  const { t } = useTranslation();
  const [tab, setTab] = useState("vps");
  return (
    <PageShell>
      <div className="space-y-6 max-w-5xl">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t("admin.deploy.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("admin.deploy.subtitle")}</p>
        </div>

        <Card className="p-6 shadow-soft space-y-3">
          <div className="flex items-start gap-3">
            <Github className="h-5 w-5 mt-0.5" />
            <div className="flex-1">
              <h3 className="font-semibold">{t("admin.deploy.step1Title")}</h3>
              <p className="text-sm text-muted-foreground mt-1">{t("admin.deploy.step1Desc")}</p>
            </div>
            <Button asChild variant="outline" size="sm"><a href="https://docs.lovable.dev/integrations/git-integration" target="_blank" rel="noreferrer">{t("admin.deploy.docs")} <ExternalLink className="h-3 w-3" /></a></Button>
          </div>
        </Card>

        <Card className="p-6 shadow-soft space-y-2">
          <h3 className="font-semibold">{t("admin.deploy.step2Title")}</h3>
          <p className="text-sm text-muted-foreground">{t("admin.deploy.step2Desc")}</p>
          <Code>{`VITE_SUPABASE_URL=${import.meta.env.VITE_SUPABASE_URL}\nVITE_SUPABASE_PUBLISHABLE_KEY=${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}\nVITE_SUPABASE_PROJECT_ID=${import.meta.env.VITE_SUPABASE_PROJECT_ID}`}</Code>
        </Card>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="vps"><Server className="h-3.5 w-3.5" />{t("admin.deploy.tabs.vps")}</TabsTrigger>
            <TabsTrigger value="vercel">{t("admin.deploy.tabs.vercel")}</TabsTrigger>
            <TabsTrigger value="netlify">{t("admin.deploy.tabs.netlify")}</TabsTrigger>
            <TabsTrigger value="cloudflare"><Cloud className="h-3.5 w-3.5" />{t("admin.deploy.tabs.cloudflare")}</TabsTrigger>
            <TabsTrigger value="static"><Globe className="h-3.5 w-3.5" />{t("admin.deploy.tabs.static")}</TabsTrigger>
          </TabsList>

          <TabsContent value="vps" className="space-y-5 mt-5">
            <Card className="p-6 shadow-soft space-y-5">
              <p className="text-sm">Recommended for 500+ students with full control. Use <strong>Coolify</strong> or <strong>Dokploy</strong> for one-click deploys, plus Cloudflare in front for global CDN + free SSL.</p>
              <Step n={1} title="Provision the VPS">
                <p>Buy a Hostinger KVM 2 (or larger) Ubuntu 22.04 VPS. SSH in as root.</p>
              </Step>
              <Step n={2} title="Install Coolify (or Dokploy)">
                <Code>{`curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`}</Code>
                <p>Visit <code>http://YOUR_VPS_IP:8000</code> and complete onboarding.</p>
              </Step>
              <Step n={3} title="Connect GitHub & deploy">
                <p>In Coolify: New Resource → Public Repository → paste your GitHub URL. Build pack: <strong>Static</strong>. Build command: <code>bun install &amp;&amp; bun run build</code>. Publish directory: <code>dist</code>.</p>
              </Step>
              <Step n={4} title="Add environment variables">
                <Code>{`VITE_SUPABASE_URL=...\nVITE_SUPABASE_PUBLISHABLE_KEY=...\nVITE_SUPABASE_PROJECT_ID=...`}</Code>
              </Step>
              <Step n={5} title="Point your domain">
                <p>In Cloudflare DNS: A record → your VPS IP. Enable proxy (orange cloud) for free CDN + SSL. In Coolify, add the domain to the app — it will auto-issue Let's Encrypt.</p>
              </Step>
              <Step n={6} title="Auto-deploy on push">
                <p>Coolify sets up a webhook on your GitHub repo automatically. Every <code>git push</code> rebuilds and redeploys.</p>
              </Step>
            </Card>
          </TabsContent>

          <TabsContent value="vercel" className="space-y-5 mt-5">
            <Card className="p-6 shadow-soft space-y-5">
              <Step n={1} title="Import the repo">
                <p>Go to <a href="https://vercel.com/new" target="_blank" rel="noreferrer" className="underline">vercel.com/new</a> → Import your GitHub repo.</p>
              </Step>
              <Step n={2} title="Build settings (auto-detected)">
                <Code>{`Framework: Vite\nBuild: bun run build\nOutput: dist`}</Code>
              </Step>
              <Step n={3} title="Add env vars">
                <Code>{`VITE_SUPABASE_URL\nVITE_SUPABASE_PUBLISHABLE_KEY\nVITE_SUPABASE_PROJECT_ID`}</Code>
              </Step>
              <Step n={4} title="Add custom domain">
                <p>Project → Settings → Domains. Auto SSL.</p>
              </Step>
            </Card>
          </TabsContent>

          <TabsContent value="netlify" className="space-y-5 mt-5">
            <Card className="p-6 shadow-soft space-y-5">
              <Step n={1} title="Import the repo">
                <p>Go to Netlify → "Add new site" → Import from GitHub.</p>
              </Step>
              <Step n={2} title="Build settings">
                <Code>{`Build command: bun run build\nPublish directory: dist`}</Code>
              </Step>
              <Step n={3} title="Add SPA fallback">
                <p>Create <code>public/_redirects</code>:</p>
                <Code>{`/*    /index.html   200`}</Code>
              </Step>
              <Step n={4} title="Add env vars + custom domain">
                <p>Site settings → Environment variables. Then Domains → add custom domain.</p>
              </Step>
            </Card>
          </TabsContent>

          <TabsContent value="cloudflare" className="space-y-5 mt-5">
            <Card className="p-6 shadow-soft space-y-5">
              <Step n={1} title="Connect repo to Cloudflare Pages">
                <p>Cloudflare dashboard → Workers &amp; Pages → Create → Pages → Connect to Git.</p>
              </Step>
              <Step n={2} title="Build configuration">
                <Code>{`Build command: bun run build\nOutput: dist`}</Code>
              </Step>
              <Step n={3} title="Env vars + domain">
                <p>Settings → Environment variables. Custom Domains tab for your domain.</p>
              </Step>
            </Card>
          </TabsContent>

          <TabsContent value="static" className="space-y-5 mt-5">
            <Card className="p-6 shadow-soft space-y-5">
              <Step n={1} title="Build locally">
                <Code>{`bun install\nbun run build`}</Code>
              </Step>
              <Step n={2} title="Serve with Caddy">
                <Code>{`# /etc/caddy/Caddyfile\nyourdomain.com {\n  root * /var/www/app/dist\n  try_files {path} /index.html\n  file_server\n  encode zstd gzip\n}`}</Code>
              </Step>
              <Step n={3} title="Or with nginx">
                <Code>{`server {\n  listen 80;\n  server_name yourdomain.com;\n  root /var/www/app/dist;\n  index index.html;\n  location / { try_files $uri /index.html; }\n  gzip on;\n}`}</Code>
              </Step>
            </Card>
          </TabsContent>
        </Tabs>

        <Card className="p-6 shadow-soft">
          <h3 className="font-semibold mb-2">{t("admin.deploy.scaling")}</h3>
          <p className="text-sm text-muted-foreground">{t("admin.deploy.scalingDesc")}</p>
        </Card>
      </div>
    </PageShell>
  );
}
